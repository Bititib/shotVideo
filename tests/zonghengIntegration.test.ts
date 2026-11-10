import { migrateZonghengModelPrefix } from '../server/services/zonghengPrefixMigration';
import { ZONGHENG_VIDEO_MODELS } from '../shared/zonghengVideo';
import { getPublicDeveloperModels } from '../server/services/developerModelService';
import { V6K_SEEDANCE_20_MODEL, V6K_XX_SEEDANCE_20_MODEL } from '../shared/v6kSeedance2';
import { getModelSpecification, saveModelSpecification, deleteModelSpecification } from '../server/services/modelRoutingService';
import { resumeSpecificationTasks } from '../server/services/specificationGenerationService';
import { batchStore, tickVideoBatches } from '../server/services/videoBatchService';
import { V6K_TT25_PRODUCTS } from '../shared/v6kTt25';
import { removeTtBbFallbacks } from '../server/db/removeTtBbFallbacks';
import { ensureBbHssKkMapping } from '../server/services/bbHssKkMigration';
import { BB_HSS_KK_ENTRIES, bbHssKkLimits } from '../shared/bbHssKk';
import { switchHssSource } from '../server/services/hssSourceService';
import { switchBbHssVideoSource, getBbHssVideoSources } from '../server/services/bbHssSourceService';
import { BB_HSS_SOURCES } from '../shared/bbHssSources';
import { ensureBbHssMoMapping } from '../server/services/bbHssMoMigration';
import { routeUnavailableReason, selectModelRoutes } from '../server/services/modelRoutingService';
import { pruneUnapprovedV6kBindings } from '../server/services/v6kApprovedBindings';
import { hussHssModelLimits, hussBbAModelLimits } from '../shared/hussBbVideo';
import { syncHussModels } from '../server/services/hussCatalogService';
import { ensureV6kTt25Models, v6kTt25SaleId } from '../server/services/v6kTt25Catalog';
import { quoteVideoRequest } from '../server/services/videoQuoteService';
import { PricingService } from '../server/services/pricingService';
import { TokenService } from '../server/services/tokenService';
import { ensureV6kTttModel } from '../server/services/v6kTttModel';
import { V6K_SYNC_UPSTREAM_MODELS } from '../shared/v6kSyncModels';
import type { V6kModelConfiguration, V6kModelDraft } from '../shared/v6kModelConfiguration';
import { getKkVideoRouting, saveKkVideoRouting } from '../server/services/kkVideoRoutingService';
import { KK_VIDEO_SOURCES } from '../shared/kkVideoRouting';
import { V6K_STABLE_720_MODEL as WD, V6K_STABLE_720_UPSTREAM as STABLE, v6kStable720Limits } from '../shared/v6kStableVideo';
import { ensureV6kStable720Model, enableV6kStable720Entry } from '../server/services/v6kStable720Catalog';
import { V6K_FULL_720_MODEL as FULL, V6K_FULL_720_UPSTREAM as FULL_UPSTREAM, V6K_FULL_720_DESCRIPTION, V6K_FULL_720_LEGACY_UPSTREAM as OLD_FULL, V6K_FULL_720_LEGACY_DESCRIPTION, v6kFull720Limits } from '../shared/v6kFullReferenceVideo';
import { ensureV6kFull720Model, enableV6kFull720Entry } from '../server/services/v6kFull720Catalog';
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
vi.mock('../server/middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.userId = 1;
    if (req.headers.authorization === 'Bearer test-admin') req.userRole = 'super_admin';
    next();
  },
  optionalAuthMiddleware: (_req: any, _res: any, next: any) => next(),
}));
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
  const adminSpecs=await import('../server/routes/modelSpecifications');
  const admin=await import('../server/routes/admin');
  const adminChannels=await import('../server/routes/channels');
  const app=express(); app.use(express.json({limit:'5mb'}));app.use('/api/video',video.default);app.use('/api/image-gen',image.default);app.use('/v1',v1.default);
  app.use('/test/admin/model-specifications',adminSpecs.default);
  app.use('/api/admin',admin.default);
  app.use('/api/admin/channels',adminChannels.default);
  app.use((e:any,_req:any,res:any,_next:any)=>res.status(e.status||500).json({error:e.message}));
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
  it.each(['completed','failed'])('unlinks historical unapproved models but still resumes their accepted original to %s and settles once',async terminal=>{
    await installSeedance20();const c=db.select().from(channels).get()!,id='ZH-dola2.0';
    db.insert(models).values({modelId:id,displayName:'historical Dola',provider:'zongheng-v6k',capabilities:'["video"]',isActive:1}).run();
    db.insert(modelPricing).values({modelPattern:id,billingType:'per_call',inputPrice:2}).run();
    ChannelService.updateChannel(c.id,{supportedModels:[...JSON.parse(c.supportedModels),id],modelMapping:{...JSON.parse(c.modelMapping),[id]:'dola2.0'}});
    const originalSpec=getModelSpecification(V6K_SEEDANCE_20_MODEL)!;
    saveModelSpecification({...originalSpec,modelId:id,routes:[{...originalSpec.routes[0],id:'old-dola-route',executionModel:id,upstreamModel:'dola2.0'}]});
    let posts=0,clock=Date.now();const time=vi.spyOn(Date,'now').mockImplementation(()=>clock);
    try{
      upstream=async(url,init)=>{if(init.method==='POST'){posts++;expect(JSON.parse(init.body).model).toBe('dola2.0');return Response.json({id:'original_old_dola',status:'queued'});}
        expect(url).toBe('https://www.v6k.top/v1/videos/original_old_dola');clock+=2*60*60_000+1;return Response.json({id:'original_old_dola',status:'unknown'});};
      await(await post('/api/video/generate',{model:id,prompt:'accepted before cleanup',seconds:15,resolution:'720p'})).text();
      await vi.waitFor(()=>expect(Number(JSON.parse(latest().metadata).v6kQueryResumeAt)).toBeGreaterThan(clock));
      const original=latest(),receipt=findVideoSubmissionReceipt(original.id),meta=JSON.parse(original.metadata);
      const reservation=sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(meta.billingReservationId);
      expect(pruneUnapprovedV6kBindings(sqlite,c.id)).toEqual({removedBindings:1,removedRoutes:1});
      expect(latest()).toEqual(original);expect(findVideoSubmissionReceipt(original.id)).toEqual(receipt);
      expect(sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(meta.billingReservationId)).toEqual(reservation);
      expect(JSON.parse(ChannelService.getChannelRaw(c.id)!.supportedModels)).not.toContain(id);
      expect(db.select().from(models).where(eq(models.modelId,id)).get()).toMatchObject({displayName:'historical Dola',isActive:1});
      const rejected=await post('/api/video/generate',{model:id,prompt:'new unapproved request',seconds:15,resolution:'720p'});expect(rejected.status).toBe(503);await rejected.text();expect(posts).toBe(1);expect(balance()).toBe(98);
      upstream=async(url,init)=>{expect(init.method).not.toBe('POST');expect(url).toBe('https://www.v6k.top/v1/videos/original_old_dola');return Response.json({id:'original_old_dola',status:terminal,error:terminal==='failed'?{code:'video_generation_failed',message:'original generation failed'}:undefined});};
      clock+=120_000;resumeSpecificationTasks();resumeSpecificationTasks();await vi.waitFor(()=>expect(latest().status).toBe(terminal));
      resumeSpecificationTasks();pruneUnapprovedV6kBindings(sqlite);resumeSpecificationTasks();
      expect(posts).toBe(1);expect(balance()).toBe(terminal==='completed'?98:100);expect(latest().cost).toBe(terminal==='completed'?2:0);
      expect(JSON.parse(latest().metadata)).toMatchObject({videoId:'original_old_dola',upstreamModel:'dola2.0',billingStatus:terminal==='completed'?'settled':'refunded'});
    }finally{time.mockRestore();}
  });
  it('imports only approved upstream IDs as nine entries and never expands scope from video metadata or similar names',async()=>{
    ensureV6kTttModel(sqlite);
    const unrelated=['TTseadanco2.5-720YT','XXsedanco2.0S','dola2.0','grok--1.5','QQsedanco2.5/720','KKseadanco2.5X','Asedanco2.0-extra','ttseadanco2.5-480','brand-new-video'];
    const result=await syncV6kEntries([...V6K_SYNC_UPSTREAM_MODELS.map(id=>({id})),...unrelated.map(id=>({id,type:'video',supported_endpoint_types:['openai-video']})),{id:'Asedanco2.0'}]);
    const expected=['kkseadanco2.5',WD,FULL,'TTTseadanco2.5/720',V6K_SEEDANCE_20_MODEL,V6K_XX_SEEDANCE_20_MODEL,...V6K_TT25_PRODUCTS.map(p=>p.id)];
    expect(result.count).toBe(9);expect(new Set(result.models)).toEqual(new Set(expected));
    expect(db.select().from(models).all().filter(m=>expected.includes(m.modelId))).toHaveLength(9);
    expect(db.select().from(models).all().filter(m=>unrelated.some(id=>m.modelId===id||m.modelId==='ZH-'+id))).toEqual([]);
    expect(expected.every(id=>db.select().from(models).all().find(m=>m.modelId===id)!.isActive===0)).toBe(true);
    const channel=db.select().from(channels).get()!;
    expect(JSON.parse(channel.supportedModels)).toEqual(expect.arrayContaining(expected));
    for(const id of ['ZH-video-public','ZH-image-public','ZH-gpt-public']){expect(JSON.parse(channel.supportedModels)).not.toContain(id);expect(JSON.parse(channel.modelMapping)).not.toHaveProperty(id);}
    expect(sqlite.prepare('SELECT count(*) AS n FROM v6k_unapproved_binding_archive').get()).toMatchObject({n:expect.any(Number)});
    expect(result.warnings?.join('')).toContain('其他型号 9 个');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(db.select().from(contents).all()).toEqual([]);expect(balance()).toBe(100);
  });
  it('preserves existing prices, names, switches and approved routes across full and partial repeated syncs after retiring obsolete associations',async()=>{
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

it('removes saved BB fallback configuration while recovering its already accepted original task and reservation',async()=>{
  await installTt25(true);const id='ZH-TTseadanco2.5-720',spec=getModelSpecification(id)!;
  const bb={...spec.routes[0],id:'v6k-tt-bb-1-720p',upstreamModel:'BBseadanco-720'};
  saveModelSpecification({...spec,routes:[bb]});
  let posts=0,queries=0,clock=Date.now();const time=vi.spyOn(Date,'now').mockImplementation(()=>clock);
  try{
    upstream=async(url,init)=>{if(init.method==='POST'){posts++;expect(JSON.parse(init.body).model).toBe('BBseadanco-720');return Response.json({id:'accepted_bb_before_removal',status:'queued'});}
      queries++;clock+=2*60*60_000+1;return Response.json({id:'accepted_bb_before_removal',status:'unknown'});};
    await(await post('/api/video/generate',{model:id,prompt:'old accepted order',seconds:10,resolution:'720p'})).text();
    await vi.waitFor(()=>expect(Number(JSON.parse(latest().metadata).v6kQueryResumeAt)).toBeGreaterThan(clock));
    const original=latest(),receipt=findVideoSubmissionReceipt(original.id),balanceBefore=balance();
    expect(removeTtBbFallbacks(sqlite)).toBe(1);expect(getModelSpecification(id)!.routes).toEqual([]);
    expect(findVideoSubmissionReceipt(original.id)).toEqual(receipt);expect(balance()).toBe(balanceBefore);
    upstream=async(url,init)=>{expect(init.method).not.toBe('POST');queries++;expect(url).toBe('https://www.v6k.top/v1/videos/accepted_bb_before_removal');return Response.json({id:'accepted_bb_before_removal',status:'completed'});};
    clock+=120_000;resumeSpecificationTasks();resumeSpecificationTasks();
    await vi.waitFor(()=>expect(latest().status).toBe('completed'));
    expect(posts).toBe(1);expect(queries).toBe(2);expect(latest().cost).toBe(4);expect(balance()).toBe(96);
    expect(JSON.parse(latest().metadata)).toMatchObject({videoId:'accepted_bb_before_removal',upstreamModel:'BBseadanco-720'});
  }finally{time.mockRestore();}
});

describe('full multimodal 720P entry',()=>{
  async function legacyEntry() {
    await syncV6kEntries([FULL_UPSTREAM]);
    const channelId=db.select().from(channels).get()!.id,spec=getModelSpecification(FULL)!;
    const limits={...v6kFull720Limits(),maxVideos:0,maxAudios:0};
    saveModelSpecification({...spec,enabled:true,limits,routes:spec.routes.map(r=>({...r,upstreamModel:OLD_FULL,limits,cost:4.5,costUnit:'per_call',priority:7}))});
    const c=db.select().from(channels).get()!;
    ChannelService.updateChannel(channelId,{modelMapping:{...JSON.parse(c.modelMapping),[FULL]:OLD_FULL}});
    db.update(models).set({isActive:1,description:V6K_FULL_720_LEGACY_DESCRIPTION}).where(eq(models.modelId,FULL)).run();
    return channelId;
  }
  async function install(){
    await syncV6kEntries([FULL_UPSTREAM]);
    await enableV6kFull720Entry(sqlite,db.select().from(channels).get()!.id);
    sqlite.prepare("INSERT INTO api_tokens(id,user_id,token_key,balance) VALUES(1,1,'test',-1)").run();
  }
  it('registers a disabled independent public entry at 5.8 per task without importing the retired image-only model',async()=>{
    ensureV6kFull720Model(sqlite);
    const result=await syncV6kEntries([FULL_UPSTREAM,OLD_FULL]);
    expect(result.models).toEqual([FULL]);
    expect(getModelSpecification(FULL)).toMatchObject({enabled:false,limits:v6kFull720Limits(),routes:[{executionModel:FULL,upstreamModel:FULL_UPSTREAM,enabled:true}]});
    const row=db.select().from(models).all().find(m=>m.modelId===FULL)!;
    expect(row).toMatchObject({isActive:0,displayName:FULL,description:V6K_FULL_720_DESCRIPTION});
    expect(db.select().from(models).all().some(m=>m.modelId.includes('稳定极速'))).toBe(false);
    expect(PricingService.quote(FULL,{resolution:'720p',seconds:30,count:1}).cost).toBe(5.8);
    expect(balance()).toBe(100);expect(db.select().from(contents).all()).toEqual([]);
  });
  it.each([V6K_FULL_720_LEGACY_DESCRIPTION,'管理员自定义描述'])('replaces only the authorized old binding while preserving price, switches and orders: %s',async description=>{
    await legacyEntry();const old=getModelSpecification(FULL)!;
    saveModelSpecification({...old,enabled:false,routes:old.routes.map(r=>({...r,enabled:false}))});
    db.update(models).set({isActive:0,displayName:'管理员名称',description}).where(eq(models.modelId,FULL)).run();
    db.update(modelPricing).set({inputPrice:6,extraParams:'{"720P":6.2}'}).where(eq(modelPricing.modelPattern,FULL)).run();
    db.insert(contents).values({userId:1,type:'video',modelId:FULL,status:'queued',cost:5.8,metadata:JSON.stringify({videoId:'old_image_task',upstreamModel:OLD_FULL,pricingSnapshot:{inputPrice:5.8},billingStatus:'reserved'})}).run();
    const tasks=JSON.stringify(db.select().from(contents).all()),prices=JSON.stringify(db.select().from(modelPricing).all());
    await syncV6kEntries([FULL_UPSTREAM,OLD_FULL]);
    expect(getModelSpecification(FULL)).toMatchObject({enabled:false,limits:v6kFull720Limits(),routes:[{...old.routes[0],enabled:false,upstreamModel:FULL_UPSTREAM,limits:v6kFull720Limits()}]});
    expect(db.select().from(models).all().find(m=>m.modelId===FULL)).toMatchObject({isActive:0,displayName:'管理员名称',description:description===V6K_FULL_720_LEGACY_DESCRIPTION?V6K_FULL_720_DESCRIPTION:description});
    expect(JSON.parse(db.select().from(channels).get()!.modelMapping)[FULL]).toBe(FULL_UPSTREAM);
    expect(JSON.stringify(db.select().from(contents).all())).toBe(tasks);expect(JSON.stringify(db.select().from(modelPricing).all())).toBe(prices);expect(balance()).toBe(100);
    const before=syncConfiguration();await syncV6kEntries([FULL_UPSTREAM,OLD_FULL]);expect(syncConfiguration()).toEqual(before);
  });
  it('does not replace a legacy configuration without exact model permission or overwrite a custom mapping',async()=>{
    const channelId=await legacyEntry(),before=syncConfiguration();
    upstream=async()=>Response.json({data:[{id:OLD_FULL}]});
    await expect(enableV6kFull720Entry(sqlite,channelId)).rejects.toThrow('未开放');expect(syncConfiguration()).toEqual(before);
    const c=db.select().from(channels).get()!;ChannelService.updateChannel(channelId,{modelMapping:{...JSON.parse(c.modelMapping),[FULL]:'administrator-other-model'}});
    const customized=syncConfiguration();upstream=async()=>Response.json({data:[{id:FULL_UPSTREAM}]});
    await expect(enableV6kFull720Entry(sqlite,channelId)).rejects.toThrow('其他上游');expect(syncConfiguration()).toEqual(customized);expect(balance()).toBe(100);
  });
  it.each(['completed','failed'])('recovers the accepted image-only original to %s after startup pruning and replacement, without reposting or repricing',async terminal=>{
    const channelId=await legacyEntry();let posts=0,queries=0,clock=Date.now();const time=vi.spyOn(Date,'now').mockImplementation(()=>clock);
    try{
      upstream=async(url,init)=>{if(init.method==='POST'){posts++;expect(JSON.parse(init.body).model).toBe(OLD_FULL);return Response.json({id:'legacy_full_original',status:'queued'});}queries++;clock+=2*60*60_000+1;return Response.json({id:'legacy_full_original',status:'unknown'});};
      await(await post('/api/video/generate',{model:FULL,prompt:'accepted before upgrade',seconds:30,resolution:'720p'})).text();
      await vi.waitFor(()=>expect(Number(JSON.parse(latest().metadata).v6kQueryResumeAt)).toBeGreaterThan(clock));
      const original=latest(),receipt=findVideoSubmissionReceipt(original.id),m=JSON.parse(original.metadata),reservation=sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(m.billingReservationId),balanceBefore=balance();
      pruneUnapprovedV6kBindings(sqlite);expect(getModelSpecification(FULL)!.routes).toEqual([]);
      upstream=async(url,init)=>{expect(init.method).not.toBe('POST');if(url.endsWith('/v1/models'))return Response.json({data:[{id:FULL_UPSTREAM}]});queries++;expect(url).toBe('https://www.v6k.top/v1/videos/legacy_full_original');return Response.json({id:'legacy_full_original',status:terminal,error:terminal==='failed'?{message:'original failed'}:undefined});};
      await enableV6kFull720Entry(sqlite,channelId);
      expect(getModelSpecification(FULL)).toMatchObject({enabled:true,limits:v6kFull720Limits(),routes:[{enabled:true,upstreamModel:FULL_UPSTREAM,limits:v6kFull720Limits()}]});
      expect(latest()).toEqual(original);expect(findVideoSubmissionReceipt(original.id)).toEqual(receipt);expect(sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(m.billingReservationId)).toEqual(reservation);expect(balance()).toBe(balanceBefore);
      clock+=120_000;resumeSpecificationTasks();resumeSpecificationTasks();await vi.waitFor(()=>expect(latest().status).toBe(terminal));resumeSpecificationTasks();
      expect(posts).toBe(1);expect(queries).toBe(2);expect(balance()).toBeCloseTo(terminal==='completed'?94.2:100);
      expect(JSON.parse(latest().metadata)).toMatchObject({videoId:'legacy_full_original',upstreamModel:OLD_FULL,pricingSnapshot:m.pricingSnapshot});
      expect(sqlite.prepare('SELECT count(*) AS n FROM billing_reservations').get()).toMatchObject({n:1});
    }finally{time.mockRestore();}
  });
  it('enables only after an authenticated GET, preserves KK/WD and existing tasks, and keeps administrator edits across sync',async()=>{
    await syncV6kEntries([FULL_UPSTREAM,STABLE,'kkseadanco2.5']);
    const channelId=db.select().from(channels).get()!.id;
    upstream=async(url,init)=>{expect(url).toBe('https://www.v6k.top/v1/models');expect(init.method).not.toBe('POST');expect(init.headers.Authorization).toBe('Bearer test-key');return Response.json({data:[{id:FULL_UPSTREAM},{id:STABLE},{id:'kkseadanco2.5'}]});};
    await saveKkVideoRouting('kkseadanco2.5',{primary:'stable',fallback:true,channelId},getKkVideoRouting('kkseadanco2.5').version);
    db.insert(contents).values({userId:1,type:'video',modelId:WD,cost:6.5,status:'processing',metadata:JSON.stringify({channelId,videoId:'existing_wd_receipt',upstreamModel:STABLE,billingStatus:'reserved',pricingSnapshot:{inputPrice:6.5}})}).run();
    const tasks=JSON.stringify(db.select().from(contents).all()),others=JSON.stringify([getModelSpecification(WD),getModelSpecification('kkseadanco2.5')]);
    expect(await enableV6kFull720Entry(sqlite,channelId)).toMatchObject({model:FULL,upstreamModel:FULL_UPSTREAM,modelEnabled:true,specEnabled:true,routeEnabled:true,limits:v6kFull720Limits(),description:V6K_FULL_720_DESCRIPTION,pricing:{billing_type:'per_call',input_price:5.8}});
    expect(JSON.stringify(db.select().from(contents).all())).toBe(tasks);expect(JSON.stringify([getModelSpecification(WD),getModelSpecification('kkseadanco2.5')])).toBe(others);expect(balance()).toBe(100);
    const saved=getModelSpecification(FULL)!;saveModelSpecification({...saved,enabled:false,routes:saved.routes.map(r=>({...r,enabled:false,cost:4.25,costUnit:'per_call'}))});
    db.update(models).set({isActive:0,description:'管理员描述'}).where(eq(models.modelId,FULL)).run();db.update(modelPricing).set({inputPrice:6,extraParams:'{"720P":6.2}'}).where(eq(modelPricing.modelPattern,FULL)).run();
    const before=syncConfiguration();await syncV6kEntries([FULL_UPSTREAM,STABLE,'kkseadanco2.5']);ensureV6kFull720Model(sqlite);pruneUnapprovedV6kBindings(sqlite);expect(syncConfiguration()).toEqual(before);
  });
  it('does not enable or bind without exact authorization or after a channel configuration race',async()=>{
    await syncV6kEntries([FULL_UPSTREAM]);const channelId=db.select().from(channels).get()!.id,before=syncConfiguration();
    upstream=async()=>Response.json({data:[{id:OLD_FULL}]});await expect(enableV6kFull720Entry(sqlite,channelId)).rejects.toThrow('未开放');expect(syncConfiguration()).toEqual(before);
    upstream=async()=>{ChannelService.updateChannel(channelId,{apiKey:'changed-key'});return Response.json({data:[{id:FULL_UPSTREAM}]});};
    await expect(enableV6kFull720Entry(sqlite,channelId)).rejects.toThrow('配置已变化');expect(getModelSpecification(FULL)!.enabled).toBe(false);expect(balance()).toBe(100);
  });
  it('exposes the requested name, full description, multimodal limits and 5.8 per-call price on website and API catalogs',async()=>{
    await install();const list=await(await nativeFetch(origin+'/api/video/models')).json() as any[];
    expect(list.find(m=>m.id===FULL)).toMatchObject({id:FULL,name:FULL,description:V6K_FULL_720_DESCRIPTION,available:true,billingType:'per_call',rates:{'720p':5.8},routingLimits:{maxImages:30,maxVideos:10,maxAudios:10,resolutions:['720p'],duration:{min:5,max:30,step:1}}});
    expect(getPublicDeveloperModels().items.find(m=>m.id===FULL)).toMatchObject({id:FULL,name:FULL,description:V6K_FULL_720_DESCRIPTION,available:true,limits:{maxImages:30,maxVideos:10,maxAudios:10},pricing:{billing_type:'per_call',unit:'request',unit_price:5.8}});
    for(const seconds of [5,30])expect(quoteVideoRequest({model:FULL,resolution:'720p',seconds},1)).toMatchObject({model:FULL,billingType:'per_call',cost:5.8});
  });
  it.each(['/api/video/generate','/v1/videos'])('sends all 30 images, 10 videos and 10 audios to the exact upstream, retaining a flat 5.8 price at %s',async endpoint=>{
    await install();vi.stubEnv('BACKEND_URL','https://app.example');let posts=0;
    upstream=async(url,init)=>{posts++;expect(url).toBe('https://www.v6k.top/v1/videos');expect(init.headers.Authorization).toBe('Bearer test-key');const q=JSON.parse(init.body);expect(q).toMatchObject({model:FULL_UPSTREAM,resolution:'720p'});expect(q.images).toHaveLength(30);expect(q.videos).toEqual(Array(10).fill('https://media.example/ref.mp4'));expect(q.audios).toEqual(Array(10).fill('https://media.example/ref.mp3'));return Response.json({id:'full_30_image_'+posts,status:'completed'});};
    for(const seconds of [5,30]){await(await post(endpoint,{model:FULL,prompt:'full multimodal',seconds,resolution:'720p',reference_images:Array(30).fill(reference),reference_videos:Array(10).fill('https://media.example/ref.mp4'),audio_urls:Array(10).fill('https://media.example/ref.mp3')})).text();await vi.waitFor(()=>expect(latest().status).toBe('completed'));expect(latest().modelId).toBe(FULL);expect(latest().cost).toBe(5.8);expect(JSON.parse(latest().metadata)).toMatchObject({upstreamModel:FULL_UPSTREAM,videoId:'full_30_image_'+posts});}
    expect(posts).toBe(2);expect(balance()).toBeCloseTo(88.4);resumeSpecificationTasks();resumeSpecificationTasks();expect(posts).toBe(2);
  });
  it.each(['/api/video/generate','/v1/videos'])('rejects excess counts, conflicting material aliases and unsupported inputs before charging at %s',async endpoint=>{
    await install();vi.mocked(fetch).mockClear();upstream=async()=>{throw Error('unexpected generation');};
    const invalid=[{resolution:'480p'},{resolution:'1080p'},{seconds:4},{seconds:31},{seconds:5.5},{seconds:30,duration:5},{reference_images:Array(31).fill(reference)},{image_refs:Array(31).fill(reference)},{reference_image_urls:Array(31).fill(reference)},{content:[{type:'video_url',video_url:{url:'https://media.example/v.mp4'}}]},{first_image:reference},{start_frame:reference}];
    for(const field of ['videos','video','reference_videos','reference_video','video_urls','video_url','video_refs','reference_video_urls','audios','audio','reference_audios','reference_audio','audio_urls','audio_url','audio_refs','reference_audio_urls'])invalid.push({[field]:Array(11).fill('https://media.example/ref.mp4')} as any);
    invalid.push({videos:['https://media.example/a.mp4'],video_refs:['https://media.example/b.mp4']} as any,{audios:['https://media.example/a.mp3'],audio_refs:['https://media.example/b.mp3']} as any,{videos:{url:'https://media.example/a.mp4'}} as any);
    for(const patch of invalid){const response=await post(endpoint,{model:FULL,prompt:'invalid material',seconds:5,resolution:'720p',...patch});expect(response.status).toBe(400);await response.text();}
    expect(fetch).not.toHaveBeenCalled();expect(balance()).toBe(100);expect(db.select().from(contents).all()).toEqual([]);
  });
  it.each(['/api/video/generate','/v1/videos'])('preserves supported video/audio aliases and duration_seconds at %s',async endpoint=>{
    await install();let posts=0;const video='https://media.example/v.mp4',audio='https://media.example/a.mp3';
    upstream=async(_url,init)=>{posts++;expect(JSON.parse(init.body)).toMatchObject({model:FULL_UPSTREAM,seconds:30,videos:[video],audios:[audio]});return Response.json({id:'full_alias_'+posts,status:'completed'});};
    const videos=['videos','video','reference_videos','reference_video','video_urls','video_url','video_refs','reference_video_urls'],audios=['audios','audio','reference_audios','reference_audio','audio_urls','audio_url','audio_refs','reference_audio_urls'];
    for(let i=0;i<videos.length;i++){
      await(await post(endpoint,{model:FULL,prompt:'alias '+i,duration_seconds:30,resolution:'720p',[videos[i]]:i===0?JSON.stringify([video]):[video],[audios[i]]:[audio]})).text();
      await vi.waitFor(()=>expect(latest().status).toBe('completed'));expect(latest().cost).toBe(5.8);
    }
    expect(posts).toBe(8);expect(balance()).toBeCloseTo(53.6);
  });
  it.each(['400','401','429','503','504','failed'])('settles %s safely and returns the original API request on retry without new generation',async outcome=>{
    await install();let posts=0;upstream=async(_url,init)=>{posts++;expect(JSON.parse(init.body).model).toBe(FULL_UPSTREAM);return outcome==='failed'?Response.json({id:'full_failed_original',status:'failed',error:{message:'generation failed'}}):Response.json({error:{code:'test_error',message:'specific upstream error'}},{status:Number(outcome)});};
    const body={model:FULL,prompt:'original request',seconds:30,resolution:'720p'},key='full-stable';const first=await(await retryVideo('/v1/videos',body,key)).json() as any;
    const uncertain=['503','504'].includes(outcome);await vi.waitFor(()=>expect(JSON.parse(latest().metadata).billingStatus).toBe(uncertain?'review':'refunded'));
    const again=await(await retryVideo('/v1/video/generations',body,key)).json() as any;expect(again.id).toBe(first.id);resumeSpecificationTasks();resumeSpecificationTasks();expect(posts).toBe(1);expect(balance()).toBeCloseTo(uncertain?94.2:100);
    expect(db.select().from(contents).all()).toHaveLength(1);expect(sqlite.prepare('SELECT count(*) AS n FROM billing_reservations').get()).toMatchObject({n:1});
    if(outcome==='failed')expect(JSON.parse(latest().metadata).videoId).toBe('full_failed_original');
  });
  it.each(['completed','failed'])('continues the original unknown task through a query failure until %s',async status=>{
    await install();let posts=0,queries=0;upstream=async(url,init)=>{if(init.method==='POST'){posts++;return Response.json({id:'full_unknown_original',status:'unknown'});}expect(url).toContain('/v1/videos/full_unknown_original');if(++queries===1)return Response.json({error:{code:'busy',message:'query error'}},{status:503});return Response.json({id:'full_unknown_original',status,error:status==='failed'?{message:'original failed'}:undefined});};
    await(await post('/api/video/generate',{model:FULL,prompt:'unknown original',seconds:5,resolution:'720p'})).text();expect(latest().status).toBe(status);expect(posts).toBe(1);expect(queries).toBe(2);expect(balance()).toBeCloseTo(status==='completed'?94.2:100);resumeSpecificationTasks();expect(posts).toBe(1);
  });
  it('uses the batch queue with one 5.8 prepayment and preserves the requested public model ID',async()=>{
    await install();vi.stubEnv('BACKEND_URL','https://app.example');let posts=0;
    const images=Array(30).fill(reference),videos=Array(10).fill('https://media.example/batch.mp4'),audios=Array(10).fill('https://media.example/batch.mp3');
    const batchId=batchStore.create(1,crypto.randomUUID(),{name:'full multimodal batch',model:FULL,resolution:'720p',aspect_ratio:'16:9',video_length:30,autoRetry:false,maxRetries:0,creatives:[{prompt:'full batch',count:1,reference_images:images,reference_videos:videos,audio_urls:audios}]},5.8,'https://app.example'),item=batchStore.detail(batchId,1).items[0];
    upstream=async(url,init)=>{if(url==='http://127.0.0.1:9876/api/video/generate')return nativeFetch(origin+'/api/video/generate',init);posts++;const payload=JSON.parse(init.body);expect(payload).toMatchObject({model:FULL_UPSTREAM,seconds:30,resolution:'720p',videos,audios});expect(payload.images).toHaveLength(30);return Response.json({id:'full_batch_original',status:'completed'});};
    tickVideoBatches();await vi.waitFor(()=>expect(latest()?.status).toBe('completed'));tickVideoBatches();tickVideoBatches();resumeSpecificationTasks();expect(batchStore.item(item.id)).toMatchObject({status:'completed',billing_state:'charged',charged:5.8});expect(latest().modelId).toBe(FULL);expect(balance()).toBeCloseTo(94.2);expect(posts).toBe(1);
  });
});

describe('V6K admin model configuration', () => {
  const replacement = '运营配置的新模型';
  const admin = (channelId: number, path = '', method = 'GET', body?: unknown, token = 'test-admin') =>
    nativeFetch(origin + '/api/admin/channels/' + channelId + '/v6k-models' + path, {
      method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const replacementDraft = (configuration: V6kModelConfiguration): V6kModelDraft => ({
    modelId: configuration.modelId, displayName: '新的显示名称', upstreamModel: replacement,
    enabled: configuration.enabled, routeEnabled: configuration.routeEnabled,
    limits: { ...configuration.limits, resolutions: ['1080p'], ratios: ['9:16', '16:9'], defaultSeconds: 15,
      duration: { mode: 'options', min: 10, max: 15, step: 1, values: [10, 15] }, maxVideos: 1, maxAudios: 1 },
  });

  async function install() {
    await syncV6kEntries([STABLE]);
    const channelId = db.select().from(channels).get()!.id;
    await enableV6kStable720Entry(sqlite, channelId);
    sqlite.prepare("INSERT INTO api_tokens(id,user_id,token_key,balance) VALUES(1,1,'test',-1)").run();
    const response = await admin(channelId);
    expect(response.status).toBe(200);
    const configurations: V6kModelConfiguration[] = await response.json();
    return { channelId, configuration: configurations.find(item => item.modelId === WD)! };
  }

  it('previews the real wire body without touching the provider or billing and saves only an authorized exact ID', async () => {
    const { channelId, configuration } = await install(), draft = replacementDraft(configuration);
    vi.mocked(fetch).mockClear();
    const before = syncConfiguration();
    expect((await admin(channelId, '', 'GET', undefined, 'test')).status).toBe(403);
    const preview = await admin(channelId, '/preview', 'POST', { draft, sample: { videos: 1, audios: 1 } });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual({ method: 'POST', path: '/v1/videos', body: {
      model: replacement, prompt: '请求体预览示例', seconds: 15, ratio: '9:16', resolution: '1080p',
      videos: ['https://example.invalid/video-1.mp4'], audios: ['https://example.invalid/audio-1.mp3'],
    } });
    expect((await admin(channelId, '/preview', 'POST', { draft, sample: { videos: 2 } })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(syncConfiguration()).toEqual(before);

    upstream = async (url, init) => {
      expect(url).toBe('https://www.v6k.top/v1/models');
      expect(init.method).not.toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer test-key');
      return Response.json({ data: [{ id: replacement + '-extra' }] });
    };
    expect((await admin(channelId, '', 'PUT', { draft, version: configuration.version })).status).toBe(409);
    expect(syncConfiguration()).toEqual(before);
    upstream = async () => Response.json({ data: [{ id: replacement }] });
    const saved = await admin(channelId, '', 'PUT', { draft, version: configuration.version });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject(draft);
    expect((await admin(channelId, '', 'PUT', { draft, version: configuration.version })).status).toBe(409);
    expect(getModelSpecification(WD)).toMatchObject({ enabled: true, limits: draft.limits, routes: [
      { id: JSON.parse((before.specifications as any).value).find((item: any) => item.modelId === WD).routes[0].id,
        executionModel: WD, upstreamModel: replacement, channelId, limits: draft.limits },
    ] });
    expect(db.select().from(modelPricing).all()).toEqual(before.prices);
    expect(balance()).toBe(100);
  });

  it('creates an explicitly selected disabled model and keeps manual mappings during sync and startup pruning', async () => {
    const { channelId, configuration } = await install();
    const draft = replacementDraft(configuration);
    upstream = async () => Response.json({ data: [{ id: replacement }, { id: STABLE }, { id: 'unrequested' }] });
    expect((await admin(channelId, '', 'PUT', { draft, version: configuration.version })).status).toBe(200);
    const newId = 'ops-video';
    expect((await admin(channelId, '', 'PUT', { draft: { ...draft, modelId: newId }, version: null })).status).toBe(200);
    expect(db.select().from(models).where(eq(models.modelId, newId)).get()).toMatchObject({ isActive: 0 });
    expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern, newId)).get()).toBeUndefined();
    const snapshot = syncConfiguration();
    expect((await ChannelService.syncModels(channelId)).models).toEqual(expect.arrayContaining([WD, newId]));
    expect(pruneUnapprovedV6kBindings(sqlite, channelId)).toEqual({ removedBindings: 0, removedRoutes: 0 });
    expect(syncConfiguration()).toEqual(snapshot);
    expect(getModelSpecification(WD)?.routes.map(route => route.upstreamModel)).toEqual([replacement]);
    expect(db.select().from(contents).all()).toEqual([]);
  });

  it('preserves a newer admin edit made during the model permission lookup', async () => {
    const { channelId, configuration } = await install(), draft = replacementDraft(configuration);
    upstream = async () => {
      const channel = ChannelService.getChannelRaw(channelId)!;
      const mapping = JSON.parse(channel.modelMapping);
      db.update(channels).set({ modelMapping: JSON.stringify({ ...mapping, [WD]: 'concurrent-change' }) })
        .where(eq(channels.id, channelId)).run();
      return Response.json({ data: [{ id: replacement }] });
    };
    const response = await admin(channelId, '', 'PUT', { draft, version: configuration.version });
    expect(response.status).toBe(409);
    expect(getModelSpecification(WD)?.routes[0].upstreamModel).toBe(STABLE);
    expect(JSON.parse(ChannelService.getChannelRaw(channelId)!.modelMapping)[WD]).toBe('concurrent-change');
    expect(balance()).toBe(100);
  });

  it('ends a scheduled old batch retry after replacement and releases its original prepayment once', async () => {
    const { channelId, configuration } = await install(), draft = replacementDraft(configuration);
    const batchId = batchStore.create(1, crypto.randomUUID(), { name: '旧线路待重试批次', model: WD, resolution: '720p',
      aspect_ratio: '16:9', video_length: 5, autoRetry: true, maxRetries: 3,
      creatives: [{ prompt: '旧任务', count: 1, reference_images: [], reference_videos: [], audio_urls: [] }],
    }, 6.5, 'https://app.example');
    const itemId = batchStore.detail(batchId, 1).items[0].id;
    let posts = 0;
    upstream = async (url, init) => {
      if (url === 'http://127.0.0.1:9876/api/video/generate') return nativeFetch(origin + '/api/video/generate', init);
      if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: replacement }] });
      expect(init.method).toBe('POST'); posts++;
      return Response.json({ id: 'old_failed_before_cutover', status: 'failed', error: { message: 'temporary server failure' } });
    };
    tickVideoBatches();
    await vi.waitFor(() => {
      tickVideoBatches();
      expect(batchStore.item(itemId)).toMatchObject({ status: 'retry_wait', billing_state: 'reserved' });
    });
    expect((await admin(channelId, '', 'PUT', { draft, version: configuration.version })).status).toBe(200);
    sqlite.prepare('UPDATE video_batch_items SET next_run=0 WHERE id=?').run(itemId);
    tickVideoBatches(); tickVideoBatches(); resumeSpecificationTasks();
    expect(batchStore.item(itemId)).toMatchObject({ status: 'failed', billing_state: 'refunded', attempts: 1 });
    expect(posts).toBe(1);
    expect(balance()).toBe(100);
  });

  it('rechecks queued batches before sending, submits compatible input once and refunds an incompatible item once', async () => {
    const { channelId, configuration } = await install();
    const draft = replacementDraft(configuration);
    draft.limits.resolutions = ['720p'];
    const create = (seconds: number) => {
      const batchId = batchStore.create(1, crypto.randomUUID(), { name: '换型前创建的批次', model: WD, resolution: '720p',
        aspect_ratio: '16:9', video_length: seconds, autoRetry: true, maxRetries: 3,
        creatives: [{ prompt: '预排队 ' + seconds, count: 1, reference_images: [], reference_videos: [], audio_urls: [] }],
      }, 6.5, 'https://app.example');
      return batchStore.detail(batchId, 1).items[0].id;
    };
    const compatible = create(10), incompatible = create(5);
    let posts = 0;
    upstream = async (url, init) => {
      if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: replacement }] });
      if (url === 'http://127.0.0.1:9876/api/video/generate') return nativeFetch(origin + '/api/video/generate', init);
      expect(init.method).toBe('POST'); posts++;
      expect(JSON.parse(init.body)).toMatchObject({ model: replacement, seconds: 10, resolution: '720p' });
      return Response.json({ id: 'cutover_batch_original', status: 'completed' });
    };
    expect((await admin(channelId, '', 'PUT', { draft, version: configuration.version })).status).toBe(200);
    tickVideoBatches(); tickVideoBatches();
    await vi.waitFor(() => {
      tickVideoBatches();
      expect(batchStore.item(compatible)).toMatchObject({ status: 'completed', billing_state: 'charged', charged: 6.5 });
      expect(batchStore.item(incompatible)).toMatchObject({ status: 'failed', billing_state: 'refunded', charged: 0 });
    });
    tickVideoBatches(); resumeSpecificationTasks(); tickVideoBatches();
    expect(posts).toBe(1);
    expect(balance()).toBeCloseTo(93.5);
  });

  it('refunds a failed accepted batch after switching with automatic retries enabled', async () => {
    const { channelId, configuration } = await install(), draft = replacementDraft(configuration);
    const batchId = batchStore.create(1, crypto.randomUUID(), { name: '换型前已接单的批次', model: WD, resolution: '720p',
      aspect_ratio: '16:9', video_length: 5, autoRetry: true, maxRetries: 3,
      creatives: [{ prompt: '原批次', count: 1, reference_images: [], reference_videos: [], audio_urls: [] }],
    }, 6.5, 'https://app.example');
    const item = batchStore.detail(batchId, 1).items[0];
    let posts = 0, clock = Date.now(), failed = false;
    const time = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    upstream = async (url, init) => {
      if (url === 'http://127.0.0.1:9876/api/video/generate') return nativeFetch(origin + '/api/video/generate', init);
      if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: replacement }] });
      if (init.method === 'POST') {
        posts++;
        expect(JSON.parse(init.body).model).toBe(STABLE);
        return Response.json({ id: 'original_batch_task', status: 'queued' });
      }
      expect(url).toBe('https://www.v6k.top/v1/videos/original_batch_task');
      if (!failed) {
        clock += 2 * 60 * 60_000 + 1;
        return Response.json({ id: 'original_batch_task', status: 'unknown' });
      }
      return Response.json({ id: 'original_batch_task', status: 'failed', error: { message: 'temporary generation failure' } });
    };
    try {
      tickVideoBatches();
      await vi.waitFor(() => expect(Number(JSON.parse(latest().metadata).v6kQueryResumeAt)).toBeGreaterThan(clock));
      expect((await admin(channelId, '', 'PUT', { draft, version: configuration.version })).status).toBe(200);
      failed = true;
      clock += 120_000;
      resumeSpecificationTasks();
      await vi.waitFor(() => {
        tickVideoBatches();
        expect(batchStore.item(item.id)).toMatchObject({ status: 'failed', billing_state: 'refunded', attempts: 1 });
      });
      tickVideoBatches(); resumeSpecificationTasks();
      expect(posts).toBe(1);
      expect(balance()).toBeCloseTo(100);
    } finally {
      time.mockRestore();
    }
  });

  it('keeps a prior unknown submission held across a switch and returns it to a retry', async () => {
    const { channelId, configuration } = await install(), draft = replacementDraft(configuration);
    let posts = 0;
    upstream = async (url, init) => {
      if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: replacement }] });
      expect(init.method).toBe('POST'); posts++;
      expect(JSON.parse(init.body).model).toBe(STABLE);
      return Response.json({ error: { code: 'service_unavailable', message: 'temporary upstream error' } }, { status: 503 });
    };
    const body = { model: WD, prompt: '提交结果未知', seconds: 5, resolution: '720p' };
    const first = await (await retryVideo('/v1/videos', body, 'unknown-cutover')).json() as any;
    await vi.waitFor(() => expect(JSON.parse(latest().metadata).billingStatus).toBe('review'));
    const original = latest();
    expect((await admin(channelId, '', 'PUT', { draft, version: configuration.version })).status).toBe(200);
    resumeSpecificationTasks(); resumeSpecificationTasks();
    const again = await (await retryVideo('/v1/videos', body, 'unknown-cutover')).json() as any;
    expect(again.id).toBe(first.id);
    expect(posts).toBe(1);
    expect(latest()).toEqual(original);
    expect(balance()).toBeCloseTo(93.5);
  });

  it.each(['completed', 'failed'])('finishes the accepted original to %s after changing the upstream, with one settlement and no replay', async terminal => {
    const { channelId, configuration } = await install(), draft = replacementDraft(configuration);
    const submissions: any[] = [], queried: string[] = [];
    let clock = Date.now(), oldStatus = 'unknown';
    const time = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    upstream = async (url, init) => {
      if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: replacement }, { id: STABLE }] });
      if (init.method === 'POST') {
        const payload = JSON.parse(init.body); submissions.push(payload);
        const old = payload.model === STABLE;
        return Response.json({ id: old ? 'original_before_cutover' : 'new_after_cutover_' + submissions.length, status: old ? 'queued' : 'completed' });
      }
      queried.push(url);
      expect(url).toBe('https://www.v6k.top/v1/videos/original_before_cutover');
      if (oldStatus === 'unknown') clock += 2 * 60 * 60_000 + 1;
      return Response.json({ id: 'original_before_cutover', status: oldStatus,
        error: oldStatus === 'failed' ? { code: 'failed', message: 'original failed' } : undefined });
    };
    try {
      const oldRequest = { model: WD, prompt: '换型前任务', seconds: 5, resolution: '720p' };
      const first = await (await retryVideo('/v1/videos', oldRequest, 'cutover-original')).json() as any;
      await vi.waitFor(() => expect(Number(JSON.parse(latest().metadata).v6kQueryResumeAt)).toBeGreaterThan(clock));
      const original = latest(), receipt = findVideoSubmissionReceipt(original.id);
      expect(receipt?.upstreamTaskId).toBe('original_before_cutover');
      expect((await admin(channelId, '', 'PUT', { draft, version: configuration.version })).status).toBe(200);
      expect(latest()).toEqual(original);
      const retry = await (await retryVideo('/v1/videos', oldRequest, 'cutover-original')).json() as any;
      expect(retry.id).toBe(first.id);
      expect(submissions).toHaveLength(1);

      const websiteModels: any[] = await (await nativeFetch(origin + '/api/video/models')).json();
      expect(websiteModels.find(item => item.id === WD)).toMatchObject({ name: draft.displayName, available: true,
        routingLimits: { resolutions: ['1080p'], defaultSeconds: 15, maxVideos: 1 } });
      expect(getPublicDeveloperModels().items.find(item => item.id === WD)).toMatchObject({ available: true,
        limits: { resolutions: ['1080p'], maxVideos: 1 } });
      const media = 'https://media.example/ref.mp4';
      for (const endpoint of ['/api/video/generate', '/v1/videos']) {
        const response = await post(endpoint, { model: WD, prompt: '新任务 ' + endpoint, videos: [media] });
        expect(response.status).toBe(200);
        await response.text();
        await vi.waitFor(() => expect(latest().status).toBe('completed'));
        expect(latest()).toMatchObject({ modelId: WD, cost: 6.5 });
      }
      expect(submissions.slice(1)).toEqual([
        { model: replacement, prompt: '新任务 /api/video/generate', seconds: 15, ratio: '9:16', resolution: '1080p', videos: [media] },
        { model: replacement, prompt: '新任务 /v1/videos', seconds: 15, ratio: '9:16', resolution: '1080p', videos: [media] },
      ]);
      oldStatus = terminal;
      clock += 120_000;
      resumeSpecificationTasks(); resumeSpecificationTasks();
      await vi.waitFor(() => expect(db.select().from(contents).where(eq(contents.id, original.id)).get()?.status).toBe(terminal));
      resumeSpecificationTasks();
      const order = db.select().from(contents).where(eq(contents.id, original.id)).get()!;
      expect(JSON.parse(order.metadata)).toMatchObject({ upstreamModel: STABLE, videoId: 'original_before_cutover',
        billingStatus: terminal === 'completed' ? 'settled' : 'refunded' });
      expect(findVideoSubmissionReceipt(original.id)).toEqual(receipt);
      expect(queried).toHaveLength(2);
      expect(submissions).toHaveLength(3);
      expect(balance()).toBeCloseTo(terminal === 'completed' ? 80.5 : 87);
      expect(sqlite.prepare('SELECT count(*) AS n FROM billing_reservations').get()).toEqual({ n: 3 });
    } finally { time.mockRestore(); }
  });
});

