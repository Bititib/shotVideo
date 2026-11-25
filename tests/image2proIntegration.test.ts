import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/services/videoLocalizationService.js',()=>({downloadAndLocalizeVideo:vi.fn(async()=>'/uploads/minikey-test.mp4')}));
vi.mock('../server/routes/imageGen.js',()=>({localizeGeneratedImage:vi.fn(async()=>'/uploads/minikey-test.png')}));
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService.js';
import { localizeGeneratedImage } from '../server/routes/imageGen.js';

import { reserveUserCharge, linkReservationContent } from '../server/services/billingReservation.js';
import { activeSpecificationTasks } from '../server/services/videoRecoveryAction.js';
import { db, sqlite } from '../server/db/index.js';
import { channels, contents, models, modelPricing, settings, users } from '../server/db/schema.js';
import { ChannelService } from '../server/services/channelService.js';
import { migrateImage2proIdentity } from '../server/services/image2proModelIdentity.js';
import { saveModelSpecification, getModelSpecification } from '../server/services/modelRoutingService.js';
import { handleSpecificationGeneration, resumeSpecificationTasks } from '../server/services/specificationGenerationService.js';
import { defaultRoutingLimits } from '../shared/modelRouting.js';
beforeEach(() => {
  if(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='video_submission_receipts'").get())sqlite.exec('DELETE FROM video_submission_receipts');
  db.delete(contents).run(); db.delete(settings).run(); db.delete(models).run(); db.delete(channels).run(); db.delete(modelPricing).run(); db.delete(users).run();
  db.insert(users).values({ id: 1, email: 'mini@test.invalid', username: 'test', passwordHash: 'test', balance: 100 }).run();
  const channelId = ChannelService.createChannel({ name: 'miniKey', type: 'image2pro', baseUrl: 'https://api.image2pro.top/v1', apiKey: 'mk_test', supportedModels: ['30video'], maxRetries: 3 });
  db.insert(models).values({modelId:'30video',provider:'image2pro',displayName:'测试',capabilities:'["video"]',isActive:1}).run();
  db.insert(modelPricing).values({modelPattern:'30video',billingType:'per_call',inputPrice:2,outputPrice:0}).run();
  const limits = defaultRoutingLimits();
  saveModelSpecification({modelId:'30video',kind:'video',enabled:true,aliases:[],limits,routes:[{id:'mini',channelId,upstreamModel:'30video',executionModel:'30video',enabled:true,limits,cost:null,costUnit:'unknown',resolutionCosts:{},priority:0}]});
});
afterEach(() => {vi.unstubAllGlobals();vi.restoreAllMocks();});
afterAll(() => sqlite.close());
function res() { const r:any={headersSent:false};r.status=vi.fn(()=>r);r.json=vi.fn(body=>{r.body=body;return r;});r.setHeader=vi.fn();r.flushHeaders=vi.fn();r.write=vi.fn();r.end=vi.fn();return r; }
const req = () => ({userId:1,headers:{},protocol:'https',get:()=> 'app.example',body:{model:'30video',prompt:'海浪',seconds:5,aspect_ratio:'9:16'}} as any);

const catalog={data:[{id:'30video',metadata:{type:'video',media_contract:1,durations:[5],max_images:0,aspect_ratios:['9:16'],resolutions:['720p']}}]};
const mock=(reply:()=>Promise<Response>)=>vi.stubGlobal('fetch',vi.fn(async(url:any,init:any)=>String(url).endsWith('/models')?Response.json(catalog):reply()));
it('refunds explicit creation rejection once through the actual entry and recovery',async()=>{
 mock(async()=>Response.json({error:{message:'积分不足',type:'invalid_request_error'}},{status:402}));
 const response=res(); await handleSpecificationGeneration(req(),response,'video');expect(response.body?.error).toBeUndefined();
 expect(db.select().from(contents).get()?.status).toBe('failed');expect(db.select().from(users).get()?.balance).toBe(100);
 resumeSpecificationTasks();resumeSpecificationTasks();await new Promise(r=>setTimeout(r,20));
 expect(db.select().from(users).get()?.balance).toBe(100);expect(fetch).toHaveBeenCalledTimes(2);
});
it('persists the request before sending and does not replay unknown acceptance',async()=>{
 mock(async()=>{const meta=JSON.parse(db.select().from(contents).get()!.metadata);expect(meta.image2proRequest.key).toBeTruthy();throw new Error('disconnect');});
 await handleSpecificationGeneration(req(),res(),'video');const row=db.select().from(contents).get()!;
 expect(JSON.parse(row.metadata).requiresReview).toBe(true);expect(db.select().from(users).get()?.balance).toBe(98);
 resumeSpecificationTasks();await new Promise(r=>setTimeout(r,20));expect(fetch).toHaveBeenCalledTimes(2);
});
it.each(['failed','completed'])('handles immediate %s after persisting the ID',async status=>{
 const id='a'.repeat(32);mock(async()=>Response.json({id,status,metadata:{url:'https://cdn.example/video.mp4'},error:status==='failed'?'审核拒绝':null}));
 await handleSpecificationGeneration(req(),res(),'video');const row=db.select().from(contents).get()!;
 expect(row.status, row.metadata).toBe(status);expect(JSON.parse(row.metadata).videoId).toBe(id);expect(db.select().from(users).get()?.balance).toBe(status==='failed'?100:98);expect(fetch).toHaveBeenCalledTimes(2);
});

function imageRequest(){
 const channel=db.select().from(channels).get()!;
 db.insert(models).values({modelId:'test-image',provider:'image2pro',displayName:'图片',capabilities:'["image"]',isActive:1}).run();
 db.insert(modelPricing).values({modelPattern:'test-image',billingType:'per_call',inputPrice:2,outputPrice:0}).run();
 sqlite.prepare('UPDATE channels SET supported_models=?').run('["30video","test-image"]');
 const limits={...defaultRoutingLimits(),resolutions:['2K'],ratios:['1:1']};
 saveModelSpecification({modelId:'test-image',kind:'image',enabled:true,aliases:[],limits,routes:[{id:'image',channelId:channel.id,upstreamModel:'test-image',executionModel:'test-image',enabled:true,limits,cost:null,costUnit:'unknown',resolutionCosts:{},priority:0}]});
 return {...req(),body:{model:'test-image',prompt:'海边',resolution:'2K',aspect_ratio:'1:1'}};
}
it.each(['supported', 'unsupported', 'conflict'])('prices a 1024x1024 Image2Pro request before reservation (%s)', async scenario => {
 const request = imageRequest();
 const spec = getModelSpecification('test-image')!;
 const limits = {...spec.limits, maxImages:1, resolutions: scenario === 'unsupported' ? ['4K'] : ['4K', '1K']};
 saveModelSpecification({...spec, limits, routes:spec.routes.map(route => ({...route, limits}))});
 sqlite.prepare('UPDATE model_pricing SET extra_params=? WHERE model_pattern=?').run(JSON.stringify({'1K':1,'4K':4}), 'test-image');
 request.path = '/images/edits';
 request.files = [{fieldname:'image', mimetype:'image/png', buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6n8AAAAASUVORK5CYII=', 'base64')}];
 request.body = {model:'test-image', prompt:'海边', size:'1024x1024', ...(scenario === 'conflict' ? {resolution:'4K'} : {})};
 vi.stubGlobal('fetch', vi.fn(async (_url:any, init:any) => {
  expect(JSON.parse(init.body)).toMatchObject({size:'1024x1024', resolution:'1K', aspect_ratio:'1:1', images:[expect.any(String)]});
  return Response.json({id:'d'.repeat(32),status:'completed',data:[{url:'https://cdn.example/image.png'}]});
 }));
 const response = res();
 await handleSpecificationGeneration(request, response, 'image');
 if (scenario === 'supported') {
  expect(db.select().from(contents).get()).toMatchObject({status:'completed', cost:1});
  expect(fetch).toHaveBeenCalledOnce();
  expect(db.select().from(users).get()?.balance).toBe(99);
 } else {
  expect(response.status).toHaveBeenCalledWith(400);
  expect(fetch).not.toHaveBeenCalled();
  expect(db.select().from(contents).get()).toBeUndefined();
  expect(db.select().from(users).get()?.balance).toBe(100);
 }
});
it('image rejection refunds once through the image generation entry',async()=>{
 const request=imageRequest();vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error:{message:'参数不支持'}},{status:400})));
 await handleSpecificationGeneration(request,res(),'image');expect(db.select().from(contents).get()?.status).toBe('failed');expect(db.select().from(users).get()?.balance).toBe(100);
 resumeSpecificationTasks();expect(fetch).toHaveBeenCalledOnce();
});
it('image result saving resumes without resubmission or another charge',async()=>{
 const request=imageRequest(),id='d'.repeat(32);vi.mocked(localizeGeneratedImage).mockRejectedValueOnce(new Error('temporary disk failure'));
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({id,status:'completed',data:[{url:'https://cdn.example/image.png'}]})));
 await handleSpecificationGeneration(request,res(),'image');expect(JSON.parse(db.select().from(contents).get()!.metadata).requiresReview).toBe(true);
 resumeSpecificationTasks();await vi.waitFor(()=>expect(db.select().from(contents).get()?.status).toBe('completed'));
 expect(fetch).toHaveBeenCalledOnce();expect(db.select().from(users).get()?.balance).toBe(98);
});
it('sync keeps public IDs and existing prices and activation',async()=>{
 const channel=db.select().from(channels).get()!;
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({data:[{id:'catalog-image',metadata:{type:'image'}},{id:'catalog-video',metadata:{type:'video',durations:[4,6,8],supports_frame_control:false,supports_reference_images:true,resolutions:['720p'],aspect_ratios:['16:9','9:16']}},{id:'text-model',metadata:{type:'text'}}]})));
 const first=await ChannelService.syncModels(channel.id);expect(first.models).toEqual(['catalog-image','catalog-video','text-model']);
 expect(db.select().from(models).all().find(m=>m.modelId==='catalog-image')?.isActive).toBe(0);
 sqlite.prepare('UPDATE models SET is_active=1 WHERE model_id=?').run('catalog-image');
 db.insert(modelPricing).values({modelPattern:'catalog-image',billingType:'per_call',inputPrice:7,outputPrice:0}).run();
 await ChannelService.syncModels(channel.id);expect(db.select().from(models).all().find(m=>m.modelId==='catalog-image')?.isActive).toBe(1);
 expect(db.select().from(modelPricing).all().find(m=>m.modelPattern==='catalog-image')?.inputPrice).toBe(7);
});

