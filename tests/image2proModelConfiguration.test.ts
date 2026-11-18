import express from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../server/config/env.js';
import { ChannelService } from '../server/services/channelService.js';
vi.mock('../server/services/videoLocalizationService.js',()=>({downloadAndLocalizeVideo:vi.fn(async()=>'/uploads/manual-i2p.mp4')}));
import { handleSpecificationGeneration } from '../server/services/specificationGenerationService.js';
import apiRouter from '../server/routes/v1.js';
import channelRoutes from '../server/routes/channels.js';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js',async()=> (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../server/db/index.js';
import { channels, models, modelPricing, users, contents } from '../server/db/schema.js';
import { defaultRoutingLimits } from '../shared/modelRouting.js';
import type { ChannelModelDraft } from '../shared/channelModelConfiguration.js';
import { listAuthorizedChannelModels, listChannelModelConfigurations, saveChannelModelConfiguration, previewAuthorizedChannelModelRequest } from '../server/services/channelModelConfigurationService.js';
import { getModelSpecification, selectModelRoutes } from '../server/services/modelRoutingService.js';
import { submitSpecificationVideo, generateSpecificationImage, pollSpecificationVideo } from '../server/services/specificationAdapters.js';
import { pruneChannelCatalogBindings } from '../server/services/channelCatalogBindings.js';
let serial=0;
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
function setup(kind:'text'|'image'|'video',extra={}) {
 const model='manual-i2p-'+(++serial);
 const channelId=Number(db.insert(channels).values({name:model,type:'image2pro',baseUrl:'https://api.image2pro.top/v1',apiKey:'private-test-key',status:1}).run().lastInsertRowid);
 const metadata={type:kind,...(kind==='video'?{media_contract:1,durations:[5,10]}:{}),resolutions:['720p'],aspect_ratios:['16:9'],max_images:2,...extra};
 const entry={id:model,metadata};
 const fetcher=vi.fn<typeof fetch>().mockImplementation(async()=>Response.json({data:[entry]}));vi.stubGlobal('fetch',fetcher);
 const draft:ChannelModelDraft={modelId:model,displayName:model,upstreamModel:model,kind,limits:{...defaultRoutingLimits(),maxImages:2,resolutions:['720p'],ratios:['16:9'],duration:{mode:'options',min:5,max:10,step:1,values:[5,10]}}};
 return {model,channelId,entry,fetcher,draft};
}
it.each(['image','video'] as const)('saves %s with actual routing, preview and original-task query; preserves prices on sync',async kind=>{
 const {model,channelId,fetcher,draft,entry}=setup(kind);
 const first=listChannelModelConfigurations(channelId);expect(first).toMatchObject({canAdd:true,image2pro:true});
 expect(await listAuthorizedChannelModels(channelId)).toEqual([expect.objectContaining({id:model,kind,limits:expect.objectContaining({maxImages:2})})]);
 const saved=await saveChannelModelConfiguration(channelId,draft,first.version);expect(saved.models[0]).toMatchObject({editable:true,enabled:false});
 const spec=getModelSpecification(model)!;
 const input={seconds:5,ratio:'16:9',resolution:'720p',images:0,videos:0,audios:0,outputs:1,firstFrame:false,lastFrame:false};
 expect(selectModelRoutes(spec,input)).toEqual([]);
 db.update(models).set({isActive:1}).where(eq(models.modelId,model)).run();
 db.insert(modelPricing).values({modelPattern:model,billingType:'per_call',inputPrice:7}).run();
 const preview=await previewAuthorizedChannelModelRequest(channelId,draft);
 const [target]=selectModelRoutes(spec,input);expect(target.channel.id).toBe(channelId);
 const taskId='a'.repeat(32);const starts=vi.fn(),persist=vi.fn();
 fetcher.mockImplementation(async(url,options)=>String(url).endsWith('/models')?Response.json({data:[entry]}):Response.json({id:taskId,status:'completed',...(kind==='image'?{data:[{url:'https://result.test/image.png'}]}:{url:'https://result.test/video.mp4'})}));
 const request={prompt:'请求体预览示例',input,images:[],videos:[],audios:[],firstFrame:'',lastFrame:'',body:{},publicBaseUrl:'https://site.test'};
 if(kind==='video'){await expect(submitSpecificationVideo(target,request,starts)).resolves.toBe(taskId); await expect(pollSpecificationVideo(target.channel,taskId)).resolves.toMatchObject({status:'completed'});}
 else {await expect(generateSpecificationImage(target,request,starts,persist)).resolves.toMatchObject({imageUrl:'https://result.test/image.png'});expect(persist).toHaveBeenCalledWith(taskId);}
 const paid=fetcher.mock.calls.filter(([,o])=>o?.method==='POST');expect(paid).toHaveLength(1);expect(paid[0][0]).toBe('https://api.image2pro.top'+preview.path);expect(JSON.parse(String(paid[0][1]?.body))).toEqual(preview.body);
 expect(starts).toHaveBeenCalled();expect(paid[0][1]?.headers).toMatchObject({'Idempotency-Key':expect.any(String),...preview.headers});
 await ChannelService.syncModels(channelId);expect(getModelSpecification(model)).toEqual(spec);expect(pruneChannelCatalogBindings(sqlite,ChannelService.getChannelRaw(channelId)!)).toEqual([]);
 expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern,model)).get()?.inputPrice).toBe(7);
 expect(db.select().from(models).where(eq(models.modelId,model)).get()?.isActive).toBe(1);
});
it('adds and edits text without a media specification and retains its mapping',async()=>{
 const {model,channelId,draft}=setup('text');
 const saved=await saveChannelModelConfiguration(channelId,draft,listChannelModelConfigurations(channelId).version);
 expect(saved.models[0]).toMatchObject({editable:true,enabled:false,capabilities:['text']});expect(getModelSpecification(model)).toBeUndefined();
 expect(await previewAuthorizedChannelModelRequest(channelId,draft)).toMatchObject({path:'/v1/chat/completions',body:{model}});
 await saveChannelModelConfiguration(channelId,{...draft,displayName:model+' title'},saved.version);
 expect(JSON.parse(ChannelService.getChannelRaw(channelId)!.modelMapping)[model]).toBe(model);
});
it.each(['type','resolution','duration','reference','outputs','unknown'] as const)('rejects invalid %s before any configuration or paid request',async scenario=>{
 const {channelId,draft,model,fetcher}=setup('video');
 if(scenario==='type')draft.kind='text';
 if(scenario==='resolution')draft.limits.resolutions=['4K'];
 if(scenario==='duration')draft.limits.duration.values=[6];
 if(scenario==='reference')draft.limits.maxImages=3;
 if(scenario==='outputs')draft.limits.maxOutputs=2;
 if(scenario==='unknown'){draft.modelId='unknown';draft.upstreamModel='unknown';}
 await expect(saveChannelModelConfiguration(channelId,draft,listChannelModelConfigurations(channelId).version)).rejects.toThrow();
 expect(getModelSpecification(model)).toBeUndefined();expect(db.select().from(models).where(eq(models.modelId,model)).get()).toBeUndefined();expect(fetcher.mock.calls.every(([,o])=>o?.method!=='POST')).toBe(true);
});
it('rejects stale version and a key change during catalog verification',async()=>{
 const {channelId,draft,fetcher,entry}=setup('video');const first=listChannelModelConfigurations(channelId);
 await expect(saveChannelModelConfiguration(channelId,draft,'old')).rejects.toMatchObject({status:409});expect(fetcher).not.toHaveBeenCalled();
 fetcher.mockImplementation(async()=>{db.update(channels).set({apiKey:'changed'}).where(eq(channels.id,channelId)).run();return Response.json({data:[entry]});});
 await expect(saveChannelModelConfiguration(channelId,draft,first.version)).rejects.toMatchObject({status:409});expect(getModelSpecification(draft.modelId)).toBeUndefined();
});
it.each([{supports_frame_control:true,supports_reference_images:true,durations:[5,10],media_contract:undefined},{duration_min:5,duration_max:10,modes:['text','reference'],max_video_references:1,max_audio_references:1,media_contract:undefined}])('previews the actual flow/legacy field family',async metadata=>{
 const {channelId,draft}=setup('video',metadata);draft.limits.maxImages=1;
 const result=await previewAuthorizedChannelModelRequest(channelId,draft,{images:1});
 expect(result.body.model).toBe(draft.modelId);expect(result.path).toBe('/v1/videos');
 if('supports_frame_control' in metadata){expect(result.body.reference_images).toHaveLength(1);expect(result.body.images).toBeUndefined();expect(result.body.aspect_ratio).toBe('16:9');}
 else {expect(result.body.images).toHaveLength(1);expect(result.body.mode).toBe('reference');}
});