describe('independent stable 720P public entry',()=>{
  async function install(){
    await syncV6kEntries([STABLE]);
    await enableV6kStable720Entry(sqlite,db.select().from(channels).get()!.id);
    sqlite.prepare("INSERT INTO api_tokens(id,user_id,token_key,balance) VALUES(1,1,'test',-1)").run();
  }
  it('seeds disabled, then syncs only the exact upstream into the unprefixed public ID and price',async()=>{
    ensureV6kStable720Model(sqlite);
    expect(db.select().from(models).all().find(m=>m.modelId===WD)).toMatchObject({isActive:0});
    expect(getModelSpecification(WD)).toMatchObject({enabled:false,routes:[],limits:v6kStable720Limits()});
    const result=await syncV6kEntries([STABLE,'unrequested-video']);
    expect(result.models).toEqual([WD]);
    const c=db.select().from(channels).get()!;
    expect(JSON.parse(c.modelMapping)[WD]).toBe(STABLE);expect(JSON.parse(c.supportedModels)).toContain(WD);
    expect(getModelSpecification(WD)).toMatchObject({enabled:false,routes:[{executionModel:WD,upstreamModel:STABLE,enabled:true}]});
    expect(db.select().from(models).all().some(m=>m.modelId.includes('稳定'))).toBe(false);
    expect(PricingService.quote(WD,{resolution:'720p',seconds:30,count:1}).cost).toBe(6.5);
    expect(balance()).toBe(100);expect(db.select().from(contents).all()).toEqual([]);
  });
  it('activates only after an authenticated GET and leaves KK policy, historical tasks and balances intact',async()=>{
    await syncV6kEntries(['kkseadanco2.5',STABLE]);
    const channelId=db.select().from(channels).get()!.id;
    upstream=async(url,init)=>{expect(url).toBe('https://www.v6k.top/v1/models');expect(init.method).not.toBe('POST');expect(init.headers.Authorization).toBe('Bearer test-key');return Response.json({data:[{id:STABLE},{id:'kkseadanco2.5'}]});};
    await saveKkVideoRouting('kkseadanco2.5',{primary:'stable',fallback:true,channelId},getKkVideoRouting('kkseadanco2.5').version);
    db.insert(contents).values({userId:1,type:'video',modelId:'kkseadanco2.5',cost:6.5,status:'processing',metadata:JSON.stringify({channelId,videoId:'existing_stable_receipt',upstreamModel:STABLE,billingStatus:'reserved',pricingSnapshot:{inputPrice:6.5}})}).run();
    const before=JSON.stringify(db.select().from(contents).all()),kk=JSON.stringify(getModelSpecification('kkseadanco2.5'));
    const result=await enableV6kStable720Entry(sqlite,channelId);
    expect(result).toMatchObject({model:WD,upstreamModel:STABLE,modelEnabled:true,specEnabled:true,routeEnabled:true,pricing:{billing_type:'per_call',input_price:6.5}});
    expect(JSON.stringify(getModelSpecification('kkseadanco2.5'))).toBe(kk);expect(JSON.stringify(db.select().from(contents).all())).toBe(before);expect(balance()).toBe(100);
    const saved=getModelSpecification(WD)!;saveModelSpecification({...saved,enabled:false,routes:saved.routes.map(r=>({...r,enabled:false}))});
    db.update(models).set({isActive:0}).where(eq(models.modelId,WD)).run();db.update(modelPricing).set({inputPrice:7.5,extraParams:'{"720P":8}'}).where(eq(modelPricing.modelPattern,WD)).run();
    const snapshot=syncConfiguration();await syncV6kEntries([STABLE,'kkseadanco2.5']);ensureV6kStable720Model(sqlite);pruneUnapprovedV6kBindings(sqlite);
    expect(syncConfiguration()).toEqual(snapshot);
  });
  it('does not change data when stable permission is missing or the channel changes during the GET',async()=>{
    await syncV6kEntries([STABLE]);const channelId=db.select().from(channels).get()!.id,before=syncConfiguration();
    upstream=async()=>Response.json({data:[{id:'kkseadanco2.5'}]});
    await expect(enableV6kStable720Entry(sqlite,channelId)).rejects.toThrow('未开放');expect(syncConfiguration()).toEqual(before);
    upstream=async()=>{ChannelService.updateChannel(channelId,{apiKey:'new-key'});return Response.json({data:[{id:STABLE}]});};
    await expect(enableV6kStable720Entry(sqlite,channelId)).rejects.toThrow('配置已变化');
    expect(getModelSpecification(WD)!.enabled).toBe(false);expect(balance()).toBe(100);expect(db.select().from(contents).all()).toEqual([]);
  });
  it('publishes matching website/API names, limits and per-task prices without combining the entry into KK',async()=>{
    await install();
    const list=await(await nativeFetch(origin+'/api/video/models')).json() as any[],item=list.find(x=>x.id===WD);
    expect(item).toMatchObject({id:WD,available:true,billingType:'per_call',rates:{'720p':6.5},routingLimits:{maxImages:30,maxAudios:10,maxVideos:10,resolutions:['720p'],duration:{min:5,max:30,step:1}}});
    expect(getPublicDeveloperModels().items.find(x=>x.id===WD)).toMatchObject({id:WD,available:true,endpoints:['/v1/videos'],pricing:{billing_type:'per_call',unit:'request',unit_price:6.5}});
    expect(quoteVideoRequest({model:WD,resolution:'720p',seconds:5},1)).toMatchObject({model:WD,cost:6.5,billingType:'per_call'});
    expect(quoteVideoRequest({model:WD,resolution:'720p',seconds:30},1)).toMatchObject({cost:6.5});
  });
  it.each(['/api/video/generate','/v1/videos'])('submits the real stable ID at 5 and 30 seconds without changing materials or the public ID at %s',async endpoint=>{
    await install();vi.stubEnv('BACKEND_URL','https://app.example');let posts=0;
    upstream=async(url,init)=>{posts++;expect(url).toBe('https://www.v6k.top/v1/videos');const q=JSON.parse(init.body);
      expect(q).toMatchObject({model:STABLE,resolution:'720p'});expect(q.images).toHaveLength(1);expect(q.videos).toHaveLength(10);expect(q.audios).toHaveLength(10);
      return Response.json({id:'stable_standalone_'+posts,status:'completed'});};
    for(const seconds of [5,30]){await(await post(endpoint,{model:WD,prompt:'stable entry',seconds,resolution:'720p',reference_images:[reference],reference_videos:Array(10).fill('https://media.example/v.mp4'),audio_urls:Array(10).fill('https://media.example/a.wav')})).text();await vi.waitFor(()=>expect(latest().status).toBe('completed'));expect(latest().modelId).toBe(WD);expect(latest().cost).toBe(6.5);expect(JSON.parse(latest().metadata)).toMatchObject({upstreamModel:STABLE,resolution:'720p'});}
    expect(posts).toBe(2);expect(balance()).toBe(87);resumeSpecificationTasks();expect(posts).toBe(2);
  });
  it.each(['rejected','failed','uncertain'])('returns the original order and settles %s only once, never using the KK backup',async outcome=>{
    await install();let posts=0;
    upstream=async(_url,init)=>{posts++;expect(JSON.parse(init.body).model).toBe(STABLE);if(outcome==='uncertain')return new Response('timeout',{status:504});if(outcome==='rejected')return Response.json({error:{code:'rate_limit_exceeded',message:'busy'}},{status:429});return Response.json({id:'stable_failed_receipt',status:'failed',error:{message:'original failed'}});};
    const body={model:WD,prompt:'one original',seconds:30,resolution:'720p'},key='stable-original';
    const first=await(await retryVideo('/v1/videos',body,key)).json() as any;
    await vi.waitFor(()=>expect(JSON.parse(latest().metadata).billingStatus).toBe(outcome==='uncertain'?'review':'refunded'));
    const again=await(await retryVideo('/v1/video/generations',body,key)).json() as any;expect(again.id).toBe(first.id);
    resumeSpecificationTasks();resumeSpecificationTasks();expect(posts).toBe(1);expect(balance()).toBe(outcome==='uncertain'?93.5:100);expect(db.select().from(contents).all()).toHaveLength(1);
    expect(sqlite.prepare('SELECT count(*) AS n FROM billing_reservations').get()).toMatchObject({n:1});
    if(outcome==='failed')expect(JSON.parse(latest().metadata).videoId).toBe('stable_failed_receipt');
  });
  it.each(['completed','failed'])('keeps the stable original ID through unknown state and a query error until %s',async status=>{
    await install();let posts=0,queries=0;
    upstream=async(url,init)=>{if(init.method==='POST'){posts++;return Response.json({id:'stable_unknown_original',status:'unknown'});}
      expect(url).toContain('/v1/videos/stable_unknown_original');expect(JSON.parse(latest().metadata)).toMatchObject({upstreamModel:STABLE,videoId:'stable_unknown_original'});
      if(++queries===1)return Response.json({error:{code:'temporary_error',message:'busy'}},{status:503});
      return Response.json({id:'stable_unknown_original',status,error:status==='failed'?{message:'upstream failed'}:undefined});};
    await(await post('/api/video/generate',{model:WD,prompt:'query original',seconds:5,resolution:'720p'})).text();expect(latest().status).toBe(status);expect(posts).toBe(1);expect(queries).toBe(2);expect(balance()).toBe(status==='completed'?93.5:100);
    resumeSpecificationTasks();resumeSpecificationTasks();expect(posts).toBe(1);
  });
  it('rejects unsupported limits before creating orders or reserving money',async()=>{
    await install();upstream=async()=>{throw Error('must not submit');};vi.mocked(fetch).mockClear();
    for(const patch of [{resolution:'480p'},{resolution:'1080p'},{seconds:4},{seconds:31},{reference_images:Array(31).fill(reference)},{reference_videos:Array(11).fill('https://media.example/v.mp4')},{audio_urls:Array(11).fill('https://media.example/a.wav')},{first_frame:reference}]){
      const r=await post('/api/video/generate',{model:WD,prompt:'invalid',seconds:5,resolution:'720p',...patch});expect(r.status).toBe(400);await r.text();
    }
    expect(fetch).not.toHaveBeenCalled();expect(balance()).toBe(100);expect(db.select().from(contents).all()).toEqual([]);
  });
  it('uses the persistent batch bridge and charges 6.5 once for the independent stable entry',async()=>{
    await install();let posts=0;const batchId=batchStore.create(1,crypto.randomUUID(),{name:'stable batch',model:WD,resolution:'720p',aspect_ratio:'16:9',video_length:30,autoRetry:false,maxRetries:0,creatives:[{prompt:'stable batch',count:1,reference_images:[]}]},6.5,'https://app.example');
    const item=batchStore.detail(batchId,1).items[0];
    upstream=async(url,init)=>{if(url==='http://127.0.0.1:9876/api/video/generate')return nativeFetch(origin+'/api/video/generate',init);posts++;expect(JSON.parse(init.body)).toMatchObject({model:STABLE,seconds:30,resolution:'720p'});return Response.json({id:'stable_batch_original',status:'completed'});};
    tickVideoBatches();await vi.waitFor(()=>expect(latest()?.status).toBe('completed'));tickVideoBatches();tickVideoBatches();resumeSpecificationTasks();
    expect(batchStore.item(item.id)).toMatchObject({status:'completed',billing_state:'charged',charged:6.5});expect(latest().modelId).toBe(WD);expect(balance()).toBe(93.5);expect(posts).toBe(1);
  });
});