it.each([
 [{type:'video',durations:[5],supports_frame_control:true,supports_reference_images:true,aspect_ratios:['9:16'],resolutions:['720p']},'flow'],
 [{type:'video',duration_min:4,duration_max:12,max_images:8,modes:['text','reference','keyframe'],aspect_ratios:['9:16'],size:'720p'},'legacy']
])('maps provider capabilities to its own video fields (%s)',async(md,profile)=>{
 const {submitSpecificationVideo}=await import('../server/services/specificationAdapters.js');
 const channel=ChannelService.getChannelRaw(db.select().from(channels).get()!.id)!;
 const sent:any[]=[];vi.stubGlobal('fetch',vi.fn(async(url:any,init:any)=>{if(String(url).endsWith('/models'))return Response.json({data:[{id:'30video',metadata:md}]});sent.push(JSON.parse(init.body));return Response.json({id:'c'.repeat(32),status:'processing'});}));
 await submitSpecificationVideo({channel,route:{upstreamModel:'30video',executionModel:'30video'}} as any,{prompt:'海浪',input:{seconds:5,resolution:'720p',ratio:'9:16'},images:[],videos:[],audios:[],firstFrame:'https://cdn.example/first.png',lastFrame:'',body:{},publicBaseUrl:'https://app.example'} as any,()=>{});
 if(profile==='flow'){expect(sent[0].reference_images).toEqual([{url:'https://cdn.example/first.png',role:'first_frame'}]);expect(sent[0].aspect_ratio).toBe('9:16');expect(sent[0].images).toBeUndefined();}
 else {expect(sent[0].first_frame).toBe('https://cdn.example/first.png');expect(sent[0].mode).toBe('keyframe');expect(sent[0].size).toBe('720p');}
});
it('keeps an accepted image processing across a long wait and temporary query failure', async () => {
 const request = imageRequest(), id = 'f'.repeat(32);
 let posts = 0, queries = 0;
 vi.useFakeTimers();
 try {
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
   if (init?.method === 'POST') {
    posts++;
    return Response.json({id, status:'processing', poll_after_ms: 21 * 60_000});
   }
   expect(String(url)).toContain('/images/tasks/' + id);
   queries++;
   if (queries === 1) return Response.json({id, status:'processing'});
   if (queries === 2) return Response.json({error:{message:'temporary'}}, {status:503, headers:{'Retry-After':'30'}});
   return Response.json({id,status:'completed',data:[{url:'https://cdn.example/original.png'}]});
  }));
  const run = handleSpecificationGeneration(request, res(), 'image');
  await vi.advanceTimersByTimeAsync(21 * 60_000 + 10_000);
  const row = db.select().from(contents).get()!;
  expect(row.status).toBe('processing');
  const meta = JSON.parse(row.metadata);
  expect(meta.requiresReview).toBeFalsy();
  expect(meta.upstreamQueryError).toContain('503');
  expect(meta.upstreamTaskId).toBe(id);
  resumeSpecificationTasks();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(queries).toBe(2);
  await vi.advanceTimersByTimeAsync(1);
  await run;
  expect(db.select().from(contents).get()?.status).toBe('completed');
  expect(posts).toBe(1);
  expect(queries).toBe(3);
  expect(db.select().from(users).get()?.balance).toBe(98);
 } finally { vi.useRealTimers(); }
});