it('manually added text reaches Chat Completions with its public model ID and settles once',async()=>{
 const {channelId,draft,model,fetcher}=setup('text');
 await saveChannelModelConfiguration(channelId,draft,listChannelModelConfigurations(channelId).version);
 db.update(models).set({isActive:1}).where(eq(models.modelId,model)).run();
 db.insert(modelPricing).values({modelPattern:model,billingType:'per_call',inputPrice:1}).run();
 sqlite.prepare("INSERT INTO api_tokens(name,token_key,allowed_models,balance,used_amount,status) VALUES(?,?,?,?,?,?)").run('manual-chat','manual-test-token','[]',100,0,1);
 fetcher.mockImplementation(async()=>Response.json({choices:[{message:{content:'ok'}}],usage:{prompt_tokens:10,completion_tokens:20}}));
 const layer=apiRouter.stack.find((l:any)=>l.route?.path==='/chat/completions'&&l.route.methods.post)!;
 const res:any={setHeader:vi.fn(),status(code:number){this.code=code;return this;},json(body:any){this.body=body;return this;}};
 await layer.route.stack.at(-1)!.handle({body:{model,stream:false,messages:[{role:'user',content:'hello'}]},headers:{authorization:'Bearer manual-test-token'},socket:{},protocol:'http',get:()=> 'localhost'} as any,res,()=>{});
 expect(res.body).toMatchObject({choices:[{message:{content:'ok'}}]});
 const posts=fetcher.mock.calls.filter(([,o])=>o?.method==='POST');expect(posts).toHaveLength(1);expect(posts[0][0]).toBe('https://api.image2pro.top/v1/chat/completions');expect(JSON.parse(String(posts[0][1]?.body)).model).toBe(model);
 expect(sqlite.prepare("SELECT state FROM billing_reservations").all()).toEqual([{state:'settled'}]);
});

