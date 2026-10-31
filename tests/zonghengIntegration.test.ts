import { migrateZonghengModelPrefix } from '../server/services/zonghengPrefixMigration';
import { ZONGHENG_VIDEO_MODELS } from '../shared/zonghengVideo';
import { V6K_SEEDANCE_20_MODEL, V6K_XX_SEEDANCE_20_MODEL } from '../shared/v6kSeedance2';
import { getModelSpecification, saveModelSpecification } from '../server/services/modelRoutingService';
import { resumeSpecificationTasks } from '../server/services/specificationGenerationService';
import { batchStore, tickVideoBatches } from '../server/services/videoBatchService';
import { V6K_TT25_PRODUCTS } from '../shared/v6kTt25';
import { ensureV6kTt25Models, v6kTt25SaleId } from '../server/services/v6kTt25Catalog';
import { quoteVideoRequest } from '../server/services/videoQuoteService';
import { PricingService } from '../server/services/pricingService';
import { TokenService } from '../server/services/tokenService';
import { ensureV6kTttModel } from '../server/services/v6kTttModel';
import { V6K_SYNC_UPSTREAM_MODELS } from '../shared/v6kSyncModels';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureH264Video } from '../server/services/videoCompatibilityService.js';

vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { getTableConfig, SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core');
  const schema = await import('../server/db/schema');
  const sqlite = new Database(':memory:');
  const dialect = new SQLiteSyncDialect();
  for (const table of Object.values(schema)) {
    const config = getTableConfig(table as any);
    const columns = config.columns.map(c => {
      let def = '';
      if (c.default !== undefined) {
        const value = typeof c.default === 'object' ? dialect.sqlToQuery(c.default as any).sql
          : typeof c.default === 'string' ? "'" + c.default.replace(/'/g, "''") + "'" : String(c.default);
        def = ' DEFAULT ' + value;
      }
      return '"' + c.name + '" ' + c.getSQLType() + (c.primary ? ' PRIMARY KEY' : c.isUnique ? ' UNIQUE' : '') + def;
    });
    sqlite.exec('CREATE TABLE "' + config.name + '" (' + columns.join(',') + ')');
  }
  return { sqlite, db: drizzle(sqlite, { schema }) };
});
vi.mock('../server/config/env.js', () => ({ env: { NODE_ENV: 'test', JWT_SECRET: 'test', VIDEO_TASK_POLL_TIMEOUT_MS: 1, PORT: 9876 } }));
vi.mock('../server/middleware/auth.js', () => ({ authMiddleware: (req: any, _res: any, next: any) => { req.userId = 1; next(); }, optionalAuthMiddleware: (_req: any, _res: any, next: any) => next() }));
vi.mock('../server/middleware/tier.js', () => ({ tierMiddleware: () => (_req: any, _res: any, next: any) => next() }));
vi.mock('../server/middleware/quota.js', () => ({ quotaMiddleware: (_req: any, _res: any, next: any) => next(), logUsage: vi.fn() }));
vi.mock('../server/services/tokenService.js', () => ({ TokenService: {
  validateToken: () => ({ valid: true, token: { id: 1, userId: 1, balance: -1, allowedModels: [], tokenKey: 'test' } }),
  deductBalance: vi.fn(), refundBalance: vi.fn(),
} }));
vi.mock('../server/services/balanceService.js', async () => {
  const { sqlite } = await import('../server/db/index.js');
  return { BalanceService: {
    getBalance: () => (sqlite.prepare('SELECT balance FROM users WHERE id=1').get()).balance,
    checkBalance: () => ({ sufficient: true, balance: 100 }),
    deductWithSource: (_id: number, amount: number) => {
      sqlite.prepare('UPDATE users SET balance=balance-? WHERE id=1').run(amount);
      return { source: 'user', balance: 100 - amount };
    },
    deduct: () => { throw new Error('Unexpected second deduction'); },
    refundToSource: (_id: number, amount: number) => { sqlite.prepare('UPDATE users SET balance=balance+? WHERE id=1').run(amount); },
  } };
});
vi.mock('../server/services/contentService.js', async () => {
  const { db } = await import('../server/db/index.js'); const { contents } = await import('../server/db/schema');
  return { ContentService: { save: (input: any) => Number(db.insert(contents).values({ ...input, metadata: JSON.stringify(input.metadata) }).run().lastInsertRowid) } };
});
vi.mock('../server/services/videoLocalizationService.js', () => ({ downloadAndLocalizeVideo: vi.fn(async () => '/uploads/videos/zongheng-test.mp4'), preferredVideoDownloadPath: (p: string) => p }));