it.each([false,true])('image recovery keeps the original task after remapping or identity/type change (%s)',async rename=>{
 const request=imageRequest(),id='f'.repeat(32);let queries=0,posts=0;
 vi.stubGlobal('fetch',vi.fn(async(url:any,init:any)=>{
  if(init?.method==='POST'){posts++;return Response.json({id,status:'processing'});}
  queries++;expect(String(url)).toContain('/images/tasks/'+id);
  if(queries===1)return Response.json({error:{message:'渠道鉴权异常'}},{status:403});
  return Response.json({id,status:'completed',data:[{url:'https://cdn.example/original.png'}]});
 }));
 await handleSpecificationGeneration(request,res(),'image');expect(db.select().from(users).get()?.balance).toBe(98);
 expect(JSON.parse(db.select().from(contents).get()!.metadata).requiresReview).toBe(true);
 const model = db.select().from(models).all().find(m => m.modelId === 'test-image')!;
 if (rename) sqlite.transaction(() => migrateImage2proIdentity(model, {modelId:'renamed-image-as-text',displayName:'new text',upstreamModel:'new-text',kind:'text',limits:defaultRoutingLimits()}, db.select().from(channels).get()!.id))();
 else {
  const spec = getModelSpecification('test-image')!;
  saveModelSpecification({...spec, routes:spec.routes.map(route => ({...route, upstreamModel:'new-image'}))});
 }
 resumeSpecificationTasks();await vi.waitFor(()=>expect(db.select().from(contents).get()?.status).toBe('completed'));
 expect(posts).toBe(1);expect(queries).toBe(2);expect(db.select().from(users).get()?.balance).toBe(98);
});