describe('new KK 2.5 product, fixed per-task price',()=>{
  const id='kkseadanco2.5';
  async function install(){await syncV6kEntries([id]);db.update(models).set({isActive:1}).where(eq(models.modelId,id)).run();saveModelSpecification({...getModelSpecification(id)!,enabled:true});sqlite.prepare("INSERT INTO api_tokens(id,user_id,token_key,balance) VALUES(1,1,'test',-1)").run();}
  async function configure(fallback=true,primary:'stable'|'kk'='stable') {
    upstream=async()=>Response.json({data:Object.values(KK_VIDEO_SOURCES).map(id=>({id}))});
    await saveKkVideoRouting(id,{primary,fallback,channelId:db.select().from(channels).get()!.id},getKkVideoRouting(id).version);
  }
  it.each([false,true])('lets only administrators download a V6K original without resubmitting or changing funds (refunded=%s)',async refunded=>{
    await install();
    upstream=async(url,init)=>{
      expect(url).toBe('https://www.v6k.top/v1/videos');
      expect(init.method).toBe('POST');
      return Response.json({error:{code:'service_unavailable',message:'受理检查暂时不可用'}},{status:503});
    };
    await(await post('/api/video/generate',{model:id,prompt:'Recover original video',seconds:30,resolution:'720p'})).text();
    await vi.waitFor(()=>expect(JSON.parse(latest().metadata).reviewKind).toBe('submission'));
    if(refunded) confirmReviewedVideoFailureAndRefund(latest().id,1,true);
    const original=latest();
    expect(original.status).toBe(refunded?'failed':'processing');
    const reservation=sqlite.prepare('SELECT * FROM billing_reservations').all();
    const originalBalance=balance();
    expect(findVideoSubmissionReceipt(original.id)).toBeNull();
    const taskId='task_original_kk';
    const url='https://www.v6k.top/v1/videos/'+taskId;
    const endpoint=origin+'/api/admin/contents/'+original.id+'/v6k-original-video?taskId='+taskId;
    const headers={Authorization:'Bearer test-admin'};
    const calls:string[]=[];
    let returnedModel='稳定极速seadnco2.5-720', returnedStatus='completed';
    upstream=async(requestUrl,init)=>{
      expect(init.method).toBe('GET');
      expect(init.headers.Authorization).toBe('Bearer test-key');
      calls.push(requestUrl);
      if(requestUrl===url) return Response.json({id:taskId,model:returnedModel,status:returnedStatus});
      expect(requestUrl).toBe(url+'/content');
      return new Response('original video bytes',{headers:{'Content-Type':'video/mp4'}});
    };

    expect((await nativeFetch(endpoint)).status).toBe(403);
    expect(calls).toEqual([]);
    const wrongModel=await nativeFetch(endpoint,{headers});
    expect(wrongModel.status).toBe(409);
    expect(await wrongModel.text()).toContain('上游模型与原订单不一致');
    returnedModel=id;
    returnedStatus='in_progress';
    const processing=await nativeFetch(endpoint,{headers});
    expect(processing.status).toBe(409);
    expect(await processing.text()).toContain('in_progress');
    returnedStatus='completed';
    const download=await nativeFetch(endpoint,{headers});
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('video/mp4');
    expect(await download.text()).toBe('original video bytes');
    sqlite.prepare('INSERT INTO video_submission_receipts(content_id,upstream_task_id) VALUES(?,?)').run(original.id+1000,taskId);
    const conflict=await nativeFetch(endpoint,{headers});
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).toContain('已有回执冲突');
    expect(calls).toEqual([url,url,url,url+'/content']);
    expect(latest()).toEqual(original);
    expect(findVideoSubmissionReceipt(original.id)).toBeNull();
    expect(sqlite.prepare('SELECT * FROM billing_reservations').all()).toEqual(reservation);
    expect(balance()).toBe(originalBalance);
  });
  it.each([false, true])('restores an admin-confirmed V6K original to the order without touching funds (refunded=%s)', async refunded => {
    await install();
    upstream = async (url, init) => {
      expect(url).toBe('https://www.v6k.top/v1/videos');
      expect(init.method).toBe('POST');
      return Response.json({ error: { code: 'service_unavailable', message: '提交响应异常' } }, { status: 503 });
    };
    await (await post('/api/video/generate', { model: id, prompt: 'Restore original', seconds: 30, resolution: '720p' })).text();
    await vi.waitFor(() => expect(JSON.parse(latest().metadata).reviewKind).toBe('submission'));
    if (refunded) confirmReviewedVideoFailureAndRefund(latest().id, 1, true);
    const original = latest();
    const originalMeta = JSON.parse(original.metadata);
    const reservation = sqlite.prepare('SELECT * FROM billing_reservations').all();
    const ledger = sqlite.prepare('SELECT * FROM fund_ledger').all();
    const originalBalance = balance();
    const taskId = 'task_restore_original_kk';
    const url = 'https://www.v6k.top/v1/videos/' + taskId;
    const endpoint = origin + '/api/admin/contents/' + original.id + '/v6k-original-video/restore';
    const requestRestore = (confirmedOriginal: boolean, admin = true) => nativeFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: admin ? 'Bearer test-admin' : 'Bearer test' },
      body: JSON.stringify({ taskId, confirmedOriginal }),
    });
    const bytes = Buffer.from('00000014667479706d703432000000006d703432', 'hex');
    const calls: string[] = [];
    let returnedModel = id;
    let returnedStatus = 'completed';
    let corrupt = false;
    let interrupted = false;
    let acquireOtherReceipt = false;
    const otherId = original.id + 1000;
    upstream = async (requestUrl, init) => {
      expect(init.method).toBe('GET');
      expect(init.headers.Authorization).toBe('Bearer test-key');
      calls.push(requestUrl);
      if (requestUrl === url) return Response.json({ id: taskId, model: returnedModel, status: returnedStatus });
      expect(requestUrl).toBe(url + '/content');
      if (acquireOtherReceipt) sqlite.prepare('INSERT INTO video_submission_receipts(content_id,upstream_task_id) VALUES(?,?)').run(otherId, taskId);
      if (interrupted) {
        let started = false;
        const body = new ReadableStream({
          pull(controller) {
            if (started) controller.error(new Error('upstream connection closed'));
            else controller.enqueue(new Uint8Array(bytes));
            started = true;
          },
        });
        return new Response(body, { headers: { 'Content-Type': 'video/mp4' } });
      }
      return new Response(corrupt ? 'not a video' : new Uint8Array(bytes), { headers: { 'Content-Type': 'video/mp4' } });
    };
    expect((await requestRestore(true, false)).status).toBe(403);
    expect((await requestRestore(false)).status).toBe(400);
    expect(calls).toEqual([]);

    if (!refunded) {
      // A legacy metadata-only owner is still an owner.
      db.insert(contents).values({ ...original, id: otherId, status: 'completed', metadata: JSON.stringify({ videoId: taskId }) }).run();
      const oldOwner = await requestRestore(true);
      expect(oldOwner.status).toBe(409);
      expect(await oldOwner.text()).toContain('#' + otherId);
      expect(calls).toEqual([]);
      db.delete(contents).where(eq(contents.id, otherId)).run();

      returnedModel = STABLE;
      expect((await requestRestore(true)).status).toBe(409);
      returnedModel = id;
      returnedStatus = 'in_progress';
      const pending = await requestRestore(true);
      expect(pending.status).toBe(409);
      expect(await pending.text()).toContain('in_progress');
      expect(calls).toEqual([url, url]);
      returnedStatus = 'completed';
      corrupt = true;
      expect((await requestRestore(true)).status).toBe(502);
      corrupt = false;
      interrupted = true;
      const incomplete = await requestRestore(true);
      expect(incomplete.status).toBe(502);
      expect(await incomplete.text()).toContain('原视频未完整保存');
      interrupted = false;

      acquireOtherReceipt = true;
      const race = await requestRestore(true);
      expect(race.status).toBe(409);
      expect(await race.text()).toContain('已有回执冲突');
      acquireOtherReceipt = false;
      sqlite.prepare('DELETE FROM video_submission_receipts WHERE content_id=?').run(otherId);
      expect(latest()).toEqual(original);
      expect(findVideoSubmissionReceipt(original.id)).toBeNull();
      expect(sqlite.prepare('SELECT * FROM billing_reservations').all()).toEqual(reservation);
      expect(balance()).toBe(originalBalance);
      calls.length = 0;
    }

    const response = await requestRestore(true);
    const restored = await response.json() as any;
    expect(response.status, JSON.stringify(restored)).toBe(200);
    expect(restored).toMatchObject({ id: original.id, status: 'completed', taskId, alreadyRestored: false });
    const file = path.resolve('data', restored.resultUrl.slice(1));
    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(latest()).toMatchObject({ status: 'completed', resultUrl: restored.resultUrl, cost: original.cost });
    expect(JSON.parse(latest().metadata)).toMatchObject({
      videoId: taskId, upstreamTaskId: taskId, upstreamStatus: 'completed', requiresReview: false,
      billingStatus: originalMeta.billingStatus, billingReservationId: originalMeta.billingReservationId,
      v6kOriginalRestoration: { taskId, actorId: 1 },
    });
    expect(findVideoSubmissionReceipt(original.id)).toMatchObject({ upstreamTaskId: taskId, channelId: originalMeta.channelId });
    const repeated = await requestRestore(true);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ alreadyRestored: true, resultUrl: restored.resultUrl });
    resumeSpecificationTasks();
    expect(calls).toEqual([url, url + '/content']);
    expect(sqlite.prepare('SELECT * FROM billing_reservations').all()).toEqual(reservation);
    expect(sqlite.prepare('SELECT * FROM fund_ledger').all()).toEqual(ledger);
    expect(balance()).toBe(originalBalance);
  });
  it('saves the administrator switch atomically, preserves price/switches and rejects stale or unauthorized configuration',async()=>{
    await install(); const before=db.select().from(modelPricing).all();
    const settings=await(await nativeFetch(origin+'/test/admin/model-specifications/'+id+'/kk-routing')).json() as any;
    expect(JSON.stringify(settings)).not.toContain('test-key');
    upstream=async()=>Response.json({data:Object.values(KK_VIDEO_SOURCES).map(id=>({id}))});
    const response=await post('/test/admin/model-specifications/'+id+'/kk-routing',{routing:{primary:'stable',fallback:true,channelId:settings.channels[0].id},version:settings.version});
    expect(response.status).toBe(200); expect((await response.json() as any).current).toMatchObject({primary:'stable',fallback:true});
    expect(db.select().from(modelPricing).all()).toEqual(before);expect(balance()).toBe(100);expect(db.select().from(contents).all()).toEqual([]);
    const old=getModelSpecification(id)!;
    await expect(saveKkVideoRouting(id,{primary:'kk',fallback:false,channelId:settings.channels[0].id},settings.version)).rejects.toMatchObject({status:409});
    upstream=async()=>Response.json({data:[{id}]});
    await expect(saveKkVideoRouting(id,{primary:'stable',fallback:true,channelId:settings.channels[0].id},getKkVideoRouting(id).version)).rejects.toThrow('未开放');
    expect(getModelSpecification(id)).toEqual(old);
    await expect(saveKkVideoRouting('hss-2.5-301010',{primary:'kk',fallback:false,channelId:settings.channels[0].id},'')).rejects.toThrow('仅支持 KK');
  });
  it.each(['/api/video/generate','/v1/videos'])('falls back only after a definite 429 with one logical key and one reservation at %s',async endpoint=>{
    await install();await configure();let calls:string[]=[],keys:string[]=[];
    upstream=async(url,init)=>{expect(url).toBe('https://www.v6k.top/v1/videos');const p=JSON.parse(init.body);calls.push(p.model);keys.push(init.headers['Idempotency-Key']);
      return p.model===KK_VIDEO_SOURCES.stable?Response.json({error:{code:'rate_limit_exceeded',message:'busy'}},{status:429}):Response.json({id:'kk_backup_original',status:'completed'});};
    const body={model:id,prompt:'fallback',seconds:30,resolution:'720p'},key='kk-fallback-once';
    await(await retryVideo(endpoint,body,key)).text();await vi.waitFor(()=>expect(latest().status).toBe('completed'));
    expect(calls).toEqual([KK_VIDEO_SOURCES.stable,id]);expect(new Set(keys).size).toBe(1);expect(keys[0]).toBeTruthy();
    expect(balance()).toBe(93.5);expect(latest().cost).toBe(6.5);expect(sqlite.prepare('SELECT COUNT(*) AS n FROM billing_reservations').get()).toMatchObject({n:1});
    expect(JSON.parse(latest().metadata)).toMatchObject({videoId:'kk_backup_original',upstreamModel:id,videoSubmissionState:'accepted',billingStatus:'settled'});
    if(endpoint==='/v1/videos'){await(await retryVideo(endpoint,body,key)).text();expect(db.select().from(contents).all()).toHaveLength(1);}
    resumeSpecificationTasks();resumeSpecificationTasks();expect(calls).toHaveLength(2);expect(balance()).toBe(93.5);
  });
  it.each(['off','disabled','changed'])('honors %s fallback before dispatch',async mode=>{
    await install();await configure(mode!=='off');
    if(mode==='disabled'){const spec=getModelSpecification(id)!;saveModelSpecification({...spec,routes:spec.routes.map(r=>({...r,enabled:r.upstreamModel!==KK_VIDEO_SOURCES.stable}))});await configure(false);}
    let calls:string[]=[];upstream=async(_url,init)=>{calls.push(JSON.parse(init.body).model);
      if(mode==='changed'){const spec=getModelSpecification(id)!;spec.kkRouting!.fallback=false;sqlite.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify([spec]),'model_specification_routes_v1');}
      return Response.json({error:{code:'rate_limit_exceeded',message:'busy'}},{status:429});};
    const response=await post('/api/video/generate',{model:id,prompt:'switch',seconds:5,resolution:'720p'});await response.text();
    expect(calls).toEqual(mode==='disabled'?[]:[KK_VIDEO_SOURCES.stable]);expect(balance()).toBe(100);
  });
  it.each(['401','400','503','504','unknown','receipt','failed','html429','pending429'])('never re-posts KK after %s and does not duplicate refunds',async outcome=>{
    await install();await configure();let posts=0;
    upstream=async(_url,init)=>{
      if(init.method!=='POST')return Response.json({id:'stable_original',status:'completed'});
      posts++;expect(JSON.parse(init.body).model).toBe(KK_VIDEO_SOURCES.stable);
      if(outcome==='unknown')return new Response('not json',{status:200});
      if(outcome==='html429')return new Response('<html>rate limited</html>',{status:429});
      if(outcome==='pending429')return Response.json({status:'queued',error:{code:'rate_limit_exceeded',message:'busy'}},{status:429});
      if(outcome==='receipt')return Response.json({id:'stable_original',status:'queued',error:{code:'authentication_error'}},{status:401});
      if(outcome==='failed')return Response.json({id:'stable_original',status:'failed',error:{message:'generation failed'}});
      return Response.json({error:{code:'provider_error',message:'specific failure'}},{status:Number(outcome)});
    };
    const body={model:id,prompt:'single receipt',seconds:5,resolution:'720p'},key='stable-safe-'+outcome;
    await(await retryVideo('/v1/videos',body,key)).text();
    const held=['503','504','unknown','pending429'].includes(outcome);
    await vi.waitFor(()=>expect(JSON.parse(latest().metadata).billingStatus).toBe(held?'review':outcome==='receipt'?'settled':'refunded'));
    if(held)expect(JSON.parse(latest().metadata)).toMatchObject({requiresReview:true,reviewKind:'submission',videoSubmissionState:'unknown'});
    const original=latest();await(await retryVideo('/v1/videos',body,key)).text();resumeSpecificationTasks();resumeSpecificationTasks();
    expect(posts).toBe(1);expect(latest().id).toBe(original.id);expect(balance()).toBe(held||outcome==='receipt'?93.5:100);
    if(['receipt','failed'].includes(outcome))expect(JSON.parse(latest().metadata).videoId).toBe('stable_original');
  });
  it('preserves KK policy, switches and price across sync and startup cleanup alongside the independent stable entry',async()=>{
    await install();await configure(true,'kk');const current=getModelSpecification(id)!;
    saveModelSpecification({...current,routes:current.routes.map(r=>({...r,cost:r.upstreamModel===id?99:0,costUnit:'per_call',enabled:r.upstreamModel===id}))});
    const before=getModelSpecification(id)!;pruneUnapprovedV6kBindings(sqlite);
    await syncV6kEntries(Object.values(KK_VIDEO_SOURCES));
    expect(getModelSpecification(id)).toEqual(before);
    expect(db.select().from(models).all().some(m=>m.modelId.includes('稳定'))).toBe(false);
    expect(getModelSpecification(WD)).toMatchObject({enabled:false,routes:[{upstreamModel:STABLE}]});
    expect(PricingService.quote(id,{seconds:30,resolution:'720p',count:1}).cost).toBe(6.5);
    expect(selectModelRoutes(before,{images:0,videos:0,audios:0,outputs:1,seconds:5,resolution:'720p',ratio:'16:9',firstFrame:false,lastFrame:false})[0].route.upstreamModel).toBe(id);
  });
  it('selects the chosen primary before a cheaper backup and skips a manually disabled primary only with fallback on',async()=>{
    await install();await configure();const input={images:0,videos:0,audios:0,outputs:1,seconds:5,resolution:'720p',ratio:'16:9',firstFrame:false,lastFrame:false};
    const spec=getModelSpecification(id)!;saveModelSpecification({...spec,routes:spec.routes.map(r=>({...r,cost:r.upstreamModel===id?0:99,costUnit:'per_call'}))});
    expect(selectModelRoutes(getModelSpecification(id)!,input).map(t=>t.route.upstreamModel)).toEqual([KK_VIDEO_SOURCES.stable,id]);
    const current=getModelSpecification(id)!;saveModelSpecification({...current,routes:current.routes.map(r=>({...r,enabled:r.upstreamModel===id}))});
    expect(selectModelRoutes(getModelSpecification(id)!,input).map(t=>t.route.upstreamModel)).toEqual([id]);
  });
  it.each(['rejected','failed'])('refunds one reservation when the backup is %s',async outcome=>{
    await install();await configure();let posts=0;
    upstream=async()=>{posts++;if(posts===1||outcome==='rejected')return Response.json({error:{code:'rate_limit_exceeded',message:'busy'}},{status:429});return Response.json({id:'backup_failed_original',status:'failed',error:{message:'backup failed'}});};
    const body={model:id,prompt:'both fail',seconds:5,resolution:'720p'};
    await(await retryVideo('/v1/videos',body,'both-failed')).text();await vi.waitFor(()=>expect(latest().status).toBe('failed'));
    await(await retryVideo('/v1/video/generations',body,'both-failed')).text();resumeSpecificationTasks();resumeSpecificationTasks();
    expect(posts).toBe(2);expect(balance()).toBe(100);expect(latest().cost).toBe(0);
    expect(sqlite.prepare('SELECT state,actual FROM billing_reservations').all()).toEqual([{state:'refunded',actual:0}]);
    if(outcome==='failed')expect(JSON.parse(latest().metadata).videoId).toBe('backup_failed_original');
  });
  it('keeps polling the accepted original after an administrator switches the primary',async()=>{
    await install();await configure();let posts=0,queries=0;
    upstream=async(url,init)=>{
      if(url.endsWith('/v1/models'))return Response.json({data:Object.values(KK_VIDEO_SOURCES).map(id=>({id}))});
      if(init.method==='POST'){posts++;return Response.json({id:'retained_stable_task',status:'queued'});}
      queries++;expect(url).toContain('/v1/videos/retained_stable_task');
      await saveKkVideoRouting(id,{primary:'kk',fallback:false,channelId:db.select().from(channels).get()!.id},getKkVideoRouting(id).version);
      return Response.json({id:'retained_stable_task',status:'completed'});
    };
    await(await post('/api/video/generate',{model:id,prompt:'original',seconds:5,resolution:'720p'})).text();
    expect(posts).toBe(1);expect(queries).toBe(1);expect(balance()).toBe(93.5);
    expect(JSON.parse(latest().metadata)).toMatchObject({videoId:'retained_stable_task',upstreamModel:KK_VIDEO_SOURCES.stable});
    expect(getModelSpecification(id)!.kkRouting).toMatchObject({primary:'kk',fallback:false});
  });
  it('uses the batch queue with one prepayment when stable rejects and KK accepts',async()=>{
    await install();await configure();let calls:string[]=[];
    const batchId=batchStore.create(1,crypto.randomUUID(),{name:'KK fallback batch',model:id,resolution:'720p',aspect_ratio:'16:9',video_length:30,autoRetry:false,maxRetries:0,creatives:[{prompt:'KK batch',count:1,reference_images:[]}]},6.5,'https://app.example');
    const item=batchStore.detail(batchId,1).items[0];
    upstream=async(url,init)=>{if(url==='http://127.0.0.1:9876/api/video/generate')return nativeFetch(origin+'/api/video/generate',init);
      const model=JSON.parse(init.body).model;calls.push(model);return model===KK_VIDEO_SOURCES.stable?Response.json({error:{code:'rate_limit_exceeded',message:'busy'}},{status:429}):Response.json({id:'backup_batch_task',status:'completed'});};
    tickVideoBatches();await vi.waitFor(()=>expect(latest()?.status).toBe('completed'));tickVideoBatches();tickVideoBatches();resumeSpecificationTasks();
    expect(batchStore.item(item.id)).toMatchObject({status:'completed',billing_state:'charged',charged:6.5});expect(balance()).toBe(93.5);expect(calls).toEqual([KK_VIDEO_SOURCES.stable,id]);
  });
  it.each(['ECONNREFUSED','UND_ERR_HEADERS_TIMEOUT'])('uses connection evidence rather than retrying every transport error: %s',async code=>{
    await install();await configure();let calls:string[]=[];
    upstream=async(_url,init)=>{const model=JSON.parse(init.body).model;calls.push(model);if(model===KK_VIDEO_SOURCES.stable)throw Object.assign(Error('network'),{cause:{code}});return Response.json({id:'connection_backup',status:'completed'});};
    await(await post('/api/video/generate',{model:id,prompt:'network',seconds:5,resolution:'720p'})).text();
    expect(calls).toEqual(code==='ECONNREFUSED'?[KK_VIDEO_SOURCES.stable,id]:[KK_VIDEO_SOURCES.stable]);
    expect(JSON.parse(latest().metadata).billingStatus).toBe(code==='ECONNREFUSED'?'settled':'review');expect(balance()).toBe(93.5);
  });
  it('returns the same original task during concurrent API retry while failover is still pending',async()=>{
    await install();await configure();let posts=0,release:(()=>void)|undefined;
    upstream=async(_url,init)=>{posts++;if(JSON.parse(init.body).model===KK_VIDEO_SOURCES.stable){await new Promise<void>(resolve=>release=resolve);return Response.json({error:{code:'rate_limit_exceeded',message:'busy'}},{status:429});}return Response.json({id:'concurrent_backup',status:'completed'});};
    const body={model:id,prompt:'concurrent fallback',seconds:5,resolution:'720p'},key='pending-fallback';
    try {
      const first=await(await retryVideo('/v1/videos',body,key)).json() as any;
      await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
      const retry=await(await retryVideo('/v1/video/generations',body,key)).json() as any;
      expect(retry.id).toBe(first.id);expect(posts).toBe(1);expect(balance()).toBe(93.5);
      release!();await vi.waitFor(()=>expect(latest().status).toBe('completed'));
      expect(posts).toBe(2);expect(balance()).toBe(93.5);expect(db.select().from(contents).all()).toHaveLength(1);
      expect(sqlite.prepare('SELECT count(*) AS n FROM billing_reservations').get()).toMatchObject({n:1});
    } finally { release?.(); }
  });
  it('publishes the exact unprefixed ID, native limits and 6.5 per-task price on website and public API catalog',async()=>{
    await install();const list=await(await nativeFetch(origin+'/api/video/models')).json() as any[];
    expect(list.find(m=>m.id===id)).toMatchObject({available:true,billingType:'per_call',rates:{'720p':6.5},routingLimits:{maxImages:30,maxVideos:10,maxAudios:10,resolutions:['720p']}});
    expect(getPublicDeveloperModels().items.find(m=>m.id===id)).toMatchObject({available:true,pricing:{billing_type:'per_call',unit_price:6.5}});
  });
  it.each(['/api/video/generate','/v1/videos'])('submits 5 and 30 seconds at the same price with all video/audio references at %s',async endpoint=>{
    await install();vi.stubEnv('BACKEND_URL','https://app.example');let posts=0;
    upstream=async(_url,init)=>{posts++;const q=JSON.parse(init.body);expect(q).toMatchObject({model:id,resolution:'720p'});expect(q.images).toHaveLength(1);expect(q.videos).toHaveLength(10);expect(q.audios).toHaveLength(10);return Response.json({id:'kk_original_'+posts,status:'completed'});};
    for(const seconds of [5,30]){await(await post(endpoint,{model:id,prompt:'KK new product',seconds,resolution:'720p',reference_images:[reference],reference_videos:Array(10).fill('https://media.example/v.mp4'),audio_urls:Array(10).fill('https://media.example/a.wav')})).text();await vi.waitFor(()=>expect(latest().status).toBe('completed'));expect(latest().cost).toBe(6.5);}
    expect(posts).toBe(2);expect(balance()).toBe(87);resumeSpecificationTasks();expect(posts).toBe(2);
  });
  it.each(['rejected','failed','uncertain'])('uses one reservation and settles original %s safely through API retries',async outcome=>{
    await install();let posts=0;upstream=async()=>{posts++;if(outcome==='rejected')return Response.json({error:{code:'invalid_request',message:'invalid input'}},{status:400});if(outcome==='uncertain')return new Response('<html>timeout</html>',{status:504});return Response.json({id:'kk_failed_original',status:'failed',error:{message:'original failed'}});};
    const body={model:id,prompt:'one logical order',seconds:30,resolution:'720p'},key='kk-stable-key';
    const r=await retryVideo('/v1/videos',body,key);const first=await r.json() as any;
    await vi.waitFor(()=>expect(JSON.parse(latest().metadata).billingStatus).toBe(outcome==='uncertain'?'review':'refunded'));
    const again=await retryVideo('/v1/video/generations',body,key);expect((await again.json() as any).id).toBe(first.id);
    resumeSpecificationTasks();resumeSpecificationTasks();expect(posts).toBe(1);expect(balance()).toBe(outcome==='uncertain'?93.5:100);
    expect(db.select().from(contents).all()).toHaveLength(1);expect(sqlite.prepare('SELECT count(*) AS n FROM billing_reservations').get()).toMatchObject({n:1});
  });
  it('rejects unsupported resolution, duration and material counts before order creation or charges',async()=>{
    await install();vi.mocked(fetch).mockClear();upstream=async()=>{throw Error('Must reject before network');};
    for(const patch of [{resolution:'480p'},{seconds:4},{seconds:31},{reference_images:Array(31).fill(reference)},{reference_videos:Array(11).fill('https://media.example/v.mp4')},{audio_urls:Array(11).fill('https://media.example/a.wav')}]){const r=await post('/api/video/generate',{model:id,prompt:'invalid',seconds:5,resolution:'720p',...patch});expect(r.status).toBe(400);await r.text();}
    expect(balance()).toBe(100);expect(db.select().from(contents).all()).toEqual([]);expect(fetch).not.toHaveBeenCalled();
  });
  it('uses the existing batch bridge and charges 6.5 once for a 30 second result',async()=>{
    await install();let posts=0;const batchId=batchStore.create(1,crypto.randomUUID(),{name:'KK batch',model:id,resolution:'720p',aspect_ratio:'16:9',video_length:30,autoRetry:false,maxRetries:0,creatives:[{prompt:'KK batch',count:1,reference_images:[]}]},6.5,'https://app.example');
    const item=batchStore.item(batchStore.detail(batchId,1).items[0].id);
    upstream=async(url,init)=>{if(url==='http://127.0.0.1:9876/api/video/generate')return nativeFetch(origin+'/api/video/generate',init);posts++;expect(JSON.parse(init.body)).toMatchObject({model:id,seconds:30,resolution:'720p'});return Response.json({id:'kk_batch_original',status:'completed'});};
    tickVideoBatches();await vi.waitFor(()=>expect(latest()?.status).toBe('completed'));tickVideoBatches();tickVideoBatches();
    expect(batchStore.item(item.id)).toMatchObject({status:'completed',billing_state:'charged',charged:6.5});expect(balance()).toBe(93.5);expect(posts).toBe(1);
  });
});