it('runs a manually configured video through the website order and billing entry',async()=>{
 const {model,channelId,draft,fetcher,entry}=setup('video');
 await saveChannelModelConfiguration(channelId,draft,listChannelModelConfigurations(channelId).version);
 db.update(models).set({isActive:1}).where(eq(models.modelId,model)).run();
 db.insert(modelPricing).values({modelPattern:model,billingType:'per_call',inputPrice:2}).run();
 const userId=Number(db.insert(users).values({username:model,email:model+'@test.invalid',passwordHash:'unused',balance:10}).run().lastInsertRowid);
 fetcher.mockImplementation(async(url,options)=>String(url).endsWith('/models')?Response.json({data:[entry]}):Response.json({id:'b'.repeat(32),status:'completed',url:'https://result.test/video.mp4'}));
 const res:any={status:vi.fn(),json:vi.fn(),setHeader:vi.fn(),flushHeaders:vi.fn(),write:vi.fn(),end:vi.fn()};
 await handleSpecificationGeneration({userId,headers:{},protocol:'https',get:()=> 'site.test',body:{model,prompt:'manual order',video_length:5,aspect_ratio:'16:9',resolution:'720p'}} as any,res,'video');
 expect(db.select().from(contents).where(eq(contents.modelId,model)).get()).toMatchObject({status:'completed',cost:2});
 expect(db.select().from(users).where(eq(users.id,userId)).get()?.balance).toBe(8);
 expect(fetcher.mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(1);
});

it('serves admin catalog, async preview and save while blocking non-admin writes',async()=>{
 const {channelId,draft,model,fetcher}=setup('image');
 const user=(role:string)=>Number(db.insert(users).values({username:model+role,email:model+role+'@test.invalid',passwordHash:'unused',role}).run().lastInsertRowid);
 const admin='Bearer '+jwt.sign({userId:user('super_admin')},env.JWT_SECRET), member='Bearer '+jwt.sign({userId:user('user')},env.JWT_SECRET);
 const app=express();app.use(express.json());app.use('/channels',channelRoutes);const server=app.listen(0,'127.0.0.1');
 await new Promise<void>(resolve=>server.once('listening',resolve));
 const url='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port+'/channels/'+channelId+'/model-configurations';
 // Use a real HTTP client for the admin API; global fetch remains the upstream stub.
 const { fetch: localFetch } = await import('undici');
 try {
  expect((await localFetch(url)).status).toBe(401);
  const current=await (await localFetch(url,{headers:{Authorization:admin}})).json() as any;
  expect(current.canAdd).toBe(true);expect(JSON.stringify(current)).not.toContain('private-test-key');
  const body=JSON.stringify({draft,version:current.version});
  expect((await localFetch(url,{method:'PUT',headers:{Authorization:member,'Content-Type':'application/json'},body})).status).toBe(403);
  expect(fetcher).not.toHaveBeenCalled();
  const preview=await localFetch(url+'/preview',{method:'POST',headers:{Authorization:admin,'Content-Type':'application/json'},body});
  expect(await preview.json()).toMatchObject({path:'/v1/images/tasks',body:{model,n:1}});
  const saved=await localFetch(url,{method:'PUT',headers:{Authorization:admin,'Content-Type':'application/json'},body});
  expect(saved.status).toBe(200);expect(await saved.json()).toMatchObject({models:[{modelId:model,editable:true,enabled:false}]});
  expect(fetcher.mock.calls.every(([,o])=>o?.method!=='POST')).toBe(true);
 } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