import { db, sqlite } from '../server/db/index';
import { channels, models, modelPricing, users, contents } from '../server/db/schema';
import { ChannelService } from '../server/services/channelService';
import { findVideoSubmissionReceipt } from '../server/services/videoSubmissionReceiptService';
import { acceptVideoSubmission, claimVideoSubmission } from '../server/services/videoSubmissionGuard';
import { V6kVideoContentError } from '../server/services/v6kVideoContent';
import { confirmReviewedVideoFailureAndRefund } from '../server/services/zonghengSubmissionResolutionService';
import { VideoRecoveryService as ContentRecoveryService } from '../server/services/videoRecoveryService';
let video: typeof import('../server/routes/video');
let server: Server, origin: string;
const nativeFetch=globalThis.fetch, nativeSetTimeout=globalThis.setTimeout;
const intervalSpy=vi.spyOn(globalThis,'setInterval').mockImplementation(()=>({unref(){}}) as any);
const balance=()=>(sqlite.prepare('SELECT balance FROM users WHERE id=1').get() as any).balance;
const latest=()=>db.select().from(contents).all().at(-1)!;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8XcAAAAASUVORK5CYII=','base64');
let reference:string;
let upstream:(url:string,init:any)=>Promise<Response>;
beforeAll(async()=>{
  const sharp=(await import('sharp')).default;
  reference='data:image/png;base64,'+(await sharp({create:{width:300,height:300,channels:3,background:'#ffffff'}}).png().toBuffer()).toString('base64');
  video=await import('../server/routes/video');
  const v1=await import('../server/routes/v1'), image=await import('../server/routes/imageGen');
  const app=express(); app.use(express.json({limit:'5mb'}));app.use('/api/video',video.default);app.use('/api/image-gen',image.default);app.use('/v1',v1.default);
  server=await new Promise<Server>(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});origin='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  intervalSpy.mockRestore();
});
beforeEach(()=>{
  sqlite.exec('DROP TABLE IF EXISTS api_video_requests');
  sqlite.exec('DELETE FROM video_batch_commands; DELETE FROM video_batch_attempts; DELETE FROM video_batch_items; DELETE FROM video_batches');
  findVideoSubmissionReceipt(1); sqlite.exec('DELETE FROM video_submission_receipts');
  for(const table of ['contents','channels','models','model_pricing','users','api_tokens','api_logs','settings'])sqlite.exec('DELETE FROM '+table);
  sqlite.exec('DROP TABLE IF EXISTS billing_reservations');
  db.insert(users).values({id:1,email:'test',username:'test',passwordHash:'test',balance:100}).run();
  for(const [id,kind] of [['ZH-video-public','video'],['ZH-image-public','image'],['ZH-gpt-public','text']]){
    db.insert(models).values({modelId:id,displayName:id,provider:'zongheng',capabilities:JSON.stringify([kind])}).run();
    db.insert(modelPricing).values({modelPattern:id,billingType:kind==='text'?'per_token':'per_call',inputPrice:kind==='text'?1:2,outputPrice:2}).run();
  }
  ChannelService.createChannel({name:'纵横科技',type:'zongheng',baseUrl:'https://channel.invalid/v1/',apiKey:'test-key',
    supportedModels:['ZH-video-public','ZH-image-public','ZH-gpt-public'],
    modelMapping:{'ZH-video-public':'video-public','ZH-image-public':'image-public','ZH-gpt-public':'gpt-public'}});
  upstream=async()=>{throw Error('Unexpected upstream');};
  vi.stubGlobal('fetch',vi.fn((url,init)=>upstream(String(url),init||{})));
  vi.spyOn(globalThis,'setTimeout').mockImplementation(((fn:any,ms:number,...args:any[])=>nativeSetTimeout(fn,ms>=1000&&ms<=300000?5:ms,...args)) as any);
});
afterEach(()=>{
  for(const row of db.select().from(contents).all()){
    const meta=JSON.parse(row.metadata||'{}');
    for(const url of [row.resultUrl,...(meta.imageUrls||[])])if(typeof url==='string'&&url.includes('zongheng_')&&/\/(?:api\/)?uploads\//.test(url)){
      const file=path.resolve('data',new URL(url,'http://local.invalid').pathname.replace(/^\/(?:api\/)?/,''));
      if(file.startsWith(path.resolve('data/uploads')+path.sep)&&fs.existsSync(file))fs.unlinkSync(file);
    }
  }
  vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();
});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));sqlite.close();});
async function post(endpoint:string,body:any){return nativeFetch(origin+endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer test','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(body)});}
async function retryVideo(endpoint:string,body:any,key?:string){return nativeFetch(origin+endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer test',...(key===undefined?{}:{'Idempotency-Key':key})},body:JSON.stringify(body)});}
const request={model:'ZH-video-public',prompt:'产品视频',video_length:6,resolution:'720p',aspect_ratio:'16:9'};
function installConfirmedVideos() {
  const ids = ZONGHENG_VIDEO_MODELS.map(spec => 'ZH-' + spec.id);
  for (const id of ids) {
    db.insert(models).values({modelId:id,displayName:id,provider:'zongheng',capabilities:'["video"]'}).run();
    db.insert(modelPricing).values({modelPattern:id,billingType:'per_call',inputPrice:2}).run();
  }
  const channel=db.select().from(channels).get()!;
  ChannelService.updateChannel(channel.id,{supportedModels:ids,modelMapping:Object.fromEntries(ZONGHENG_VIDEO_MODELS.map(spec=>['ZH-'+spec.id,spec.id]))});
}
async function installSeedance20(allowed=['Asedanco2.05','XXsedanco2.0','Asedanco2.0']) {
  const c=db.select().from(channels).get()!;
  ChannelService.updateChannel(c.id,{type:'zongheng-v6k',baseUrl:'https://www.v6k.top',supportedModels:[],modelMapping:{}});
  upstream=async url=>{
    if(url.endsWith('/v1/models'))return Response.json({data:allowed.map(id=>({id}))});
    if(url.endsWith('/api/pricing'))return Response.json({data:['Asedanco2.0','Asedanco2.05','XXsedanco2.0'].map(model_name=>({model_name,supported_endpoint_types:['openai-video']}))});
    throw Error('Unexpected model discovery request');
  };
  const synced=await ChannelService.syncModels(c.id);
  for(const model of [V6K_SEEDANCE_20_MODEL,V6K_XX_SEEDANCE_20_MODEL]){
    db.update(models).set({isActive:1}).where(eq(models.modelId,model)).run();
    saveModelSpecification({...getModelSpecification(model)!,enabled:true});
  }
  sqlite.prepare("INSERT INTO api_tokens (id,user_id,token_key,balance) VALUES (1,1,'test',-1)").run();
  return synced;
}

describe('two Seedance 2.0 products through authenticated sync and actual entry points',()=>{
  it('resumes the original A task after a worker cycle without switching models or reserving twice',async()=>{
    await installSeedance20();let posts=0,queries=0,clock=Date.now();
    const time=vi.spyOn(Date,'now').mockImplementation(()=>clock);
    upstream=async(url,init)=>{
      if(init.method==='POST'){posts++;return Response.json({id:'a_resume_original',status:'queued'});}
      expect(url).toBe('https://www.v6k.top/v1/videos/a_resume_original');
      expect(JSON.parse(latest().metadata)).toMatchObject({videoId:'a_resume_original',upstreamModel:'Asedanco2.0'});
      if(++queries===1){clock+=2*60*60_000+1;return Response.json({id:'a_resume_original',status:'unknown'});}
      return Response.json({id:'a_resume_original',status:'completed'});
    };
    try{
      await(await post('/api/video/generate',{model:V6K_SEEDANCE_20_MODEL,prompt:'场景',seconds:15,resolution:'720p'})).text();
      expect(latest().status).toBe('processing');expect(balance()).toBe(96);
      expect(JSON.parse(latest().metadata)).toMatchObject({upstreamStatus:'unknown',progressKnown:false});
      clock+=120_000;resumeSpecificationTasks();resumeSpecificationTasks();
      await vi.waitFor(()=>expect(latest().status).toBe('completed'));
      expect(posts).toBe(1);expect(queries).toBe(2);expect(balance()).toBe(96);expect(latest().cost).toBe(4);
    }finally{time.mockRestore();}
  });
  it.each([V6K_SEEDANCE_20_MODEL,V6K_XX_SEEDANCE_20_MODEL])('uses the persistent batch bridge and original prepayment for %s',async model=>{
    await installSeedance20();let posts=0;
    const batchId=batchStore.create(1,crypto.randomUUID(),{name:'Seedance batch',model,resolution:'720p',aspect_ratio:'16:9',video_length:15,
      autoRetry:false,maxRetries:0,creatives:[{prompt:'批量场景',count:1,reference_images:[]}]},4,'https://app.example');
    const item=batchStore.detail(batchId,1).items[0];
    upstream=async(url,init)=>{
      if(url==='http://127.0.0.1:9876/api/video/generate')return nativeFetch(origin+'/api/video/generate',init);
      posts++;expect(url).toBe('https://www.v6k.top/v1/videos');
      expect(JSON.parse(init.body)).toMatchObject({model:model===V6K_SEEDANCE_20_MODEL?'Asedanco2.0':'XXsedanco2.0',seconds:15,resolution:'720p'});
      expect(balance()).toBe(96);return Response.json({id:'batch_seedance',status:'completed'});
    };
    tickVideoBatches();
    await vi.waitFor(()=>expect(latest()?.status).toBe('completed'));
    tickVideoBatches();tickVideoBatches();resumeSpecificationTasks();
    expect(batchStore.item(item.id)).toMatchObject({status:'completed',billing_state:'charged'});
    expect(latest().cost).toBe(4);expect(balance()).toBe(96);expect(posts).toBe(1);
  });
  it('groups the A models, imports XX separately, and never imports permission from the public square',async()=>{
    const synced=await installSeedance20(['Asedanco2.05']);
    expect(synced.models).toEqual([V6K_SEEDANCE_20_MODEL]);
    expect(getModelSpecification(V6K_SEEDANCE_20_MODEL)!.routes.map(r=>r.upstreamModel)).toEqual(['Asedanco2.05']);
    expect(getModelSpecification(V6K_XX_SEEDANCE_20_MODEL)!.routes).toEqual([]);
    const c=db.select().from(channels).get()!;
    expect(JSON.parse(c.supportedModels)).toEqual([V6K_SEEDANCE_20_MODEL]);
    expect(JSON.parse(c.modelMapping)).toEqual({[V6K_SEEDANCE_20_MODEL]:'Asedanco2.05'});
  });
  it.each(['/api/video/generate','/v1/videos'])('publishes two 4-yuan entries and sends exact supported media without splitting at %s',async endpoint=>{
    const synced=await installSeedance20();
    expect(new Set(synced.models)).toEqual(new Set([V6K_SEEDANCE_20_MODEL,V6K_XX_SEEDANCE_20_MODEL]));
    const catalog=await(await nativeFetch(origin+'/api/video/models')).json() as any[];
    for(const model of [V6K_SEEDANCE_20_MODEL,V6K_XX_SEEDANCE_20_MODEL])expect(catalog.find(m=>m.id===model)).toMatchObject({billingType:'per_call',rates:{'720p':4},available:true});
    expect(catalog.some(m=>['ZH-Asedanco2.0','ZH-Asedanco2.05','ZH-XXsedanco2.0'].includes(m.id))).toBe(false);
    const sent:any[]=[];
    upstream=async(url,init)=>{
      expect(url).toBe('https://www.v6k.top/v1/videos');expect(init.method).toBe('POST');
      sent.push(JSON.parse(init.body));return Response.json({id:'seedance_'+sent.length,status:'completed'});
    };
    for(const model of [V6K_SEEDANCE_20_MODEL,V6K_XX_SEEDANCE_20_MODEL]){
      const videos=model===V6K_SEEDANCE_20_MODEL?['https://media.example/ref.mp4']:[];
      for(const seconds of [5,15]){
        await(await post(endpoint,{model,prompt:'场景',seconds,resolution:'720p',reference_videos:videos,audio_urls:['https://media.example/a.mp3']})).text();
        await vi.waitFor(()=>expect(latest().status).toBe('completed'));
        expect(latest().modelId).toBe(model);expect(latest().cost).toBe(4);
        expect(sent.at(-1)).toEqual({model:model===V6K_SEEDANCE_20_MODEL?'Asedanco2.0':'XXsedanco2.0',prompt:'场景',seconds,ratio:'16:9',resolution:'720p',audios:['https://media.example/a.mp3'],...(videos.length?{videos}: {})});
      }
    }
    resumeSpecificationTasks();resumeSpecificationTasks();expect(sent).toHaveLength(4);expect(balance()).toBe(84);
  });
  it.each(['/api/video/generate','/v1/videos'])('rejects XX reference videos and unsupported input before creating orders or charging at %s',async endpoint=>{
    await installSeedance20();upstream=async()=>{throw Error('Must not submit rejected inputs');};
    for(const invalid of [{reference_videos:['https://media.example/v.mp4']},{audio_urls:Array(4).fill('https://media.example/a.mp3')},{reference_images:Array(10).fill(reference)},{seconds:16},{resolution:'480p'}]){
      const reply=await(await post(endpoint,{model:V6K_XX_SEEDANCE_20_MODEL,prompt:'场景',seconds:15,resolution:'720p',...invalid})).text();
      expect(reply).not.toContain('content_id');
      expect(db.select().from(contents).all()).toHaveLength(0);expect(balance()).toBe(100);
    }
  });
  it.each(['rate-limit','rejected','unknown-no-id','receipt-failed'])('keeps original receipts and a single reservation across A routes: %s',async outcome=>{
    await installSeedance20();let posts=0,queries=0;
    upstream=async(url,init)=>{
      if(init.method==='POST'){
        posts++;const payload=JSON.parse(init.body);
        expect(payload.model).toBe(outcome==='rate-limit'&&posts===2?'Asedanco2.05':'Asedanco2.0');
        expect(balance()).toBe(96);
        if(outcome==='rate-limit'&&posts===1)return Response.json({error:{code:'rate_limit_exceeded',message:'too many requests'}},{status:429});
        if(outcome==='rejected')return Response.json({error:{code:'invalid_request',message:'duration rejected'}},{status:400});
        if(outcome==='unknown-no-id')return new Response('<html>gateway timeout</html>',{status:504});
        return Response.json({id:'a_original',status:outcome==='receipt-failed'?'unknown':'completed'}, {status:outcome==='receipt-failed'?503:200});
      }
      queries++;expect(url).toBe('https://www.v6k.top/v1/videos/a_original');
      expect(JSON.parse(latest().metadata).videoId).toBe('a_original');
      expect(findVideoSubmissionReceipt(latest().id)?.upstreamTaskId).toBe('a_original');
      return Response.json({id:'a_original',status:'failed',error:{code:'video_generation_failed',message:'original task failed'}});
    };
    await(await post('/api/video/generate',{model:V6K_SEEDANCE_20_MODEL,prompt:'场景',seconds:15,resolution:'720p'})).text();
    await vi.waitFor(()=>expect(latest().status).toBe(outcome==='rate-limit'?'completed':outcome==='unknown-no-id'?'processing':'failed'));
    resumeSpecificationTasks();resumeSpecificationTasks();
    expect(posts).toBe(outcome==='rate-limit'?2:1);expect(queries).toBe(outcome==='receipt-failed'?1:0);
    expect(balance()).toBe(outcome==='rejected'||outcome==='receipt-failed'?100:96);
    expect(latest().cost).toBe(outcome==='rate-limit'?4:outcome==='unknown-no-id'?4:0);
    const meta=JSON.parse(latest().metadata);
    expect(sqlite.prepare('SELECT state FROM billing_reservations WHERE id=?').get(meta.billingReservationId)).toMatchObject({state:outcome==='rate-limit'?'settled':outcome==='unknown-no-id'?'review':'refunded'});
  });
});

async function installTt25(legacy=false,allowed=V6K_TT25_PRODUCTS.map(p=>String(p.id))) {
  if(legacy)for(const p of V6K_TT25_PRODUCTS){
    db.insert(models).values({modelId:'ZH-'+p.id,displayName:'custom '+p.resolution,provider:'zongheng-v6k',capabilities:'["video"]',isActive:1}).run();
    db.insert(modelPricing).values({modelPattern:'ZH-'+p.id,billingType:'per_second',inputPrice:p.saleRate,extraParams:JSON.stringify({[p.resolution.toUpperCase()]:p.saleRate})}).run();
  }
  const c=db.select().from(channels).get()!;
  ChannelService.updateChannel(c.id,{type:'zongheng-v6k',baseUrl:'https://www.v6k.top'});
  upstream=async url=>{
    if(url.endsWith('/v1/models'))return Response.json({data:allowed.map(id=>({id}))});
    if(url.endsWith('/api/pricing'))return Response.json({data:V6K_TT25_PRODUCTS.map(p=>({model_name:p.id,supported_endpoint_types:['openai-video']}))});
    throw Error('Unexpected TT model discovery request');
  };
  const synced=await ChannelService.syncModels(c.id);
  for(const p of V6K_TT25_PRODUCTS){const id=v6kTt25SaleId(sqlite,p.id);
    db.update(models).set({isActive:1}).where(eq(models.modelId,id)).run();
    saveModelSpecification({...getModelSpecification(id)!,enabled:true});
  }
  sqlite.prepare("INSERT INTO api_tokens (id,user_id,token_key,balance) VALUES (1,1,'test',-1)").run();
  return synced;
}

describe('TT 2.5 native resolutions and per-second prices through actual entry points',()=>{
  it('finishes an already accepted legacy direct task at its original 6.5 price while the new second rates are applied',async()=>{
    const id='ZH-TTseadanco2.5-480',c=db.select().from(channels).get()!;
    db.insert(models).values({modelId:id,displayName:id,provider:'zongheng-v6k',capabilities:'["video"]',isActive:1}).run();
    db.insert(modelPricing).values({modelPattern:id,billingType:'per_call',inputPrice:6.5}).run();
    ChannelService.updateChannel(c.id,{type:'zongheng-v6k',baseUrl:'https://www.v6k.top',supportedModels:[id],modelMapping:{[id]:'TTseadanco2.5-480'}});
    let posts=0,queries=0;
    upstream=async(url,init)=>{if(init.method==='POST'){posts++;return Response.json({id:'legacy_price_original',status:'queued'});}
      queries++;expect(url).toBe('https://www.v6k.top/v1/videos/legacy_price_original');
      expect(JSON.parse(latest().metadata).videoId).toBe('legacy_price_original');
      sqlite.prepare('UPDATE model_pricing SET billing_type=?,input_price=?,extra_params=? WHERE model_pattern=?').run('per_second',.28,'{}',id);
      ensureV6kTt25Models(sqlite);
      expect(sqlite.prepare('SELECT billing_type,input_price FROM model_pricing WHERE model_pattern=?').get(id)).toEqual({billing_type:'per_second',input_price:.28});
      return Response.json({id:'legacy_price_original',status:'completed'});};
    await(await post('/api/video/generate',{model:id,prompt:'原任务',seconds:30,resolution:'480p'})).text();
    await vi.waitFor(()=>expect(latest().status).toBe('completed'));
    expect(latest().cost).toBe(6.5);expect(balance()).toBe(93.5);expect(posts).toBe(1);expect(queries).toBe(1);
    expect(JSON.parse(latest().metadata).pricingSnapshot).toMatchObject({billingType:'per_call',inputPrice:6.5});
  });
  it('does not import unauthorized TT routes from the public catalog',async()=>{
    const synced=await installTt25(false,['TTseadanco2.5-480']);
    expect(synced.models).toEqual(['TTseadanco2.5-480']);
    expect(getModelSpecification('TTseadanco2.5-480')!.routes).toHaveLength(1);
    expect(getModelSpecification('TTseadanco2.5-720')!.routes).toEqual([]);
    expect(getModelSpecification('TTseadanco2.5-1080')!.routes).toEqual([]);
  });
  it.each([['/api/video/generate',false],['/v1/videos',false],['/api/video/generate',true],['/v1/videos',true]] as const)('quotes and charges exactly seconds times the requested rate at %s (legacy IDs: %s)',async(endpoint,legacy)=>{
    const synced=await installTt25(legacy),prefix=legacy?'ZH-':'';
    expect(new Set(synced.models)).toEqual(new Set(V6K_TT25_PRODUCTS.map(p=>prefix+p.id)));
    const catalog=await(await nativeFetch(origin+'/api/video/models')).json() as any[];
    for(const p of V6K_TT25_PRODUCTS)expect(catalog.find(m=>m.id===prefix+p.id)).toMatchObject({billingType:'per_second',rates:{[p.resolution]:p.saleRate},available:true,routingLimits:{maxImages:30,maxVideos:10,maxAudios:10,resolutions:[p.resolution]}});
    let posts=0,expected:any;
    upstream=async(url,init)=>{posts++;expect(url).toBe('https://www.v6k.top/v1/videos');expect(init.method).toBe('POST');
      const body=JSON.parse(init.body);expect(body).toMatchObject(expected);expect(body.videos).toHaveLength(10);expect(body.audios).toHaveLength(10);
      return Response.json({id:'tt25_'+posts,status:'completed'});};
    for(const p of V6K_TT25_PRODUCTS)for(const seconds of [5,30]){
      const cost=Number((p.saleRate*seconds).toFixed(6));expected={model:p.id,resolution:p.resolution,seconds};
      expect(quoteVideoRequest({model:prefix+p.id,resolution:p.resolution,seconds},1)).toMatchObject({cost,rate:p.saleRate,billingType:'per_second'});
      await(await post(endpoint,{model:prefix+p.id,prompt:'TT场景',seconds,resolution:p.resolution,expectedCost:cost,
        reference_videos:Array.from({length:10},(_,i)=>'https://media.example/v'+i+'.mp4'),audio_urls:Array.from({length:10},(_,i)=>'https://media.example/a'+i+'.mp3')})).text();
      await vi.waitFor(()=>expect(latest().status).toBe('completed'));
      expect(latest().cost).toBe(cost);expect(JSON.parse(latest().metadata)).toMatchObject({upstreamModel:p.id,resolution:p.resolution,pricingSnapshot:{billingType:'per_second',inputPrice:p.saleRate}});
    }
    resumeSpecificationTasks();resumeSpecificationTasks();expect(posts).toBe(6);expect(balance()).toBeCloseTo(44.7,6);
  });
  it.each(V6K_TT25_PRODUCTS)('rejects wrong $resolution specifications and oversize material before reserving money',async p=>{
    await installTt25();let posts=0;upstream=async()=>{posts++;throw Error('Invalid TT request must not be submitted');};
    for(const invalid of [{seconds:4},{seconds:31},{resolution:p.resolution==='720p'?'480p':'720p'},
      {reference_images:Array(31).fill(reference)},{reference_videos:Array(11).fill('https://media.example/v.mp4')},{audio_urls:Array(11).fill('https://media.example/a.mp3')}]){
      const response=await post('/api/video/generate',{model:p.id,prompt:'场景',seconds:30,resolution:p.resolution,...invalid});
      expect(response.status).toBeGreaterThanOrEqual(400);await response.text();
      expect(db.select().from(contents).all()).toHaveLength(0);expect(balance()).toBe(100);
    }
    expect(posts).toBe(0);
  });
  it.each(V6K_TT25_PRODUCTS.flatMap(p=>['rejected','failed','uncertain'].map(outcome=>({p,outcome}))))('settles or retains only the original TT prepayment: $p.id / $outcome',async({p,outcome})=>{
    await installTt25();let posts=0,queries=0;const cost=Number((p.saleRate*10).toFixed(6));
    upstream=async(url,init)=>{
      if(init.method==='POST'){posts++;expect(balance()).toBeCloseTo(100-cost,6);
        if(outcome==='rejected')return Response.json({error:{code:'invalid_request',message:'confirmed invalid input'}},{status:400});
        if(outcome==='uncertain')return new Response('<html>gateway timeout</html>',{status:504});
        return Response.json({id:'tt_original',status:'unknown'},{status:503});}
      queries++;expect(url).toBe('https://www.v6k.top/v1/videos/tt_original');
      expect(findVideoSubmissionReceipt(latest().id)?.upstreamTaskId).toBe('tt_original');
      return Response.json({id:'tt_original',status:'failed',error:{code:'video_generation_failed',message:'confirmed original failure'}});
    };
    await(await post('/api/video/generate',{model:p.id,prompt:'场景',seconds:10,resolution:p.resolution})).text();
    await vi.waitFor(()=>expect(latest().status).toBe(outcome==='uncertain'?'processing':'failed'));
    resumeSpecificationTasks();resumeSpecificationTasks();expect(posts).toBe(1);expect(queries).toBe(outcome==='failed'?1:0);
    expect(balance()).toBeCloseTo(outcome==='uncertain'?100-cost:100,6);
    const meta=JSON.parse(latest().metadata);expect(sqlite.prepare('SELECT state FROM billing_reservations WHERE id=?').get(meta.billingReservationId)).toMatchObject({state:outcome==='uncertain'?'review':'refunded'});
  });
  it('uses the captured TT price when an administrator changes future prices while the original task is generating',async()=>{
    await installTt25(true);const id='ZH-TTseadanco2.5-480';let posts=0,queries=0;
    upstream=async(_url,init)=>{if(init.method==='POST'){posts++;return Response.json({id:'priced_original',status:'queued'});}queries++;
      sqlite.prepare('UPDATE model_pricing SET input_price=99,extra_params=? WHERE model_pattern=?').run('{"480p":99}',id);
      return Response.json({id:'priced_original',status:'completed'});};
    await(await post('/api/video/generate',{model:id,prompt:'场景',seconds:30,resolution:'480p'})).text();
    await vi.waitFor(()=>expect(latest().status).toBe('completed'));
    resumeSpecificationTasks();expect(posts).toBe(1);expect(queries).toBe(1);expect(latest().cost).toBe(8.4);expect(balance()).toBeCloseTo(91.6,6);
    expect(JSON.parse(latest().metadata).pricingSnapshot).toMatchObject({billingType:'per_second',inputPrice:.28});
  });
  it.each(V6K_TT25_PRODUCTS)('uses the real batch bridge and one per-second reservation for $id',async p=>{
    await installTt25();const cost=Number((p.saleRate*30).toFixed(6));let posts=0;
    const snapshot=PricingService.quote(p.id,{resolution:p.resolution,seconds:30,count:1},false,1).pricingSnapshot;
    const batchId=batchStore.create(1,crypto.randomUUID(),{name:'TT batch',model:p.id,resolution:p.resolution,aspect_ratio:'16:9',video_length:30,autoRetry:false,maxRetries:0,creatives:[{prompt:'TT批量',count:1,reference_images:[]}]},cost,'https://app.example',snapshot);
    const item=batchStore.detail(batchId,1).items[0];
    upstream=async(url,init)=>{if(url==='http://127.0.0.1:9876/api/video/generate')return nativeFetch(origin+'/api/video/generate',init);
      posts++;expect(JSON.parse(init.body)).toMatchObject({model:p.id,resolution:p.resolution,seconds:30});expect(balance()).toBeCloseTo(100-cost,6);return Response.json({id:'tt_batch_original',status:'completed'});};
    tickVideoBatches();await vi.waitFor(()=>expect(latest()?.status).toBe('completed'));tickVideoBatches();tickVideoBatches();resumeSpecificationTasks();
    expect(batchStore.item(item.id)).toMatchObject({status:'completed',billing_state:'charged',charged:cost});expect(posts).toBe(1);expect(balance()).toBeCloseTo(100-cost,6);expect(latest().cost).toBe(cost);
  });
});

async function syncV6kEntries(entries:any[]) {
  const c=db.select().from(channels).get()!;
  if(c.type!=='zongheng-v6k'||c.baseUrl!=='https://www.v6k.top')ChannelService.updateChannel(c.id,{type:'zongheng-v6k',baseUrl:'https://www.v6k.top'});
  upstream=async(url,init)=>{expect(url).toBe('https://www.v6k.top/v1/models');expect(init.method).not.toBe('POST');return Response.json({data:entries});};
  return ChannelService.syncModels(c.id);
}
function syncConfiguration() {
  const c=db.select().from(channels).get()!;
  return {models:db.select().from(models).all(),prices:db.select().from(modelPricing).all(),
    supported:c.supportedModels,mapping:c.modelMapping,status:c.status,
    specifications:sqlite.prepare('SELECT value FROM settings WHERE key=?').get('model_specification_routes_v1'),
    tasks:db.select().from(contents).all(),users:db.select().from(users).all()};
}

describe('V6K explicitly requested model sync allowlist',()=>{
  it('imports only seven approved upstream IDs as six entries and never expands scope from video metadata or similar names',async()=>{
    ensureV6kTttModel(sqlite);
    const unrelated=['TTseadanco2.5-720YT','XXsedanco2.0S','dola2.0','grok--1.5','QQsedanco2.5/720','KKseadanco2.5X','Asedanco2.0-extra','ttseadanco2.5-480','brand-new-video'];
    const result=await syncV6kEntries([...V6K_SYNC_UPSTREAM_MODELS.map(id=>({id})),...unrelated.map(id=>({id,type:'video',supported_endpoint_types:['openai-video']})),{id:'Asedanco2.0'}]);
    const expected=['TTTseadanco2.5/720',V6K_SEEDANCE_20_MODEL,V6K_XX_SEEDANCE_20_MODEL,...V6K_TT25_PRODUCTS.map(p=>p.id)];
    expect(result.count).toBe(6);expect(new Set(result.models)).toEqual(new Set(expected));
    expect(db.select().from(models).all().filter(m=>expected.includes(m.modelId))).toHaveLength(6);
    expect(db.select().from(models).all().filter(m=>unrelated.some(id=>m.modelId===id||m.modelId==='ZH-'+id))).toEqual([]);
    expect(expected.every(id=>db.select().from(models).all().find(m=>m.modelId===id)!.isActive===0)).toBe(true);
    const channel=db.select().from(channels).get()!;
    expect(JSON.parse(channel.supportedModels)).toEqual(expect.arrayContaining(['ZH-video-public','ZH-image-public','ZH-gpt-public',...expected]));
    expect(JSON.parse(channel.modelMapping)).toMatchObject({'ZH-video-public':'video-public','ZH-image-public':'image-public','ZH-gpt-public':'gpt-public'});
    expect(result.warnings?.join('')).toContain('其他型号 9 个');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(db.select().from(contents).all()).toEqual([]);expect(balance()).toBe(100);
  });
  it('preserves existing prices, names, switches, mappings, route objects and legacy non-whitelisted models across full and partial repeated syncs',async()=>{
    ensureV6kTttModel(sqlite);await syncV6kEntries([...V6K_SYNC_UPSTREAM_MODELS]);
    db.update(models).set({displayName:'administrator name',description:'administrator description',isActive:1}).run();
    db.update(models).set({isActive:0}).where(eq(models.modelId,V6K_XX_SEEDANCE_20_MODEL)).run();
    db.update(modelPricing).set({billingType:'per_call',inputPrice:7.77,outputPrice:3.33,extraParams:'{"720P":8.88,"category":"video"}'}).run();
    sqlite.prepare('DELETE FROM settings WHERE key=?').run('v6k_tt25_requested_second_prices_v1');
    const row=sqlite.prepare('SELECT value FROM settings WHERE key=?').get('model_specification_routes_v1') as any;
    const specs=JSON.parse(row.value);for(const spec of specs){spec.enabled=spec.modelId!==V6K_SEEDANCE_20_MODEL;for(const route of spec.routes){route.enabled=false;route.cost=42;route.priority=7;}}
    sqlite.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(specs),'model_specification_routes_v1');
    const c=db.select().from(channels).get()!;
    ChannelService.updateChannel(c.id,{status:0,modelMapping:{...JSON.parse(c.modelMapping),[V6K_SEEDANCE_20_MODEL]:'Asedanco2.05'}});
    db.insert(contents).values({userId:1,type:'video',modelId:'ZH-video-public',cost:2,status:'processing',metadata:'{"videoId":"unrelated_original","pricingSnapshot":{"inputPrice":2},"billingStatus":"reserved"}'}).run();
    const before=syncConfiguration();
    await syncV6kEntries([...V6K_SYNC_UPSTREAM_MODELS,'another-new-video']);
    expect(syncConfiguration()).toEqual(before);
    await syncV6kEntries(['Asedanco2.0','XXsedanco2.0','another-new-video']);
    expect(syncConfiguration()).toEqual(before);
    expect(db.select().from(models).all().some(m=>m.modelId==='ZH-another-new-video')).toBe(false);
  });
  it.each(['empty','only-other','http-error','invalid-list','invalid-json'])('makes no configuration or money changes when discovery is %s',async mode=>{
    const c=db.select().from(channels).get()!;ChannelService.updateChannel(c.id,{type:'zongheng-v6k',baseUrl:'https://www.v6k.top'});
    const before=syncConfiguration();
    upstream=async()=>mode==='http-error'?Response.json({error:{message:'denied'}},{status:403}):mode==='invalid-list'?Response.json({data:{}}):mode==='invalid-json'?new Response('<html>gateway</html>'):Response.json({data:mode==='empty'?[]:[{id:'brand-new-video',type:'video'}]});
    if(mode==='empty'||mode==='only-other')expect(await ChannelService.syncModels(c.id)).toMatchObject({count:0,added:0,models:[]});
    else await expect(ChannelService.syncModels(c.id)).rejects.toBeDefined();
    expect(syncConfiguration()).toEqual(before);expect(balance()).toBe(100);
  });
  it('does not apply stale discovery after an administrator replaces the channel key',async()=>{
    const c=db.select().from(channels).get()!;ChannelService.updateChannel(c.id,{type:'zongheng-v6k',baseUrl:'https://www.v6k.top'});
    const before=syncConfiguration();
    upstream=async()=>{ChannelService.updateChannel(c.id,{apiKey:'replacement-test-key'});return Response.json({data:V6K_SYNC_UPSTREAM_MODELS.map(id=>({id}))});};
    await expect(ChannelService.syncModels(c.id)).rejects.toMatchObject({status:409});
    expect(syncConfiguration()).toEqual(before);expect(db.select().from(channels).get()!.apiKey).toBe('replacement-test-key');
  });
  it.each(['/api/video/generate','/v1/videos'])('keeps an accepted original and reserved funds recoverable when A disappears from discovery at %s',async endpoint=>{
    await installSeedance20();const c=db.select().from(channels).get()!;let posts=0,queries=0,clock=Date.now();
    const time=vi.spyOn(Date,'now').mockImplementation(()=>clock);
    upstream=async(url,init)=>{
      if(init.method==='POST'){posts++;return Response.json({id:'allowlist_original',status:'queued'});}
      expect(url).toBe('https://www.v6k.top/v1/videos/allowlist_original');queries++;clock+=2*60*60_000+1;
      return Response.json({id:'allowlist_original',status:'unknown'});
    };
    try{
      await(await post(endpoint,{model:V6K_SEEDANCE_20_MODEL,prompt:'原任务',seconds:15,resolution:'720p'})).text();
      await vi.waitFor(()=>expect(Number(JSON.parse(latest().metadata).v6kQueryResumeAt)).toBeGreaterThan(clock));
      const original=latest(),meta=JSON.parse(original.metadata),receipt=findVideoSubmissionReceipt(original.id),reservation=sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(meta.billingReservationId),before=syncConfiguration();
      upstream=async(url,init)=>{
        if(url.endsWith('/v1/models'))return Response.json({data:[{id:'XXsedanco2.0'},{id:'brand-new-video',type:'video'}]});
        expect(init.method).not.toBe('POST');queries++;expect(url).toBe('https://www.v6k.top/v1/videos/allowlist_original');return Response.json({id:'allowlist_original',status:'completed'});
      };
      await ChannelService.syncModels(c.id);
      expect(syncConfiguration()).toEqual(before);expect(findVideoSubmissionReceipt(original.id)).toEqual(receipt);
      expect(sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(meta.billingReservationId)).toEqual(reservation);
      clock+=120_000;resumeSpecificationTasks();resumeSpecificationTasks();
      await vi.waitFor(()=>expect(latest().status).toBe('completed'));
      expect(latest().cost).toBe(4);expect(balance()).toBe(96);expect(posts).toBe(1);expect(queries).toBe(2);
    }finally{time.mockRestore();}
  });
  it('keeps a prepaid queued batch eligible and charges once after a partial sync',async()=>{
    await installSeedance20();const c=db.select().from(channels).get()!;let posts=0;
    const batchId=batchStore.create(1,crypto.randomUUID(),{name:'queued before sync',model:V6K_SEEDANCE_20_MODEL,resolution:'720p',aspect_ratio:'16:9',video_length:15,autoRetry:false,maxRetries:0,creatives:[{prompt:'原批次',count:1,reference_images:[]}]},4,'https://app.example');
    const item=batchStore.item(batchStore.detail(batchId,1).items[0].id),before=syncConfiguration();
    upstream=async()=>Response.json({data:[{id:'XXsedanco2.0'},{id:'unrequested-model',type:'video'}]});
    await ChannelService.syncModels(c.id);expect(syncConfiguration()).toEqual(before);expect(batchStore.item(item.id)).toEqual(item);
    upstream=async(url,init)=>{if(url==='http://127.0.0.1:9876/api/video/generate')return nativeFetch(origin+'/api/video/generate',init);
      posts++;expect(JSON.parse(init.body).model).toBe('Asedanco2.0');return Response.json({id:'queued_batch_original',status:'completed'});};
    tickVideoBatches();await vi.waitFor(()=>expect(latest()?.status).toBe('completed'));tickVideoBatches();tickVideoBatches();
    expect(batchStore.item(item.id)).toMatchObject({status:'completed',billing_state:'charged',charged:4});expect(balance()).toBe(96);expect(posts).toBe(1);
  });
});

describe('API request retry protection before order creation and charging',()=>{
  it.each(V6K_TT25_PRODUCTS.flatMap(p=>['completed','failed','uncertain'].map(outcome=>({p,outcome}))))('returns the original $p.id task and settles once after $outcome',async({p,outcome})=>{
    await installTt25(true);let posts=0;
    upstream=async(_url,init)=>{if(init.method==='POST'){posts++;if(outcome==='uncertain')return new Response('<html>gateway timeout</html>',{status:504});return Response.json({id:'retry_original',status:outcome,error:outcome==='failed'?{code:'video_generation_failed',message:'original generation failed'}:undefined});}throw Error('must not create a second poller');};
    const body={model:'ZH-'+p.id,prompt:'相同订单重试',seconds:10,resolution:p.resolution},key='stable-api-retry';
    const first=await(await retryVideo('/v1/videos',body,key)).json() as any;
    expect(first.id).toMatch(/^task_req_[a-f0-9]{32}$/);
    await vi.waitFor(()=>expect(latest().status).toBe(outcome==='uncertain'?'processing':outcome));
    const replies=await Promise.all(['/v1/videos','/v1/videos/generations','/v1/video/generations'].map(async endpoint=>{
      const response=await retryVideo(endpoint,body,key);expect(response.headers.get('x-idempotency-replayed')).toBe('true');return response.json() as any;
    }));
    for(const reply of replies){expect(reply.id).toBe(first.id);expect(reply.task_id).toBe(first.id);expect(reply.status_url).toBe(origin+'/v1/videos/'+first.id);}
    expect(db.select().from(contents).all()).toHaveLength(1);expect(posts).toBe(1);
    const cost=Number((p.saleRate*10).toFixed(6)),meta=JSON.parse(latest().metadata);
    expect(balance()).toBeCloseTo(outcome==='failed'?100:100-cost,6);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM billing_reservations').get()).toEqual({n:1});
    expect(sqlite.prepare('SELECT state FROM billing_reservations WHERE id=?').get(meta.billingReservationId)).toMatchObject({state:outcome==='completed'?'settled':outcome==='failed'?'refunded':'review'});
    resumeSpecificationTasks();resumeSpecificationTasks();expect(posts).toBe(1);
    if(outcome==='completed')expect(replies[0].url).toBe(origin+'/v1/videos/'+first.id+'/content');
  });
  it('deduplicates concurrent headerless JSON retries and ignores key order while allowing an explicit new task',async()=>{
    const p=V6K_TT25_PRODUCTS[0];await installTt25();let posts=0;
    upstream=async()=>{posts++;return Response.json({id:'concurrent_'+posts,status:'completed'});};
    const body={model:p.id,prompt:'并发无键重试',seconds:5,resolution:p.resolution};
    const replies=await Promise.all(Array.from({length:8},async(_,i)=>(await retryVideo(i%2?'/v1/videos/generations':'/v1/videos',i%2?{resolution:p.resolution,seconds:5,prompt:body.prompt,model:p.id}:body)).json() as any));
    expect(new Set(replies.map(x=>x.id)).size).toBe(1);await vi.waitFor(()=>expect(latest().status).toBe('completed'));
    expect(posts).toBe(1);expect(db.select().from(contents).all()).toHaveLength(1);expect(balance()).toBeCloseTo(98.6,6);
    await(await retryVideo('/v1/videos',body,'intentional-new-task')).json();await vi.waitFor(()=>expect(db.select().from(contents).all().filter(x=>x.status==='completed')).toHaveLength(2));
    expect(posts).toBe(2);expect(balance()).toBeCloseTo(97.2,6);
  });
  it('rejects changed seconds, model or reference under the same key before another order or deduction',async()=>{
    const p=V6K_TT25_PRODUCTS[0];await installTt25();let posts=0;
    upstream=async()=>{posts++;return Response.json({id:'conflict_original',status:'completed'});};
    const body={model:p.id,prompt:'原始参数',seconds:5,resolution:p.resolution};
    await(await retryVideo('/v1/videos',body,'same-key')).json();await vi.waitFor(()=>expect(latest().status).toBe('completed'));
    for(const patch of [{seconds:10},{model:V6K_TT25_PRODUCTS[1].id,resolution:'720p'},{reference_images:[reference]}]){
      const response=await retryVideo('/v1/video/generations',{...body,...patch},'same-key');expect(response.status).toBe(409);expect(await response.json()).toMatchObject({error:{code:'idempotency_conflict'}});
    }
    expect(posts).toBe(1);expect(db.select().from(contents).all()).toHaveLength(1);expect(balance()).toBeCloseTo(98.6,6);
  });
  it('replays a stored validation rejection without creating an order, and treats missing linked content as gone',async()=>{
    const p=V6K_TT25_PRODUCTS[0];await installTt25();let posts=0;
    upstream=async()=>{posts++;return Response.json({id:'deleted_original',status:'completed'});};
    const invalid={model:p.id,prompt:'非法秒数',seconds:31,resolution:p.resolution};
    const first=await retryVideo('/v1/videos',invalid,'bad-request'),error=await first.json();expect(first.status).toBe(400);
    const retry=await retryVideo('/v1/videos',invalid,'bad-request');expect(retry.status).toBe(400);expect(await retry.json()).toEqual(error);expect(db.select().from(contents).all()).toHaveLength(0);expect(balance()).toBe(100);
    const body={...invalid,seconds:5};await(await retryVideo('/v1/videos',body,'good-request')).json();await vi.waitFor(()=>expect(latest().status).toBe('completed'));
    db.delete(contents).run();const gone=await retryVideo('/v1/videos',body,'good-request');expect(gone.status).toBe(410);expect(posts).toBe(1);expect(balance()).toBeCloseTo(98.6,6);
  });
  it('protects the legacy direct branch and preserves its original local task alias on query',async()=>{
    const model='TTTseadanco2.5/720',c=db.select().from(channels).get()!;
    db.insert(models).values({modelId:model,displayName:model,provider:'zongheng-v6k',capabilities:'["video"]',isActive:1}).run();
    db.insert(modelPricing).values({modelPattern:model,billingType:'per_call',inputPrice:6.5}).run();
    ChannelService.updateChannel(c.id,{type:'zongheng-v6k',baseUrl:'https://www.v6k.top',supportedModels:[model],modelMapping:{[model]:model}});
    let posts=0;upstream=async()=>{posts++;return Response.json({id:'direct_retry_original',status:'completed'});};
    const body={model,prompt:'直连原订单',seconds:5,resolution:'720p'};
    const original=await(await retryVideo('/v1/videos',body,'direct-key')).json() as any;await vi.waitFor(()=>expect(latest().status).toBe('completed'));
    const replay=await(await retryVideo('/v1/video/generations',body,'direct-key')).json() as any;
    expect(replay.id).toBe(original.id);expect(replay.status).toBe('completed');expect(posts).toBe(1);expect(balance()).toBe(93.5);
    const historical=await(await nativeFetch(origin+'/v1/videos/task_'+latest().id,{headers:{Authorization:'Bearer test'}})).json() as any;
    expect(historical.id).toBe('task_'+latest().id);expect(historical.status).toBe('completed');
  });
  it('deduplicates real multipart retries with different filenames and boundaries, and maps the download alias locally',async()=>{
    vi.stubEnv('BACKEND_URL','https://app.example');
    const p=V6K_TT25_PRODUCTS[0];await installTt25();let posts=0;
    upstream=async()=>{posts++;return Response.json({id:'multipart_original',status:'completed'});};
    const send=async(name:string)=>{const form=new FormData();form.append('model',p.id);form.append('prompt','同一上传重试');form.append('seconds','5');form.append('resolution',p.resolution);form.append('image',new Blob([Buffer.from(reference.split(',')[1],'base64')],{type:'image/png'}),name);
      return nativeFetch(origin+'/v1/videos',{method:'POST',headers:{Authorization:'Bearer test'},body:form});};
    const first=await(await send('first.png')).json() as any;await vi.waitFor(()=>expect(latest().status,latest().metadata).toBe('completed'));
    const retry=await(await send('renamed.png')).json() as any;expect(retry.id).toBe(first.id);expect(posts).toBe(1);expect(balance()).toBeCloseTo(98.6,6);
    const download=await nativeFetch(origin+'/v1/files/video?id='+first.id,{headers:{Authorization:'Bearer test'},redirect:'manual'});
    expect(download.status).toBe(307);expect(download.headers.get('location')).toBe('/v1/videos/'+first.id+'/content');expect(posts).toBe(1);
  });
  it('keeps original tasks readable by an exhausted key and refuses another key without consulting the upstream',async()=>{
    const p=V6K_TT25_PRODUCTS[0];await installTt25();let posts=0;
    upstream=async()=>{posts++;return Response.json({id:'auth_original',status:'completed'});};
    const body={model:p.id,prompt:'读取原任务',seconds:5,resolution:p.resolution};
    const first=await(await retryVideo('/v1/videos',body,'auth-key')).json() as any;await vi.waitFor(()=>expect(latest().status).toBe('completed'));
    vi.spyOn(TokenService,'validateToken').mockImplementation((key:string,options:any)=>options?.allowExhausted?{valid:true,token:{id:key==='test'?1:2,userId:1,balance:0,allowedModels:[]}}:{valid:false,error:'Token额度用完'});
    const retry=await(await retryVideo('/v1/videos',body,'auth-key')).json() as any;expect(retry.id).toBe(first.id);
    const status=await nativeFetch(origin+'/v1/videos/'+first.id,{headers:{Authorization:'Bearer test'}});expect(status.status).toBe(200);
    const denied=await nativeFetch(origin+'/v1/videos/'+first.id,{headers:{Authorization:'Bearer other'}});expect(denied.status).toBe(404);
    const malformed=await nativeFetch(origin+'/v1/videos/task_req_invalid',{headers:{Authorization:'Bearer test'}});expect(malformed.status).toBe(404);expect(posts).toBe(1);expect(balance()).toBeCloseTo(98.6,6);
  });
});

describe('V6K cutover using the existing Zongheng billing and recovery paths', () => {
  it.each(['/api/video/generate', '/v1/videos'])('charges TTTseadanco2.5/720 exactly 6.5 per task at both 5 and 30 seconds at %s', async endpoint => {
    const model = 'TTTseadanco2.5/720';
    db.insert(models).values({ modelId: model, displayName: model, provider: 'zongheng-v6k', capabilities: '["video"]', isActive: 1 }).run();
    db.insert(modelPricing).values({ modelPattern: model, billingType: 'per_call', inputPrice: 6.5 }).run();
    const c = db.select().from(channels).get()!;
    ChannelService.updateChannel(c.id, { type: 'zongheng-v6k', supportedModels: [model], modelMapping: { [model]: model } });
    sqlite.prepare("INSERT INTO api_tokens (id,user_id,token_key,balance) VALUES (1,1,'test',-1)").run();
    let posts = 0;
    upstream = async (_url, init) => {
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toMatchObject({ model, resolution: '720p', seconds: posts === 0 ? 5 : 30 });
      return Response.json({ id: 'ttt_' + ++posts, status: 'completed' });
    };
    const catalog = await (await nativeFetch(origin + '/api/video/models')).json() as any[];
    expect(catalog.find(item => item.id === model)).toMatchObject({ rates: { '720p': 6.5 }, billingType: 'per_call', available: true });
    expect(catalog.find(item => item.id === model).rates).not.toHaveProperty('480p');
    const rejected = await (await post(endpoint, { model, prompt: '场景', seconds: 30, video_length: 30, resolution: '480p' })).text();
    expect(rejected).toContain('720p'); expect(posts).toBe(0); expect(balance()).toBe(100);
    expect(db.select().from(contents).all()).toHaveLength(0);
    for (const seconds of [5,30]) {
      await (await post(endpoint, { model, prompt: '场景', seconds, video_length: seconds, ...(seconds === 5 ? { resolution: '720P' } : {}) })).text();
      await vi.waitFor(() => expect(latest().status).toBe('completed'));
      expect(latest().cost).toBe(6.5);
    }
    expect(posts).toBe(2); expect(balance()).toBe(87);
  });
  it.each(ZONGHENG_VIDEO_MODELS)('retains the exact $id model and existing price through both new-protocol entry points', async spec => {
    installConfirmedVideos();
    sqlite.prepare("INSERT INTO api_tokens (id,user_id,token_key,balance) VALUES (1,1,'test',-1)").run();
    let posts = 0;
    upstream = async (url, init) => {
      expect(url).toBe('https://channel.invalid/v1/videos'); expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toMatchObject({ model: spec.id, seconds: spec.seconds[0], resolution: spec.resolution });
      posts++; return Response.json({ id: 'catalog_' + posts, status: 'completed' });
    };
    for (const endpoint of ['/api/video/generate', '/v1/videos']) {
      await (await post(endpoint, { model: 'ZH-' + spec.id, prompt: '场景' })).text();
      await vi.waitFor(() => expect(latest().status).toBe('completed'));
      expect(latest().cost).toBe(2);
    }
    expect(posts).toBe(2); expect(balance()).toBe(96);
  });
  function enableV6k() {
    const old = db.select().from(channels).get()!;
    ChannelService.updateChannel(old.id, { status: 0 });
    const id = ChannelService.createChannel({ name: '纵横 V6K', type: 'zongheng-v6k', baseUrl: 'https://www.v6k.top', apiKey: 'v6k-key',
      supportedModels: ['ZH-video-public'], modelMapping: { 'ZH-video-public': 'video-public' } });
    expect(db.select().from(channels).all().find(c => c.id === id)?.type).toBe('zongheng-v6k');
    sqlite.prepare("INSERT INTO api_tokens (id,user_id,token_key,balance) VALUES (1,1,'test',-1)").run();
    return { old, id };
  }
  it.each(['/api/video/generate','/v1/videos'])('synchronizes a no-ID submission review and lets the confirmed admin refund settle once at %s',async endpoint=>{
    enableV6k();let posts=0;
    upstream=async()=>{posts++;return Response.json({error:{code:'service_unavailable',message:'生成服务暂时繁忙或队列已满'}},{status:503});};
    await(await post(endpoint,{...request,seconds:6})).text();expect(latest().status).toBe('review');
    const id=latest().id,meta=JSON.parse(latest().metadata!);
    if(meta.billingReservationId)expect(sqlite.prepare('SELECT state FROM billing_reservations WHERE id=?').get(meta.billingReservationId)).toEqual({state:'review'});
    expect(balance()).toBe(98);expect(confirmReviewedVideoFailureAndRefund(id,1,true)).toMatchObject({refundedAmount:2,alreadyResolved:false});
    expect(confirmReviewedVideoFailureAndRefund(id,1,true).alreadyResolved).toBe(true);
    expect(latest()).toMatchObject({status:'failed',cost:0});expect(balance()).toBe(100);expect(posts).toBe(1);
  });
  it.each(['/api/video/generate','/v1/videos'])('pauses a 410 delivery failure and recovers the same ID without a second POST or money movement at %s',async endpoint=>{
    enableV6k();let posts=0,queries=0;
    const {downloadAndLocalizeVideo}=await import('../server/services/videoLocalizationService');
    vi.mocked(downloadAndLocalizeVideo).mockRejectedValueOnce(new V6kVideoContentError('[上游诊断 V6K 成品获取失败] HTTP 410 code=task_not_found：任务或文件不存在或已失效',410,'delivery_original','task_not_found'));
    upstream=async(_url,init)=>{if(init.method==='POST'){posts++;return Response.json({id:'delivery_original',status:'queued'});}queries++;return Response.json({id:'delivery_original',status:'completed'});};
    const reply=await(await post(endpoint,{...request,seconds:6})).text(); await vi.waitFor(()=>expect(latest().status).toBe('review'));
    expect(reply).not.toContain('V6K');
    const id=latest().id,meta=JSON.parse(latest().metadata!);
    expect(meta).toMatchObject({videoId:'delivery_original',videoSubmissionState:'accepted',videoDeliveryUnavailable:true,billingStatus:'reserved'});
    expect(meta.resultSaveError).toContain('410');expect(latest().cost).toBe(2);expect(balance()).toBe(98);expect(posts).toBe(1);
    const attempts=queries; video.resumeAllPendingVideoTasks();video.resumeAllPendingVideoTasks();await video.resumePollForTask(id,latest());
    expect(queries).toBe(attempts);expect(balance()).toBe(98);
    const recovered=await ContentRecoveryService.recover(id);expect(recovered.status).toBe('completed');expect(balance()).toBe(98);
    expect(JSON.parse(latest().metadata!).videoDeliveryUnavailable).toBeUndefined();expect(latest().cost).toBe(2);
    await ContentRecoveryService.recover(id);expect(balance()).toBe(98);expect(posts).toBe(1);
  });
  it.each(['/api/video/generate', '/v1/videos'].flatMap(endpoint => ['completed', 'failed'].map(status => ({ endpoint, status }))))('keeps an unknown receipt and settles $status once at $endpoint through repeated query faults', async ({ endpoint, status }) => {
    const { id: channelId } = enableV6k(); let posts = 0, queries = 0;
    upstream = async (_url, init) => {
      if (init.method === 'POST') {
        posts++;
        expect(JSON.parse(latest().metadata!).zonghengOrderId).toBe(init.headers['Idempotency-Key']);
        return Response.json({ id: '00012345678901234567890', status: 'unknown', error: { message: 'not failed' } }, { status: 503 });
      }
      expect(findVideoSubmissionReceipt(latest().id)).toMatchObject({ upstreamTaskId: '00012345678901234567890', channelId });
      expect(JSON.parse(latest().metadata!)).toMatchObject({ videoId: '00012345678901234567890', videoSubmissionState: 'accepted' });
      expect(() => claimVideoSubmission(latest().id)).toThrow('禁止重复提交');
      expect(balance()).toBe(98);
      queries++;
      if (queries === 1) return Response.json({ error: { code: 'temporary_limit', message: 'query later' } }, { status: 429, headers: { 'Retry-After': '75' } });
      if (queries === 2) return new Promise<Response>(() => {}); // Transport ignores AbortSignal; the hard deadline must recover.
      if (queries === 3) return new Response('<html>temporarily unavailable</html>', { headers: { 'Retry-After': '90' } });
      if (queries === 4) return Response.json({ id: '00012345678901234567890', status: 'unknown' });
      expect(JSON.parse(latest().metadata!)).toMatchObject({ upstreamStatus: 'unknown', progressKnown: false });
      return Response.json({ id: '00012345678901234567890', status, error: status === 'failed' ? { code: 'generation_rejected', message: 'confirmed failed' } : undefined });
    };
    await (await post(endpoint, { ...request, seconds: 6 })).text();
    await vi.waitFor(() => expect(latest().status).toBe(status));
    expect(posts).toBe(1); expect(queries).toBe(5);
    const delays = vi.mocked(setTimeout).mock.calls.map(call => call[1]);
    expect(delays).toEqual(expect.arrayContaining([75_000,40_000,90_000,20_000]));
    const finalBalance = status === 'failed' ? 100 : 98;
    expect(balance()).toBe(finalBalance);
    await Promise.all([video.resumePollForTask(latest().id, latest()), video.resumePollForTask(latest().id, latest())]);
    expect(balance()).toBe(finalBalance); expect(posts).toBe(1); expect(queries).toBe(5);
  });
  it.each(['completed', 'failed'])('recovers an old accepted unknown receipt after a restart, without POST or duplicate settlement: %s', async status => {
    const { id: channelId } = enableV6k();
    sqlite.prepare('UPDATE users SET balance=98 WHERE id=1').run();
    const id = Number(db.insert(contents).values({ userId: 1, type: 'video', status: 'processing', modelId: request.model, cost: 2,
      metadata: JSON.stringify({ channelId, zonghengProtocol: 'v6k', zonghengBaseUrl: 'https://www.v6k.top', upstreamStatus: 'unknown', billingStatus: 'reserved', billingBalanceSource: 'user' }) }).run().lastInsertRowid);
    acceptVideoSubmission(id, 'restart_original', { provider: 'zongheng', channelId });
    // Simulate a stale metadata copy; recovery must retain the durable receipt.
    const stale = JSON.parse(latest().metadata!); delete stale.videoId; delete stale.upstreamTaskId;
    sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?').run(JSON.stringify(stale), id);
    let queries = 0;
    upstream = async (url, init) => {
      expect(init.method).not.toBe('POST'); expect(url).toBe('https://www.v6k.top/v1/videos/restart_original');
      return Response.json({ id: 'restart_original', status: ++queries === 1 ? 'unknown' : status, error: status === 'failed' ? { message: 'confirmed failed' } : undefined });
    };
    video.resumeAllPendingVideoTasks(); video.resumeAllPendingVideoTasks();
    await vi.waitFor(() => expect(latest().status).toBe(status));
    expect(queries).toBe(2); expect(balance()).toBe(status === 'failed' ? 100 : 98);
    video.resumeAllPendingVideoTasks();
    await video.resumePollForTask(id, latest());
    expect(queries).toBe(2); expect(balance()).toBe(status === 'failed' ? 100 : 98);
  });
  it.each(['/api/video/generate', '/v1/videos'])('retains the durable receipt if accepting content metadata fails at %s', async endpoint => {
    enableV6k(); let posts = 0;
    upstream = async (_url, init) => {
      expect(init.method).toBe('POST'); posts++;
      sqlite.exec(`CREATE TRIGGER fail_accept BEFORE UPDATE OF metadata ON contents
        WHEN json_extract(NEW.metadata,'$.videoSubmissionState')='accepted'
        BEGIN SELECT RAISE(ABORT,'simulated metadata write failure'); END`);
      return Response.json({ id: 'saved_despite_metadata_failure', status: 'unknown' });
    };
    try {
      await (await post(endpoint, { ...request, seconds: 6 })).text();
      expect(latest().status).toBe('review');
      expect(findVideoSubmissionReceipt(latest().id)).toMatchObject({ upstreamTaskId: 'saved_despite_metadata_failure' });
      expect(balance()).toBe(98); expect(posts).toBe(1);
    } finally { sqlite.exec('DROP TRIGGER IF EXISTS fail_accept'); }
  });
  it.each(['/api/video/generate', '/v1/videos'])('submits once and synchronizes queued/processing/completed with no URL at %s', async endpoint => {
    const { id } = enableV6k(); let posts = 0, queries = 0;
    const { downloadAndLocalizeVideo } = await import('../server/services/videoLocalizationService');
    vi.mocked(downloadAndLocalizeVideo).mockClear();
    upstream = async (url, init) => {
      expect(init.headers.Authorization).toBe('Bearer v6k-key');
      if (init.method === 'POST') {
        posts++; expect(url).toBe('https://www.v6k.top/v1/videos');
        expect(JSON.parse(init.body)).toMatchObject({ model: 'video-public', seconds: 6, videos: ['https://media.invalid/r.mp4'], audios: ['https://media.invalid/r.mp3'] });
        expect(JSON.parse(init.body)).not.toHaveProperty('duration');
        return Response.json({ id: 'v6k_task', status: 'queued', progress: 0 });
      }
      expect(url).toBe('https://www.v6k.top/v1/videos/v6k_task');
      return Response.json({ id: 'v6k_task', status: ++queries === 1 ? 'in_progress' : 'completed', progress: 100 });
    };
    const response = await post(endpoint, { ...request, seconds: 6, reference_videos: ['https://media.invalid/r.mp4'], audio_urls: ['https://media.invalid/r.mp3'] });
    await response.text(); await vi.waitFor(() => expect(latest().status).toBe('completed'));
    expect(balance()).toBe(98); expect(posts).toBe(1);
    expect(JSON.parse(latest().metadata!)).toMatchObject({ videoId: 'v6k_task', channelId: id, zonghengProtocol: 'v6k', zonghengBaseUrl: 'https://www.v6k.top' });
    expect(vi.mocked(downloadAndLocalizeVideo).mock.calls.some(args => args[0] === 'https://www.v6k.top/v1/videos/v6k_task/content' && args[3] === id)).toBe(true);
    await video.resumePollForTask(latest().id, latest()); expect(balance()).toBe(98); expect(posts).toBe(1);
  });
  it.each(['/api/video/generate', '/v1/videos'].flatMap(endpoint => ['completed', 'failed'].map(status => ({ endpoint, status }))))('settles an immediate $status response at $endpoint without a second request', async ({ endpoint, status }) => {
    enableV6k(); let posts = 0;
    upstream = async (_url, init) => {
      expect(init.method).toBe('POST'); posts++;
      return Response.json({ id: 'v6k_immediate', status, error: status === 'failed' ? { code: 'video_generation_failed', message: 'confirmed failure' } : undefined });
    };
    await (await post(endpoint, { ...request, seconds: 6 })).text();
    await vi.waitFor(() => expect(latest().status).toBe(status));
    expect(JSON.parse(latest().metadata!).videoId).toBe('v6k_immediate');
    expect(balance()).toBe(status === 'completed' ? 98 : 100); expect(posts).toBe(1);
    await video.resumePollForTask(latest().id, latest());
    expect(balance()).toBe(status === 'completed' ? 98 : 100); expect(posts).toBe(1);
  });
  it('retains an old order without querying the retired API, resubmitting or refunding', async () => {
    const { old } = enableV6k();
    const id = Number(db.insert(contents).values({ userId: 1, type: 'video', status: 'processing', modelId: request.model, cost: 2,
      metadata: JSON.stringify({ videoId: 'vid_old', channelId: old.id, zonghengProtocol: 'legacy' }) }).run().lastInsertRowid);
    await video.resumePollForTask(id, latest());
    expect(latest()).toMatchObject({ status: 'review', cost: 2 });
    expect(JSON.parse(latest().metadata!).videoId).toBe('vid_old'); expect(fetch).not.toHaveBeenCalled(); expect(balance()).toBe(100);
    await expect(ContentRecoveryService.inspect(id)).rejects.toMatchObject({ status: 409 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['completed', 'failed'])('continues the original task after a temporary query error and settles %s once', async status => {
    enableV6k(); let posts = 0, queries = 0;
    upstream = async (_url, init) => {
      if (init.method === 'POST') { posts++; return Response.json({ id: 'v6k_retry', status: 'queued' }); }
      if (++queries === 1) return Response.json({ error: { message: 'rate limited' } }, { status: 429, headers: { 'Retry-After': '1' } });
      return Response.json({ id: 'v6k_retry', status, error: status === 'failed' ? { message: 'confirmed failure' } : undefined });
    };
    await (await post('/v1/videos', { ...request, seconds: 6 })).text();
    await vi.waitFor(() => expect(latest().status).toBe(status));
    expect(posts).toBe(1); expect(queries).toBe(2); expect(balance()).toBe(status === 'failed' ? 100 : 98);
    await video.resumePollForTask(latest().id, latest());
    expect(balance()).toBe(status === 'failed' ? 100 : 98); expect(posts).toBe(1);
  });
  it('retries V6K result storage without creating another task or refunding a success', async () => {
    enableV6k(); let posts = 0, queries = 0;
    const { downloadAndLocalizeVideo } = await import('../server/services/videoLocalizationService');
    vi.mocked(downloadAndLocalizeVideo).mockRejectedValueOnce(new Error('temporary save failure'));
    upstream = async (_url, init) => {
      if (init.method === 'POST') { posts++; return Response.json({ id: 'save_retry', status: 'queued' }); }
      queries++; return Response.json({ id: 'save_retry', status: 'completed' });
    };
    await (await post('/api/video/generate', { ...request, seconds: 6 })).text();
    expect(latest().status).toBe('completed'); expect(balance()).toBe(98); expect(posts).toBe(1); expect(queries).toBe(2);
  });
  it('inspects a V6K task using its content endpoint instead of requiring a public URL', async () => {
    const { id: channelId } = enableV6k();
    const id = Number(db.insert(contents).values({ userId: 1, type: 'video', status: 'processing', modelId: request.model, cost: 2,
      metadata: JSON.stringify({ videoId: 'new_task', channelId, zonghengProtocol: 'v6k', zonghengBaseUrl: 'https://www.v6k.top' }) }).run().lastInsertRowid);
    upstream = async url => { expect(url).toBe('https://www.v6k.top/v1/videos/new_task'); return Response.json({ id: 'new_task', status: 'completed' }); };
    expect(await ContentRecoveryService.inspect(id)).toMatchObject({ status: 'completed', upstreamResultUrl: 'https://www.v6k.top/v1/videos/new_task/content' });
    expect(balance()).toBe(100);
  });
  it.each(['/api/video/generate', '/v1/videos'].flatMap(endpoint => [200, 400, 401, 402, 403, 404, 422, 429].map(status => ({ endpoint, status }))))('marks an explicit HTTP $status rejection failed, not review, at $endpoint', async ({ endpoint, status }) => {
    enableV6k(); let posts = 0;
    upstream = async (_url, init) => {
      expect(init.method).toBe('POST'); posts++;
      return Response.json({ error: { code: 'invalid_parameters', type: 'new_api_error', message: 'unsupported duration' },
        code: 'invalid_parameters', message: 'unsupported duration', data: null, request_id: 'trace_only' },
        { status, headers: { 'x-request-id': 'trace_only' } });
    };
    await (await post(endpoint, { ...request, seconds: 6 })).text();
    expect(latest()).toMatchObject({ status: 'failed', cost: 0 });
    const metadata = JSON.parse(latest().metadata!);
    expect(metadata.requiresReview).not.toBe(true);
    expect(metadata.error).toContain('unsupported duration');
    expect(balance()).toBe(100); expect(posts).toBe(1);
    await video.resumePollForTask(latest().id, latest());
    expect(balance()).toBe(100); expect(posts).toBe(1);
  });
  it.each(['/api/video/generate', '/v1/videos'])('does not resubmit or refund an uncertain 504 at %s', async endpoint => {
    enableV6k(); let posts = 0;
    upstream = async () => { posts++; return new Response('<html>gateway timeout</html>', { status: 504 }); };
    await (await post(endpoint, { ...request, seconds: 6 })).text();
    expect(latest().status).toBe('review'); expect(balance()).toBe(98);
    await video.resumePollForTask(latest().id, latest());
    expect(posts).toBe(1); expect(balance()).toBe(98);
  });
  it.each(['/api/video/generate', '/v1/videos'])('preserves a 503 diagnostic and exits the submitting state without generating or settling twice at %s', async endpoint => {
    enableV6k(); let posts = 0;
    upstream = async () => {
      posts++;
      return Response.json({ error: { code: 'provider_specific_503', message: '原始具体原因 v6k-key https://secret.invalid/file?signature=private' } },
        { status: 503, headers: { 'x-request-id': 'trace_503' } });
    };
    const reply = await (await post(endpoint, { ...request, seconds: 6 })).text();
    expect(reply).toContain('provider_specific_503');
    expect(reply).not.toContain('v6k-key'); expect(reply).not.toContain('V6K');
    expect(latest().status).toBe('review'); expect(balance()).toBe(98);
    const meta = JSON.parse(latest().metadata!);
    expect(meta.videoSubmissionState).toBe('unknown');
    expect(meta.error).toContain('provider_specific_503');
    expect(meta.error).toContain('原始具体原因');
    expect(meta.error).not.toContain('secret.invalid');
    expect(meta.zonghengSubmissionDiagnostics).toMatchObject({ httpStatus: 503, reason: 'http_error' });
    expect(meta.zonghengSubmissionDiagnostics.message).toContain('trace_503');
    expect(JSON.stringify(meta.zonghengSubmissionDiagnostics)).not.toContain('signature=private');
    await video.resumePollForTask(latest().id, latest());
    expect(posts).toBe(1); expect(balance()).toBe(98);
  });
});