it('finishes an original video after an in-flight rename and conversion to text without submitting again',async()=>{
 const id='b'.repeat(32);let posts=0;
 vi.mocked(downloadAndLocalizeVideo).mockImplementationOnce(async()=>{const model=db.select().from(models).get()!;sqlite.transaction(()=>migrateImage2proIdentity(model,{modelId:'renamed-video-as-text',displayName:'renamed-video-as-text',upstreamModel:'new-text',kind:'text',limits:defaultRoutingLimits()},db.select().from(channels).get()!.id))();throw new Error('temporary storage failure');});
 vi.stubGlobal('fetch',vi.fn(async(url:any,init:any)=>{
  if(String(url).endsWith('/models'))return Response.json(catalog);
  if(init?.method==='POST')posts++;else expect(String(url)).toContain('/videos/'+id);
  return Response.json({id,status:'completed',metadata:{url:'https://cdn.example/old.mp4'}});
 }));
 await handleSpecificationGeneration(req(),res(),'video');
 expect(db.select().from(contents).get()?.status).toBe('completed');
 expect(db.select().from(models).get()).toMatchObject({modelId:'renamed-video-as-text',isActive:0});
 expect(posts).toBe(1);expect(db.select().from(users).get()?.balance).toBe(98);expect(db.select().from(contents).get()?.modelId).toBe('30video');
});