describe('BB and HSS new requests retargeted to KK',()=>{
  async function legacy(){
    const c=ChannelService.createChannel({name:'Old HUSS',type:'huss',baseUrl:'https://www.huss.top',apiKey:'original-huss-key',supportedModels:[...BB_HSS_KK_ENTRIES,'mj-v8.2'],modelMapping:Object.fromEntries(BB_HSS_KK_ENTRIES.map(id=>[id,'bb-2.5-301010-渠道A']))});
    for(const id of BB_HSS_KK_ENTRIES){db.insert(models).values({modelId:id,displayName:'original '+id,provider:'huss',capabilities:'["video"]',isActive:1}).run();
      db.insert(modelPricing).values({modelPattern:id,billingType:'per_call',inputPrice:4.5,extraParams:'{"720P":4.5}'}).run();
      saveModelSpecification({modelId:id,enabled:true,aliases:[],kind:'video',limits:id.startsWith('hss')?hussHssModelLimits():hussBbAModelLimits(),routes:[{id:'old-'+id,channelId:c,executionModel:id,upstreamModel:'bb-2.5-301010-渠道A',enabled:true,limits:hussBbAModelLimits(),cost:3,costUnit:'per_call',resolutionCosts:{},priority:0}]});}
    return c;
  }
  async function install(){const old=await legacy();await syncV6kEntries(['kkseadanco2.5']);sqlite.prepare("INSERT INTO api_tokens(id,user_id,token_key,balance) VALUES(1,1,'test',-1)").run();return old;}
  it('preserves public IDs, enabled switches and original names, shows both aliases and 6.5 pricing, and cannot sync HUSS back in',async()=>{
    const old=await install();const list=await(await nativeFetch(origin+'/api/video/models')).json() as any[];
    for(const id of BB_HSS_KK_ENTRIES){expect(list.find(m=>m.id===id)).toMatchObject({available:true,billingType:'per_call',rates:{'720p':6.5},routingLimits:bbHssKkLimits()});
      expect(getPublicDeveloperModels().items.find(m=>m.id===id)).toMatchObject({available:true,pricing:{billing_type:'per_call',unit_price:6.5}});}
    const before=BB_HSS_KK_ENTRIES.map(id=>getModelSpecification(id));
    upstream=async()=>Response.json({data:[{id:'bb-2.5-301010-渠道A'}]});await syncHussModels(ChannelService.getChannelRaw(old)!);
    expect(BB_HSS_KK_ENTRIES.map(id=>getModelSpecification(id))).toEqual(before);expect(()=>switchHssSource('A')).toThrow('来源切换');
    expect(ChannelService.getChannelRaw(old)?.apiKey).toBe('original-huss-key');
  });
  it.each(BB_HSS_KK_ENTRIES.flatMap(id=>['/api/video/generate','/v1/videos'].map(endpoint=>({id,endpoint}))))('submits $id at $endpoint to KK at 6.5 per task for 5 and 30 seconds',async({id,endpoint})=>{
    await install();let posts=0;upstream=async(url,init)=>{posts++;expect(url).toBe('https://www.v6k.top/v1/videos');const q=JSON.parse(init.body);expect(q).toMatchObject({model:'kkseadanco2.5',resolution:'720p'});expect(q.videos).toHaveLength(10);expect(q.audios).toHaveLength(10);return Response.json({id:'retargeted_'+posts,status:'completed'});};
    for(const seconds of [5,30]){await(await post(endpoint,{model:id,prompt:'new alias request',seconds,resolution:'720p',reference_videos:Array(10).fill('https://media.example/v.mp4'),audio_urls:Array(10).fill('https://media.example/a.wav')})).text();await vi.waitFor(()=>expect(latest().status).toBe('completed'));expect(latest().cost).toBe(6.5);expect(latest().modelId).toBe(id);}
    expect(posts).toBe(2);expect(balance()).toBe(87);expect(JSON.parse(latest().metadata)).toMatchObject({upstreamModel:'kkseadanco2.5',actualChannel:'zongheng-v6k'});
  });
  it.each(BB_HSS_KK_ENTRIES.flatMap(id=>(['A','B'] as const).flatMap(source=>['/api/video/generate','/v1/videos'].map(endpoint=>({id,source,endpoint})))))('independently switches $id to $source then submits at $endpoint and settles the original sale once',async({id,source,endpoint})=>{
    const old=await install(), other=BB_HSS_KK_ENTRIES.find(x=>x!==id)!, untouched=structuredClone(getModelSpecification(other));
    upstream=async()=>Response.json({data:[{id:BB_HSS_SOURCES[source].upstreamModel}]});
    const saved=await post('/test/admin/model-specifications/'+id+'/video-sources',{source,channelId:old});
    expect(saved.status).toBe(200);expect((await saved.json() as any).current).toEqual({source,channelId:old});
    expect(getModelSpecification(other)).toEqual(untouched);
    const front=await(await nativeFetch(origin+'/api/video/models')).json() as any[];
    expect(front.find(x=>x.id===id)).toMatchObject({available:true,routingLimits:BB_HSS_SOURCES[source].limits(),billingType:'per_call',rates:{'720p':6.5}});
    let posts=0;upstream=async(url,init)=>{expect(url).toBe('https://www.huss.top/v1/videos');expect(init.method).toBe('POST');posts++;
      expect(JSON.parse(init.body)).toMatchObject({model:BB_HSS_SOURCES[source].upstreamModel,duration:source==='A'?5:4,resolution:'720p',ratio:'21:9'});
      return Response.json({id:'original_switched',status:'completed',url:'https://media.example/result.mp4'});};
    const body={model:id,prompt:'selected source',seconds:source==='A'?5:4,resolution:'720p',aspect_ratio:'21:9'};
    const first=await retryVideo(endpoint,body,'switched-stable');await first.text();await vi.waitFor(()=>expect(latest().status).toBe('completed'));
    expect(posts).toBe(1);expect(latest().cost).toBe(6.5);expect(balance()).toBe(93.5);
    expect(JSON.parse(latest().metadata)).toMatchObject({channelId:old,upstreamModel:BB_HSS_SOURCES[source].upstreamModel,videoId:'original_switched'});
    if(endpoint==='/v1/videos'){await(await retryVideo(endpoint,body,'switched-stable')).text();expect(posts).toBe(1);expect(balance()).toBe(93.5);}
    resumeSpecificationTasks();resumeSpecificationTasks();expect(posts).toBe(1);expect(balance()).toBe(93.5);
  });
  it('preserves the selected source through both catalog synchronizations and startup, then switches back to KK without changing prices or disabled switches',async()=>{
    const old=await install(),id=BB_HSS_KK_ENTRIES[0];upstream=async()=>Response.json({data:[{id:BB_HSS_SOURCES.A.upstreamModel}]});
    await switchBbHssVideoSource(id,'A',old);
    const spec=getModelSpecification(id)!;saveModelSpecification({...spec,enabled:false,routes:spec.routes.map(r=>({...r,enabled:false}))});
    const before=structuredClone(getModelSpecification(id));await syncHussModels(ChannelService.getChannelRaw(old)!);
    await syncV6kEntries(['kkseadanco2.5']);ensureBbHssKkMapping(sqlite);
    expect(getModelSpecification(id)).toEqual(before);expect(JSON.parse(ChannelService.getChannelRaw(old)!.modelMapping)[id]).toBe(BB_HSS_SOURCES.A.upstreamModel);
    const kk=getModelSpecification(BB_HSS_KK_ENTRIES[1])!.routes[0].channelId;
    upstream=async()=>Response.json({data:[{id:'kkseadanco2.5'}]});await switchBbHssVideoSource(id,'KK',kk);
    expect(getModelSpecification(id)).toMatchObject({enabled:false,limits:bbHssKkLimits(),routes:[{enabled:false,upstreamModel:'kkseadanco2.5'}]});
    expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern,id)).get()).toMatchObject({inputPrice:6.5,billingType:'per_call'});
    expect(balance()).toBe(100);expect(db.select().from(contents).all()).toHaveLength(0);
  });
  it('rejects missing permissions, unavailable channels and concurrent configuration edits without touching old jobs, wallets or prices',async()=>{
    const old=await install(),id=BB_HSS_KK_ENTRIES[0],before=JSON.stringify(getModelSpecification(id));
    const money=JSON.stringify(db.select().from(modelPricing).all());
    upstream=async()=>Response.json({data:[]});await expect(switchBbHssVideoSource(id,'B',old)).rejects.toThrow('未开放');
    upstream=async()=>new Response('bad gateway',{status:504});await expect(switchBbHssVideoSource(id,'A',old)).rejects.toThrow('原配置保留');
    ChannelService.updateChannel(old,{status:0});await expect(switchBbHssVideoSource(id,'A',old)).rejects.toThrow('未启用');ChannelService.updateChannel(old,{status:1});
    upstream=async()=>{ChannelService.updateChannel(old,{apiKey:'changed-key'});return Response.json({data:[{id:BB_HSS_SOURCES.A.upstreamModel}]});};
    await expect(switchBbHssVideoSource(id,'A',old)).rejects.toThrow('查询期间配置已变化');
    expect(JSON.stringify(getModelSpecification(id))).toBe(before);expect(JSON.stringify(db.select().from(modelPricing).all())).toBe(money);
    expect(balance()).toBe(100);expect(db.select().from(contents).all()).toHaveLength(0);
    expect(JSON.stringify(getBbHssVideoSources(id))).not.toContain('changed-key');
  });
  it('rejects a channel A combined asset overflow before creating an order or reserving money',async()=>{
    const old=await install(),id=BB_HSS_KK_ENTRIES[0];upstream=async()=>Response.json({data:[{id:BB_HSS_SOURCES.A.upstreamModel}]});await switchBbHssVideoSource(id,'A',old);
    vi.mocked(fetch).mockClear();
    const r=await post('/api/video/generate',{model:id,prompt:'combined overflow',seconds:5,resolution:'720p',reference_images:Array(30).fill(reference),reference_videos:['https://media.example/v.mp4']});
    expect(r.status).toBe(400);expect(await r.text()).toContain('合计最多30');expect(fetch).not.toHaveBeenCalled();expect(balance()).toBe(100);expect(db.select().from(contents).all()).toHaveLength(0);
  });
  it('allows only one concurrent switch and preserves administrator limits on an identical repeated selection',async()=>{
    const old=await install(),id=BB_HSS_KK_ENTRIES[0];
    const replies:((r:Response)=>void)[]=[];upstream=async()=>new Promise<Response>(resolve=>replies.push(resolve));
    const first=switchBbHssVideoSource(id,'A',old), second=switchBbHssVideoSource(id,'B',old);
    replies[0](Response.json({data:[{id:BB_HSS_SOURCES.A.upstreamModel}]}));await first;
    const rejected=expect(second).rejects.toThrow('查询期间配置已变化');replies[1](Response.json({data:[{id:BB_HSS_SOURCES.B.upstreamModel}]}));await rejected;
    const spec=getModelSpecification(id)!;saveModelSpecification({...spec,limits:{...spec.limits,maxImages:20}});
    upstream=async()=>Response.json({data:[{id:BB_HSS_SOURCES.A.upstreamModel}]});await switchBbHssVideoSource(id,'A',old);
    expect(getModelSpecification(id)!.limits.maxImages).toBe(20);expect(getBbHssVideoSources(id).current).toEqual({source:'A',channelId:old});
    const specAfter=getModelSpecification(id)!;expect(()=>saveModelSpecification({...specAfter,routes:specAfter.routes.map(r=>({...r,upstreamModel:BB_HSS_SOURCES.B.upstreamModel}))})).toThrow('来源不一致');
    expect(balance()).toBe(100);expect(db.select().from(contents).all()).toHaveLength(0);
  });
  it.each(['A','B'] as const)('refunds a confirmed failed task from selected source %s once, including API retries and worker scans',async source=>{
    const old=await install(),id=BB_HSS_KK_ENTRIES[1];upstream=async()=>Response.json({data:[{id:BB_HSS_SOURCES[source].upstreamModel}]});await switchBbHssVideoSource(id,source,old);
    let posts=0;upstream=async()=>{posts++;return Response.json({id:'switched_failed_original',status:'failed',error:{code:'video_generation_failed',message:'original provider task failed'}});};
    const body={model:id,prompt:'failed selected task',seconds:5,resolution:'720p'};
    const first=await(await retryVideo('/v1/videos',body,'switched-failed')).json() as any;await vi.waitFor(()=>expect(latest().status).toBe('failed'));
    await(await retryVideo('/v1/videos',body,'switched-failed')).text();resumeSpecificationTasks();resumeSpecificationTasks();
    expect(JSON.parse(latest().metadata)).toMatchObject({videoId:'switched_failed_original',billingStatus:'refunded',upstreamModel:BB_HSS_SOURCES[source].upstreamModel});
    expect(posts).toBe(1);expect(balance()).toBe(100);expect(latest().cost).toBe(0);expect(first.id).toBeTruthy();
  });
  it('does not dispatch a stale queued selection after Mo replacement, while an accepted old KK task still resumes at its original channel',async()=>{
    const old=await install(),id=BB_HSS_KK_ENTRIES[0],input={images:0,videos:0,audios:0,outputs:1,seconds:5,ratio:'16:9',resolution:'720p',quality:'',firstFrame:false,lastFrame:false};
    const candidate=selectModelRoutes(getModelSpecification(id)!,input)[0];
    // Seed an already accepted task using a real order/reservation, leaving its first query temporarily unknown.
    let generationPosts=0;upstream=async(_url,init)=>{if(init.method==='POST'){generationPosts++;return Response.json({id:'original_kk_before_switch',status:'unknown'});}return Response.json({id:'original_kk_before_switch',status:'unknown'});};
    const body={model:id,prompt:'accepted before switch',seconds:5,resolution:'720p'};
    const response=await retryVideo('/v1/videos',body,'before-source-switch');const original=await response.json() as any;
    await vi.waitFor(()=>expect(JSON.parse(latest().metadata).videoId).toBe('original_kk_before_switch'));
    upstream=async url=>url.endsWith('/models')?Response.json({data:[{id:BB_HSS_SOURCES.A.upstreamModel}]}):Response.json({id:'original_kk_before_switch',status:'completed'});
    await switchBbHssVideoSource(id,'A',old);
    ensureBbHssMoMapping(sqlite);
    expect(routeUnavailableReason(id,candidate,input)).toContain('原线路已删除');
    resumeSpecificationTasks();await vi.waitFor(()=>expect(latest().status).toBe('completed'));
    expect(JSON.parse(latest().metadata)).toMatchObject({channelId:candidate.channel.id,upstreamModel:'kkseadanco2.5',videoId:'original_kk_before_switch'});
    const replay=await(await retryVideo('/v1/videos',body,'before-source-switch')).json() as any;expect(replay.id).toBe(original.id);
    expect(generationPosts).toBe(1);expect(balance()).toBe(93.5);expect(db.select().from(contents).all()).toHaveLength(1);
  });
  it.each(BB_HSS_KK_ENTRIES)('rejects obsolete 4 second and wide-ratio inputs for %s before order creation and charging',async id=>{
    await install();vi.mocked(fetch).mockClear();upstream=async()=>{throw Error('Not allowed');};
    for(const patch of [{seconds:4},{aspect_ratio:'21:9'},{aspect_ratio:'4:3'},{resolution:'480p'}]){const r=await post('/api/video/generate',{model:id,prompt:'old cached options',seconds:5,resolution:'720p',...patch});expect(r.status).toBe(400);await r.text();}
    expect(balance()).toBe(100);expect(fetch).not.toHaveBeenCalled();expect(db.select().from(contents).all()).toEqual([]);
  });
  it('cannot fall through to legacy HUSS generation if an administrator deletes a migrated specification',async()=>{
    await install();const id=BB_HSS_KK_ENTRIES[0];deleteModelSpecification(id);vi.mocked(fetch).mockClear();upstream=async()=>{throw Error('No legacy submission');};
    for(const endpoint of ['/api/video/generate','/v1/videos']){const r=await post(endpoint,{model:id,prompt:'missing spec',seconds:5,resolution:'720p'});expect(r.status).toBe(503);await r.text();}
    expect(balance()).toBe(100);expect(db.select().from(contents).all()).toEqual([]);expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['completed','failed','uncertain'])('retries the same API request without a second generation and settles KK %s once',async outcome=>{
    await install();let posts=0;upstream=async()=>{posts++;if(outcome==='uncertain')return new Response('<html>timeout</html>',{status:504});return Response.json({id:'kk_alias_original',status:outcome,error:outcome==='failed'?{message:'original failed'}:undefined});};
    const body={model:BB_HSS_KK_ENTRIES[1],prompt:'same alias order',seconds:30,resolution:'720p'};
    const r=await retryVideo('/v1/videos',body,'alias-stable');const first=await r.json() as any;
    await vi.waitFor(()=>expect(JSON.parse(latest().metadata).billingStatus).toBe(outcome==='uncertain'?'review':outcome==='failed'?'refunded':'settled'));
    const again=await retryVideo('/v1/video/generations',body,'alias-stable');expect((await again.json() as any).id).toBe(first.id);resumeSpecificationTasks();resumeSpecificationTasks();expect(posts).toBe(1);expect(balance()).toBe(outcome==='failed'?100:93.5);
  });
  it.each([true,false])('keeps the old prepaid batch amount when starting on KK (pricing snapshot=%s)',async withSnapshot=>{
    await legacy();const id=BB_HSS_KK_ENTRIES[0],quote=PricingService.quote(id,{seconds:30,resolution:'720p'},false,1);
    const batchId=batchStore.create(1,crypto.randomUUID(),{name:'prepaid old order',model:id,resolution:'720p',aspect_ratio:'16:9',video_length:30,autoRetry:false,maxRetries:0,creatives:[{prompt:'original prepaid',count:1,reference_images:[]}]},4.5,'https://app.example',withSnapshot?quote.pricingSnapshot:undefined);
    const item=batchStore.item(batchStore.detail(batchId,1).items[0].id);await syncV6kEntries(['kkseadanco2.5']);let posts=0;
    upstream=async(url,init)=>{if(url==='http://127.0.0.1:9876/api/video/generate')return nativeFetch(origin+'/api/video/generate',init);posts++;expect(JSON.parse(init.body).model).toBe('kkseadanco2.5');return Response.json({id:'prepaid_kk_original',status:'completed'});};
    tickVideoBatches();await vi.waitFor(()=>expect(latest()?.status).toBe('completed'));tickVideoBatches();tickVideoBatches();expect(posts).toBe(1);expect(balance()).toBe(95.5);expect(batchStore.item(item.id)).toMatchObject({charged:4.5,billing_state:'charged'});expect(latest().cost).toBe(4.5);
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
