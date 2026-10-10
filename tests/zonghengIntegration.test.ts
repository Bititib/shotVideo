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
      return '"' + c.name + '" ' + c.getSQLType() + (c.primary ? ' PRIMARY KEY' : '') + def;
    });
    sqlite.exec('CREATE TABLE "' + config.name + '" (' + columns.join(',') + ')');
  }
  return { sqlite, db: drizzle(sqlite, { schema }) };
});
vi.mock('../server/config/env.js', () => ({ env: { NODE_ENV: 'test', JWT_SECRET: 'test', VIDEO_TASK_POLL_TIMEOUT_MS: 1, PORT: 9876 } }));
vi.mock('../server/middleware/auth.js', () => ({ authMiddleware: (req: any, _res: any, next: any) => { req.userId = 1; next(); } }));
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
  for(const table of ['contents','channels','models','model_pricing','users','api_logs'])sqlite.exec('DELETE FROM '+table);
  sqlite.exec('DROP TABLE IF EXISTS billing_reservations');
  db.insert(users).values({id:1,email:'test',username:'test',passwordHash:'test',balance:100}).run();
  for(const [id,kind] of [['zongheng-video-public','video'],['zongheng-image-public','image'],['zongheng-gpt-public','text']]){
    db.insert(models).values({modelId:id,displayName:id,provider:'zongheng',capabilities:JSON.stringify([kind])}).run();
    db.insert(modelPricing).values({modelPattern:id,billingType:kind==='text'?'per_token':'per_call',inputPrice:kind==='text'?1:2,outputPrice:2}).run();
  }
  ChannelService.createChannel({name:'纵横科技',type:'zongheng',baseUrl:'https://channel.invalid/v1/',apiKey:'test-key',
    supportedModels:['zongheng-video-public','zongheng-image-public','zongheng-gpt-public'],
    modelMapping:{'zongheng-video-public':'video-public','zongheng-image-public':'image-public','zongheng-gpt-public':'gpt-public'}});
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
const request={model:'zongheng-video-public',prompt:'产品视频',video_length:6,resolution:'720p',aspect_ratio:'16:9'};
describe('Zongheng legacy entry points, isolated database and simulated provider',()=>{
  it('discovers namespaced disabled models and preserves provider public IDs',async()=>{
    upstream=async url=>{expect(url).toBe('https://channel.invalid/v1/models');return Response.json({data:[{id:'gpt-image-2',type:'image'},{id:'custom-model',type:'video'},{id:'gpt-public'}]});};
    const result=await ChannelService.syncModels(db.select().from(channels).get()!.id);
    expect(result.models).toEqual(['zongheng-gpt-image-2','zongheng-custom-model','zongheng-gpt-public']);
    expect(db.select().from(models).all().find(m=>m.modelId==='zongheng-custom-model')).toMatchObject({isActive:0,capabilities:'["video"]'});
    expect(JSON.parse(db.select().from(channels).get()!.modelMapping)['zongheng-custom-model']).toBe('custom-model');
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
    const response=await post('/api/image-gen/generate',{model:'zongheng-image-public',prompt:'产品图',n:2,resolution:'2K'});
    expect(await response.text()).toContain('"type":"complete"');expect(latest().status).toBe('completed');expect(balance()).toBe(96);expect(JSON.parse(latest().metadata).imageUrls).toHaveLength(2);
  });
  it('generates API images, localizes them and settles partial output by actual count',async()=>{
    upstream=async(_url,init)=>init.method==='POST'?Response.json({data:[{url:'https://channel.invalid/image.png'}]}):new Response(png,{headers:{'Content-Type':'image/png'}});
    const response=await post('/v1/images/generations',{model:'zongheng-image-public',prompt:'产品图',n:2});
    expect(response.status).toBe(200);const data=await response.json() as any;expect(data.data[0].url).toContain('/api/uploads/zongheng_api_');expect(latest().status).toBe('completed');expect(balance()).toBe(98);
  });
  it('uses output_resolution for API image size and legacy resolution pricing',async()=>{
    sqlite.prepare('UPDATE model_pricing SET extra_params=? WHERE model_pattern=?').run(JSON.stringify({'2K':5}),'zongheng-image-public');
    upstream=async(_url,init)=>{
      if(init.method==='POST'){expect(JSON.parse(init.body).size).toBe('2048x2048');return Response.json({data:[{url:'https://channel.invalid/image.png'}]});}
      return new Response(png,{headers:{'Content-Type':'image/png'}});
    };
    const response=await post('/v1/images/generations',{model:'zongheng-image-public',prompt:'产品图',output_resolution:'2K'});
    expect(response.status).toBe(200);expect(balance()).toBe(95);
  });
  it.each(['/api/image-gen/generate','/v1/images/generations'])('rejects undocumented mask aliases at %s before charging',async endpoint=>{
    const response=await post(endpoint,{model:'zongheng-image-public',prompt:'产品图',mask:reference});
    expect(response.status).toBe(400);expect(balance()).toBe(100);expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['/api/image-gen/generate','/v1/images/generations'])('keeps uncertain image charges at %s for review',async endpoint=>{
    upstream=async()=>{throw Error('timeout');};await(await post(endpoint,{model:'zongheng-image-public',prompt:'产品图'})).text();expect(latest().status).toBe('review');expect(balance()).toBe(98);expect(fetch).toHaveBeenCalledTimes(1);
    expect((sqlite.prepare('SELECT state FROM billing_reservations').get() as any).state).toBe('review');
  });
  it.each(['/api/image-gen/generate','/v1/images/generations'])('rejects undocumented reference images at %s before charging',async endpoint=>{
    const response=await post(endpoint,{model:'zongheng-image-public',prompt:'产品图',reference_images:[reference]});expect(response.status).toBe(400);expect(balance()).toBe(100);expect(fetch).not.toHaveBeenCalled();
  });
  it.each([false,true])('forwards GPT requests with stream=%s through the existing legacy proxy',async stream=>{
    upstream=async(url,init)=>{
      expect(url).toBe('https://channel.invalid/v1/chat/completions');expect(JSON.parse(init.body)).toMatchObject({model:'gpt-public',stream});
      const result={model:'gpt-public',choices:[{message:{role:'assistant',content:'hello'}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}};
      return stream?new Response('data: '+JSON.stringify(result)+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}}):Response.json(result);
    };
    const response=await post('/v1/chat/completions',{model:'zongheng-gpt-public',messages:[{role:'user',content:'hello'}],stream});expect(response.status).toBe(200);expect(await response.text()).toContain('hello');expect(balance()).toBeCloseTo(99.99998,6);
  });
});
