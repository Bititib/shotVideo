import { migrateZonghengModelPrefix } from '../server/services/zonghengPrefixMigration';
import { ZONGHENG_VIDEO_MODELS } from '../shared/zonghengVideo';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { VideoRecoveryService } from '../server/services/videoRecoveryService';
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
  for(const table of ['contents','channels','models','model_pricing','users','api_logs','settings'])sqlite.exec('DELETE FROM '+table);
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
  vi.spyOn(globalThis,'setTimeout').mockImplementation(((fn:any,ms:number,...args:any[])=>nativeSetTimeout(fn,ms>=1000&&ms<=60000?5:ms,...args)) as any);
});
afterEach(()=>{
  for(const row of db.select().from(contents).all()){
    const meta=JSON.parse(row.metadata||'{}');
    for(const url of [row.resultUrl,...(meta.imageUrls||[])])if(typeof url==='string'&&url.includes('zongheng_')&&/\/(?:api\/)?uploads\//.test(url)){
      const file=path.resolve('data',new URL(url,'http://local.invalid').pathname.replace(/^\/(?:api\/)?/,''));
      if(file.startsWith(path.resolve('data/uploads')+path.sep)&&fs.existsSync(file))fs.unlinkSync(file);
    }
  }
  vi.restoreAllMocks();vi.unstubAllGlobals();
});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));sqlite.close();});
async function post(endpoint:string,body:any){return nativeFetch(origin+endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer test'},body:JSON.stringify(body)});}
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
describe('Zongheng legacy entry points, isolated database and simulated provider',()=>{
  it('accepts legacy cached website and API model IDs after prefix migration',async()=>{
    const oldId='zongheng-Cseadanco2.5K';
    db.insert(models).values({modelId:oldId,displayName:oldId,provider:'zongheng',capabilities:'["video"]'}).run();
    db.insert(modelPricing).values({modelPattern:oldId,billingType:'per_call',inputPrice:3}).run();
    ChannelService.updateChannel(db.select().from(channels).get()!.id,{supportedModels:[oldId],modelMapping:{[oldId]:'Cseadanco2.5K'}});
    migrateZonghengModelPrefix();
    for(const endpoint of ['/api/video/generate','/v1/videos']){
      upstream=async(_url,init)=>{
        if(init.method==='POST'){expect(JSON.parse(init.body)).toMatchObject({model:'Cseadanco2.5K',duration:10,resolution:'720p'});return Response.json({task_id:'vid_migrated'});}
        return Response.json({status:'succeeded',video_url:'https://media.invalid/done.mp4'});
      };
      const response=await post(endpoint,{model:oldId,prompt:'产品视频'});expect(response.status).toBe(endpoint.startsWith('/api/')?200:202);await response.text();
      await vi.waitFor(()=>expect(latest().status).toBe('completed'));
    }
    expect(balance()).toBe(94);
  });
  it('resumes an old-prefix task after migration on its original channel without a second charge',async()=>{
    const oldId='zongheng-Cseadanco2.5K',channelId=db.select().from(channels).get()!.id;
    db.insert(models).values({modelId:oldId,displayName:oldId,provider:'zongheng',capabilities:'["video"]'}).run();
    db.insert(modelPricing).values({modelPattern:oldId,billingType:'per_call',inputPrice:3}).run();
    ChannelService.updateChannel(channelId,{supportedModels:[oldId],modelMapping:{[oldId]:'Cseadanco2.5K'}});
    db.insert(contents).values({userId:1,type:'video',status:'processing',modelId:oldId,cost:3,metadata:JSON.stringify({channelId,videoId:'vid_legacy',seconds:10,resolution:'720p',zonghengSubmissionStarted:'before restart'})}).run();
    migrateZonghengModelPrefix();
    upstream=async(url,init)=>{expect(init.method).not.toBe('POST');expect(url).toBe('https://channel.invalid/v1/tasks/vid_legacy');return Response.json({status:'succeeded',video_url:'https://media.invalid/done.mp4'});};
    const record=latest();await video.resumePollForTask(record.id,record);
    expect(latest()).toMatchObject({status:'completed',modelId:oldId,cost:3});expect(balance()).toBe(100);expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('classifies all confirmed IDs as video and repairs old text entries without changing their enabled state',async()=>{
    db.insert(models).values({modelId:'ZH-Cseadanco2.5K',displayName:'保留名称',provider:'zongheng',capabilities:'["text"]',isActive:0}).run();
    upstream=async()=>Response.json({data:ZONGHENG_VIDEO_MODELS.map(spec=>({id:spec.id}))});
    await ChannelService.syncModels(db.select().from(channels).get()!.id);
    for(const spec of ZONGHENG_VIDEO_MODELS){
      expect(db.select().from(models).all().find(m=>m.modelId==='ZH-'+spec.id)).toMatchObject({capabilities:'["video"]',isActive:0});
    }
    expect(db.select().from(models).all().find(m=>m.modelId==='ZH-Cseadanco2.5K')?.displayName).toBe('保留名称');
    expect(JSON.parse(db.select().from(channels).get()!.modelMapping)).toEqual(Object.fromEntries(ZONGHENG_VIDEO_MODELS.map(spec=>['ZH-'+spec.id,spec.id])));
  });

  it('uses ZH IDs as default display names even when upstream supplies a different label',async()=>{
    upstream=async()=>Response.json({data:[{id:'LLseadanco2.51',display_name:'上游展示名称'},{id:'custom-model',name:'另一个上游名称'}]});
    await ChannelService.syncModels(db.select().from(channels).get()!.id);
    for(const id of ['LLseadanco2.51','custom-model']){
      expect(db.select().from(models).all().find(m=>m.modelId==='ZH-'+id)).toMatchObject({displayName:'ZH-'+id,isActive:0});
    }
    expect(JSON.parse(db.select().from(channels).get()!.modelMapping)).toEqual({'ZH-LLseadanco2.51':'LLseadanco2.51','ZH-custom-model':'custom-model'});
  });

  it.each([
    {id:'TTsedanco2.5-480',resolution:'480p',rate:0.35},
    {id:'TTseadanco2.5-720',resolution:'720p',rate:0.5},
  ])('lists and bills the configured per-second TT model $id at its exact resolution',async({id,resolution,rate})=>{
    installConfirmedVideos();
    const modelId='ZH-'+id;
    sqlite.prepare('UPDATE model_pricing SET billing_type=?,input_price=? WHERE model_pattern=?').run('per_second',rate,modelId);
    const listed=await(await nativeFetch(origin+'/api/video/models')).json() as any[];
    expect(listed.find(m=>m.id===modelId)).toMatchObject({
      available:true,billingType:'per_second',allowedSeconds:Array.from({length:26},(_,i)=>i+5),maxSeconds:30,rates:{[resolution]:rate},
    });
    expect(Object.keys(listed.find(m=>m.id===modelId).rates)).toEqual([resolution]);
    upstream=async(_url,init)=>{
      if(init.method==='POST'){
        expect(JSON.parse(init.body)).toMatchObject({model:id,duration:6,resolution});
        return Response.json({task_id:'vid_tt'});
      }
      return Response.json({status:'succeeded',video_url:'https://media.invalid/tt.mp4'});
    };
    const response=await post('/v1/videos',{model:modelId,prompt:'产品视频',video_length:6,resolution});
    expect(response.status).toBe(202);
    await vi.waitFor(()=>expect(latest().status).toBe('completed'));
    expect(latest().cost).toBeCloseTo(rate*6,6);
    expect(balance()).toBeCloseTo(100-rate*6,6);
  });

  it.each(['/api/video/generate','/v1/videos'].flatMap(endpoint=>[5,30].map(seconds=>({endpoint,seconds}))))('discovers KK X and charges 6.5 once for $seconds seconds via $endpoint with all references',async({endpoint,seconds})=>{
    const raw='KKseadanco2.5X',modelId='ZH-'+raw;
    const channelId=db.select().from(channels).get()!.id;
    upstream=async()=>Response.json({data:[{id:raw}]});
    await ChannelService.syncModels(channelId);
    expect(db.select().from(models).all().find(m=>m.modelId===modelId)).toMatchObject({displayName:modelId,capabilities:'["video"]',isActive:0});
    expect(JSON.parse(db.select().from(channels).get()!.modelMapping)[modelId]).toBe(raw);
    const price=db.select().from(modelPricing).all().find(p=>p.modelPattern===modelId)!;
    expect(price).toMatchObject({billingType:'per_call',inputPrice:6.5,outputPrice:0});
    expect(JSON.parse(price.extraParams)).toEqual({category:'video','720p':6.5});
    sqlite.prepare('UPDATE models SET is_active=1 WHERE model_id=?').run(modelId);
    const listed=await(await nativeFetch(origin+'/api/video/models')).json() as any[];
    expect(listed.find(m=>m.id===modelId)).toMatchObject({billingType:'per_call',allowedSeconds:Array.from({length:26},(_,i)=>i+5),maxSeconds:30,rates:{'720p':6.5},available:true});
    const images=Array.from({length:30},(_,i)=>'https://media.invalid/i-'+i+'.jpg');
    const videos=Array.from({length:10},(_,i)=>'https://media.invalid/v-'+i+'.mp4');
    const audios=Array.from({length:10},(_,i)=>'https://media.invalid/a-'+i+'.mp3');
    upstream=async(_url,init)=>{
      if(init.method==='POST'){
        expect(JSON.parse(init.body)).toMatchObject({model:raw,duration:seconds,resolution:'720p',images,reference_videos:videos,reference_audios:audios});
        return Response.json({task_id:'vid_kkx'});
      }
      return Response.json({status:'succeeded',video_url:'https://media.invalid/kkx.mp4'});
    };
    const response=await post(endpoint,{model:modelId,prompt:'产品视频',video_length:seconds,resolution:'720p',reference_images:images,reference_videos:videos,audio_urls:audios});
    expect(response.status).toBe(endpoint==='/v1/videos'?202:200);await response.text();
    await vi.waitFor(()=>expect(latest().status).toBe('completed'));
    expect(latest().cost).toBe(6.5);expect(balance()).toBe(93.5);
  });
  it('preserves administrator pricing and enablement when KK X is synchronized again',async()=>{
    const modelId='ZH-KKseadanco2.5X',channelId=db.select().from(channels).get()!.id;
    upstream=async()=>Response.json({data:[{id:'KKseadanco2.5X'}]});
    await ChannelService.syncModels(channelId);
    sqlite.prepare('UPDATE models SET is_active=1,display_name=? WHERE model_id=?').run('自定义 KK X',modelId);
    sqlite.prepare('UPDATE model_pricing SET input_price=?,extra_params=? WHERE model_pattern=?').run(7,JSON.stringify({category:'video','720p':7}),modelId);
    await ChannelService.syncModels(channelId);
    expect(db.select().from(models).all().find(m=>m.modelId===modelId)).toMatchObject({isActive:1,displayName:'自定义 KK X'});
    const prices=db.select().from(modelPricing).all().filter(p=>p.modelPattern===modelId);
    expect(prices).toHaveLength(1);expect(prices[0]).toMatchObject({billingType:'per_call',inputPrice:7});expect(JSON.parse(prices[0].extraParams)['720p']).toBe(7);
  });

  it('repairs an enabled MMseadanco2.5-PRO entry and preserves its per-call price and exact upstream ID',async()=>{
    const modelId='ZH-MMseadanco2.5-PRO';
    db.insert(models).values({modelId,displayName:'自定义 PRO 名称',provider:'zongheng',capabilities:'["text"]',isActive:1}).run();
    db.insert(modelPricing).values({modelPattern:modelId,billingType:'per_call',inputPrice:3,extraParams:'{"720p":4}'}).run();
    const channelId=db.select().from(channels).get()!.id;
    upstream=async()=>Response.json({data:[{id:'MMseadanco2.5-PRO'}]});
    await ChannelService.syncModels(channelId);
    expect(db.select().from(models).all().find(m=>m.modelId===modelId)).toMatchObject({
      displayName:'自定义 PRO 名称',capabilities:'["video"]',isActive:1,
    });
    expect(JSON.parse(db.select().from(channels).get()!.modelMapping)[modelId]).toBe('MMseadanco2.5-PRO');
    const listed=await(await nativeFetch(origin+'/api/video/models')).json() as any[];
    expect(listed.find(m=>m.id===modelId)).toMatchObject({
      billingType:'per_call',allowedSeconds:Array.from({length:26},(_,i)=>i+5),maxSeconds:30,rates:{'720p':4},available:true,
    });
    expect(Object.keys(listed.find(m=>m.id===modelId).rates)).toEqual(['720p']);
    upstream=async(_url,init)=>{
      if(init.method==='POST'){
        expect(JSON.parse(init.body)).toMatchObject({model:'MMseadanco2.5-PRO',duration:30,resolution:'720p'});
        return Response.json({task_id:'vid_mm_pro'});
      }
      return Response.json({status:'succeeded',video_url:'https://media.invalid/mm-pro.mp4'});
    };
    const response=await post('/v1/videos',{model:modelId,prompt:'产品视频',video_length:30,resolution:'720p'});
    expect(response.status).toBe(202);
    await vi.waitFor(()=>expect(latest().status).toBe('completed'));
    expect(latest().cost).toBe(4);
    expect(balance()).toBe(96);
  });

  it('automatically prices newly discovered MM PRO videos at 4 each without enabling them',async()=>{
    upstream=async()=>Response.json({data:[{id:'MMseadanco2.5-PRO'}]});
    await ChannelService.syncModels(db.select().from(channels).get()!.id);
    const modelId='ZH-MMseadanco2.5-PRO';
    expect(db.select().from(models).all().find(m=>m.modelId===modelId)).toMatchObject({capabilities:'["video"]',isActive:0});
    const price=db.select().from(modelPricing).all().find(p=>p.modelPattern===modelId)!;
    expect(price).toMatchObject({billingType:'per_call',inputPrice:4,outputPrice:0});
    expect(JSON.parse(price.extraParams)).toEqual({category:'video','720p':4});
    sqlite.prepare('UPDATE models SET is_active=1 WHERE model_id=?').run(modelId);
    const listed=await(await nativeFetch(origin+'/api/video/models')).json() as any[];
    expect(listed.find(m=>m.id===modelId)).toMatchObject({billingType:'per_call',rates:{'720p':4}});
    upstream=async(_url,init)=>{
      if(init.method==='POST'){
        expect(JSON.parse(init.body)).toMatchObject({model:'MMseadanco2.5-PRO',duration:5,resolution:'720p'});
        return Response.json({task_id:'vid_mm_default_price'});
      }
      return Response.json({status:'succeeded',video_url:'https://media.invalid/mm-default.mp4'});
    };
    const response=await post('/v1/videos',{model:modelId,prompt:'产品视频',video_length:5,resolution:'720p'});
    expect(response.status).toBe(202);
    await vi.waitFor(()=>expect(latest().status).toBe('completed'));
    expect(latest().cost).toBe(4);
    expect(balance()).toBe(96);
  });

  it.each(['/api/video/generate','/v1/videos'])('passes all 30 images, 10 videos and 10 audios through %s without truncation',async endpoint=>{
    installConfirmedVideos();
    const images=Array.from({length:30},(_,i)=>'https://media.invalid/i-'+i+'.jpg');
    const videos=Array.from({length:10},(_,i)=>'https://media.invalid/v-'+i+'.mp4');
    const audios=Array.from({length:10},(_,i)=>'https://media.invalid/a-'+i+'.mp3');
    const body={model:'ZH-MMseadanco2.5-PRO',prompt:'多素材视频',video_length:10,resolution:'720p',reference_images:images,reference_videos:videos,audio_urls:audios};
    const validation=await post('/api/video/validate',body);
    expect(validation.status).toBe(200);expect(balance()).toBe(100);expect(fetch).not.toHaveBeenCalled();
    upstream=async(_url,init)=>{
      if(init.method==='POST'){
        expect(JSON.parse(init.body)).toMatchObject({model:'MMseadanco2.5-PRO',images,reference_videos:videos,reference_audios:audios});
        return Response.json({task_id:'vid_all_references'});
      }
      return Response.json({status:'succeeded',video_url:'https://media.invalid/all.mp4'});
    };
    const response=await post(endpoint,body);
    expect(response.status).toBe(endpoint==='/v1/videos'?202:200);
    await response.text();
    await vi.waitFor(()=>expect(latest().status).toBe('completed'));
    expect(balance()).toBe(98);
  });
  it.each([{field:'reference_images',count:31,ext:'jpg'},{field:'reference_videos',count:11,ext:'mp4'},{field:'audio_urls',count:11,ext:'mp3'}])('rejects excess $field before charging or uploading in every legacy entry point',async({field,count,ext})=>{
    installConfirmedVideos();
    for(const endpoint of ['/api/video/validate','/api/video/generate','/v1/videos']){
      const response=await post(endpoint,{model:'ZH-MMseadanco2.5-PRO',prompt:'素材超限测试',video_length:10,resolution:'720p',[field]:Array.from({length:count},(_,i)=>'https://media.invalid/'+i+'.'+ext)});
      expect(response.status).toBe(400);
      expect((await response.json() as any).error).toContain('最多支持 30 张图片、10 个视频、10 段音频');
    }
    expect(balance()).toBe(100);expect(fetch).not.toHaveBeenCalled();expect(db.select().from(contents).all()).toHaveLength(0);
  });

  it.each(['/api/video/generate','/v1/videos'])('discovers and submits the Unicode Seedance 2.0 model via %s at 2.5 per video',async endpoint=>{
    const modelId='ZH-sedanco2.0-300秒必出',raw='sedanco2.0-300秒必出';
    upstream=async()=>Response.json({data:[{id:raw}]});
    await ChannelService.syncModels(db.select().from(channels).get()!.id);
    expect(db.select().from(models).all().find(m=>m.modelId===modelId)).toMatchObject({displayName:modelId,capabilities:'["video"]',isActive:0});
    const price=db.select().from(modelPricing).all().find(p=>p.modelPattern===modelId)!;
    expect(price).toMatchObject({billingType:'per_call',inputPrice:2.5,outputPrice:0});
    expect(JSON.parse(price.extraParams)).toEqual({category:'video','720p':2.5});
    sqlite.prepare('UPDATE models SET is_active=1 WHERE model_id=?').run(modelId);
    const listed=await(await nativeFetch(origin+'/api/video/models')).json() as any[];
    expect(listed.find(m=>m.id===modelId)).toMatchObject({allowedSeconds:[15],maxSeconds:15,rates:{'720p':2.5},billingType:'per_call',available:true});
    const images=Array.from({length:9},(_,i)=>'https://media.invalid/i-'+i+'.jpg');
    const audios=Array.from({length:3},(_,i)=>'https://media.invalid/a-'+i+'.mp3');
    upstream=async(_url,init)=>{
      if(init.method==='POST'){
        expect(JSON.parse(init.body)).toMatchObject({model:raw,duration:15,resolution:'720p',images,reference_audios:audios});
        expect(JSON.parse(init.body)).not.toHaveProperty('reference_videos');
        return Response.json({task_id:'vid_sedanco20'});
      }
      return Response.json({status:'succeeded',video_url:'https://media.invalid/sedanco20.mp4'});
    };
    const response=await post(endpoint,{model:modelId,prompt:'15秒产品视频',reference_images:images,audio_urls:audios});
    expect(response.status).toBe(endpoint==='/v1/videos'?202:200);
    await response.text();
    await vi.waitFor(()=>expect(latest().status).toBe('completed'));
    expect(latest().cost).toBe(2.5);expect(balance()).toBe(97.5);
  });
  it.each([{field:'reference_images',count:10},{field:'reference_videos',count:1},{field:'audio_urls',count:4}])('rejects excess $field for fixed Seedance 2.0 before submission or charging',async({field,count})=>{
    installConfirmedVideos();
    for(const endpoint of ['/api/video/validate','/api/video/generate','/v1/videos']){
      const response=await post(endpoint,{model:'ZH-sedanco2.0-300秒必出',prompt:'超限测试',video_length:15,resolution:'720p',[field]:Array(count).fill('https://media.invalid/source')});
      expect(response.status).toBe(400);expect((await response.json() as any).error).toContain('最多支持 9 张图片、0 个视频、3 段音频');
    }
    expect(balance()).toBe(100);expect(fetch).not.toHaveBeenCalled();expect(db.select().from(contents).all()).toHaveLength(0);
  });
  it('lists exact legacy durations and one resolution for each confirmed video model',async()=>{
    installConfirmedVideos();
    const listed=await(await nativeFetch(origin+'/api/video/models')).json() as any[];
    for(const spec of ZONGHENG_VIDEO_MODELS){
      expect(listed.find(m=>m.id==='ZH-'+spec.id)).toMatchObject({allowedSeconds:spec.seconds,maxSeconds:spec.seconds[spec.seconds.length-1],rates:{[spec.resolution]:2},series:'zongheng',available:true});
      expect(Object.keys(listed.find(m=>m.id==='ZH-'+spec.id).rates)).toEqual([spec.resolution]);
      expect(listed.find(m=>m.id==='ZH-'+spec.id).routingLimits).toBeUndefined();
    }
  });
  it.each(ZONGHENG_VIDEO_MODELS)('uses mapped $id with valid defaults in website and API generation',async spec=>{
    installConfirmedVideos();
    for(const endpoint of ['/api/video/generate','/v1/videos']){
      upstream=async(_url,init)=>{
        if(init.method==='POST'){expect(JSON.parse(init.body)).toMatchObject({model:spec.id,duration:spec.seconds[0],resolution:spec.resolution});return Response.json({task_id:'vid_confirmed'});}
        return Response.json({status:'succeeded',video_url:'https://media.invalid/done.mp4'});
      };
      const response=await post(endpoint,{model:'ZH-'+spec.id,prompt:'产品视频'});
      expect(response.status).toBe(endpoint.startsWith('/api/')?200:202);await response.text();
      await vi.waitFor(()=>expect(latest().status).toBe('completed'));
    }
    expect(balance()).toBe(96);
  });
  it('honors API video_length and canonicalizes 2K for matching the legacy price',async()=>{
    installConfirmedVideos();
    sqlite.prepare('UPDATE model_pricing SET extra_params=? WHERE model_pattern=?').run(JSON.stringify({'2k':3}),'ZH-Xminimex-h3');
    upstream=async(_url,init)=>{
      if(init.method==='POST'){expect(JSON.parse(init.body)).toMatchObject({model:'Xminimex-h3',duration:13,resolution:'2k'});return Response.json({task_id:'vid_2k'});}
      return Response.json({status:'succeeded',video_url:'https://media.invalid/done.mp4'});
    };
    const response=await post('/v1/videos',{model:'ZH-Xminimex-h3',prompt:'产品视频',video_length:13,resolution:'2K'});
    expect(response.status).toBe(202);await vi.waitFor(()=>expect(latest().status).toBe('completed'));expect(balance()).toBe(97);
  });
  it('rejects conflicting API duration aliases without submission or charge',async()=>{
    installConfirmedVideos();
    const response=await post('/v1/videos',{model:'ZH-wan-1080',prompt:'产品视频',seconds:5,video_length:30});
    expect(response.status).toBe(400);expect(balance()).toBe(100);expect(fetch).not.toHaveBeenCalled();
  });
  it.each(ZONGHENG_VIDEO_MODELS)('rejects invalid $id duration and resolution before charging in all legacy entry points',async spec=>{
    installConfirmedVideos();
    for(const endpoint of ['/api/video/validate','/api/video/generate','/v1/videos']){
      for(const fields of [{video_length:spec.seconds[0]-1,seconds:spec.seconds[0]-1,resolution:spec.resolution},{video_length:spec.seconds[0],seconds:spec.seconds[0],resolution:spec.resolution === '480p' ? '1080p' : '480p'}]){
        const response=await post(endpoint,{model:'ZH-'+spec.id,prompt:'产品视频',...fields});
        expect(response.status).toBe(400);
      }
    }
    expect(balance()).toBe(100);expect(fetch).not.toHaveBeenCalled();
  });
  it('discovers namespaced disabled models and preserves provider public IDs',async()=>{
    upstream=async url=>{expect(url).toBe('https://channel.invalid/v1/models');return Response.json({data:[{id:'gpt-image-2',type:'image'},{id:'custom-model',type:'video'},{id:'gpt-public'}]});};
    const result=await ChannelService.syncModels(db.select().from(channels).get()!.id);
    expect(result.models).toEqual(['ZH-gpt-image-2','ZH-custom-model','ZH-gpt-public']);
    expect(db.select().from(models).all().find(m=>m.modelId==='ZH-custom-model')).toMatchObject({isActive:0,capabilities:'["video"]'});
    expect(JSON.parse(db.select().from(channels).get()!.modelMapping)['ZH-custom-model']).toBe('custom-model');
  });
  it('blocks newly synced disabled models in website and API paths before charging',async()=>{
    db.update(models).set({isActive:0}).run();
    for(const endpoint of ['/api/video/generate','/v1/videos']){
      const response=await post(endpoint,request);expect([404,503]).toContain(response.status);
    }
    expect(balance()).toBe(100);expect(fetch).not.toHaveBeenCalled();
  });
  it('validates batch input without submission or charge',async()=>{
    const result=await post('/api/video/validate',request);
    expect(result.status).toBe(200);expect(await result.json()).toMatchObject({unitCost:2});expect(balance()).toBe(100);expect(fetch).not.toHaveBeenCalled();
  });
  it('completes SSE generation, survives query 503 and charges once',async()=>{
    let submissions=0,queries=0;
    upstream=async(url,init)=>{
      if(init.method==='POST'){submissions++;expect(JSON.parse(init.body)).toMatchObject({model:'video-public',duration:6,ratio:'16:9'});expect(init.headers['Idempotency-Key']).toBeTruthy();expect(JSON.parse(latest().metadata).zonghengSubmissionStarted).toBeTruthy();return Response.json({task_id:'vid_sse',next_poll_seconds:3});}
      expect(url).toBe('https://channel.invalid/v1/tasks/vid_sse');if(++queries===1)return new Response('busy',{status:503});
      return Response.json({status:'succeeded',video_url:'https://media.invalid/done.mp4'});
    };
    expect(await(await post('/api/video/generate',request)).text()).toContain('"type":"complete"');
    expect(latest().status).toBe('completed');expect(balance()).toBe(98);expect(submissions).toBe(1);expect(queries).toBe(2);
    expect(JSON.parse(latest().metadata).managedSpecification).toBeUndefined();
  });
  it('uploads local frame bytes before creating the video and preserves all platform options',async()=>{
    let uploads=0;
    upstream=async(url,init)=>{
      if(url.endsWith('/v1/media')){expect(init.body).toBeInstanceOf(FormData);return Response.json({success:true,data:[{url:'https://channel.invalid/media/'+(++uploads)+'.png'}]});}
      if(init.method==='POST'){expect(JSON.parse(init.body)).toMatchObject({start_frame:'https://channel.invalid/media/1.png',end_frame:'https://channel.invalid/media/2.png',generate_audio:false,negative_prompt:'模糊',quality:'standard'});return Response.json({task_id:'vid_frames'});}
      return Response.json({status:'succeeded',url:'https://media.invalid/done.mp4'});
    };
    const response=await post('/v1/videos',{...request,seconds:6,start_frame:reference,end_frame:reference,generate_audio:false,negative_prompt:'模糊',quality:'standard'});
    expect(response.status).toBe(202);await vi.waitFor(()=>expect(latest().status).toBe('completed'));expect(uploads).toBe(2);expect(balance()).toBe(98);
  });
  it.each(['/api/video/generate','/v1/videos'])('retains uncertain submissions at %s without refund or resubmission',async endpoint=>{
    upstream=async()=>{throw Error('timeout');};await(await post(endpoint,request)).text();expect(latest().status).toBe('review');expect(balance()).toBe(98);expect(fetch).toHaveBeenCalledTimes(1);
    video.resumeAllPendingVideoTasks();expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['/api/video/generate','/v1/videos'])('hides provider identity in rejection responses at %s while retaining diagnostics and refunding once',async endpoint=>{
    const detail='视频时长不符合当前模型要求，请选择支持的时长后重试';
    upstream=async()=>Response.json({error_code:'invalid_parameters',error_detail:detail},{status:400});
    const response=await post(endpoint,request),text=await response.text();
    expect(text).toContain('视频时长不符合当前模型要求');expect(text).not.toContain('纵横科技');expect(text).not.toContain('invalid_parameters');
    expect(latest().status).toBe('failed');expect(JSON.parse(latest().metadata!).error).toContain('纵横科技提交失败');
    expect(balance()).toBe(100);expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['/api/video/generate','/v1/videos'])('refunds confirmed rejection at %s',async endpoint=>{
    upstream=async()=>Response.json({error:{message:'余额不足'}},{status:402});await(await post(endpoint,request)).text();expect(latest().status).toBe('failed');expect(balance()).toBe(100);expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('returns a local API task, handles processing and preserves original channel after restart',async()=>{
    let queries=0;
    upstream=async(url,init)=>init.method==='POST'?Response.json({task_id:'vid_api',next_poll_seconds:2}):Response.json(++queries===1?{status:'processing',next_poll_seconds:3}:{status:'succeeded',result_url:'https://media.invalid/result.mp4'});
    const response=await post('/v1/videos',{...request,reference_videos:['https://media.invalid/ref.mp4'],reference_audios:['https://media.invalid/ref.wav']});
    expect(response.status).toBe(202);expect(await response.json()).toMatchObject({task_id:'task_'+latest().id,retry_after:2});
    await vi.waitFor(()=>expect(latest().status).toBe('completed'));expect(balance()).toBe(98);expect(queries).toBe(2);
    const posts=vi.mocked(fetch).mock.calls.filter(([,init])=>init?.method==='POST');expect(posts).toHaveLength(1);expect(JSON.parse(posts[0][1]!.body as string)).toMatchObject({reference_videos:['https://media.invalid/ref.mp4'],reference_audios:['https://media.invalid/ref.wav']});
  });
  it('moves interrupted POST without an ID to review, never refunds or replays it',()=>{
    db.insert(contents).values({userId:1,type:'video',status:'processing',modelId:request.model,cost:2,metadata:JSON.stringify({channelId:db.select().from(channels).get()!.id,zonghengSubmissionStarted:'before restart'})}).run();
    video.resumeAllPendingVideoTasks();expect(latest().status).toBe('review');expect(fetch).not.toHaveBeenCalled();expect(balance()).toBe(100);
  });
  it('recovers a reviewed video using its existing charge',async()=>{
    db.insert(contents).values({userId:1,type:'video',status:'review',modelId:request.model,cost:2,metadata:JSON.stringify({channelId:db.select().from(channels).get()!.id,videoId:'vid_recover',zonghengSubmissionStarted:'today',requiresReview:true})}).run();
    upstream=async url=>{expect(url).toBe('https://channel.invalid/v1/tasks/vid_recover');return Response.json({status:'succeeded',video_url:'https://media.invalid/done.mp4'});};
    expect(await VideoRecoveryService.recover(latest().id)).toMatchObject({status:'completed',chargedAmount:0});expect(balance()).toBe(100);
  });
  it('generates and saves website images with the mapped public model, no provider key on downloads',async()=>{
    upstream=async(url,init)=>{
      if(init.method==='POST'){expect(JSON.parse(init.body)).toEqual({model:'image-public',prompt:'产品图',size:'2048x2048',n:2,aspect_ratio:'1:1'});return Response.json({data:[{url:'https://channel.invalid/image1.png'},{url:'https://channel.invalid/image2.png'}]});}
      expect(init.headers?.Authorization).toBeUndefined();return new Response(png,{headers:{'Content-Type':'image/png'}});
    };
    const response=await post('/api/image-gen/generate',{model:'ZH-image-public',prompt:'产品图',n:2,resolution:'2K'});
    expect(await response.text()).toContain('"type":"complete"');expect(latest().status).toBe('completed');expect(balance()).toBe(96);expect(JSON.parse(latest().metadata).imageUrls).toHaveLength(2);
  });
  it('generates API images, localizes them and settles partial output by actual count',async()=>{
    upstream=async(_url,init)=>init.method==='POST'?Response.json({data:[{url:'https://channel.invalid/image.png'}]}):new Response(png,{headers:{'Content-Type':'image/png'}});
    const response=await post('/v1/images/generations',{model:'ZH-image-public',prompt:'产品图',n:2});
    expect(response.status).toBe(200);const data=await response.json() as any;expect(data.data[0].url).toContain('/api/uploads/zongheng_api_');expect(latest().status).toBe('completed');expect(balance()).toBe(98);
  });
  it('uses output_resolution for API image size and legacy resolution pricing',async()=>{
    sqlite.prepare('UPDATE model_pricing SET extra_params=? WHERE model_pattern=?').run(JSON.stringify({'2K':5}),'ZH-image-public');
    upstream=async(_url,init)=>{
      if(init.method==='POST'){expect(JSON.parse(init.body).size).toBe('2048x2048');return Response.json({data:[{url:'https://channel.invalid/image.png'}]});}
      return new Response(png,{headers:{'Content-Type':'image/png'}});
    };
    const response=await post('/v1/images/generations',{model:'ZH-image-public',prompt:'产品图',output_resolution:'2K'});
    expect(response.status).toBe(200);expect(balance()).toBe(95);
  });
  it.each(['/api/image-gen/generate','/v1/images/generations'])('rejects undocumented mask aliases at %s before charging',async endpoint=>{
    const response=await post(endpoint,{model:'ZH-image-public',prompt:'产品图',mask:reference});
    expect(response.status).toBe(400);expect(balance()).toBe(100);expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['/api/image-gen/generate','/v1/images/generations'])('keeps uncertain image charges at %s for review',async endpoint=>{
    upstream=async()=>{throw Error('timeout');};await(await post(endpoint,{model:'ZH-image-public',prompt:'产品图'})).text();expect(latest().status).toBe('review');expect(balance()).toBe(98);expect(fetch).toHaveBeenCalledTimes(1);
    expect((sqlite.prepare('SELECT state FROM billing_reservations').get() as any).state).toBe('review');
  });
  it.each(['/api/image-gen/generate','/v1/images/generations'])('rejects undocumented reference images at %s before charging',async endpoint=>{
    const response=await post(endpoint,{model:'ZH-image-public',prompt:'产品图',reference_images:[reference]});expect(response.status).toBe(400);expect(balance()).toBe(100);expect(fetch).not.toHaveBeenCalled();
  });
  it.each([false,true])('forwards GPT requests with stream=%s through the existing legacy proxy',async stream=>{
    upstream=async(url,init)=>{
      expect(url).toBe('https://channel.invalid/v1/chat/completions');expect(JSON.parse(init.body)).toMatchObject({model:'gpt-public',stream});
      const result={model:'gpt-public',choices:[{message:{role:'assistant',content:'hello'}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}};
      return stream?new Response('data: '+JSON.stringify(result)+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}}):Response.json(result);
    };
    const response=await post('/v1/chat/completions',{model:'ZH-gpt-public',messages:[{role:'user',content:'hello'}],stream});expect(response.status).toBe(200);expect(await response.text()).toContain('hello');expect(balance()).toBeCloseTo(99.99998,6);
  });
});
