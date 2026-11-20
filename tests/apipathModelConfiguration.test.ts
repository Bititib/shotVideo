import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async ()=>(await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/routes/imageGen.js',()=>({localizeGeneratedImage:vi.fn(async()=>'/uploads/new-image.png')}));
vi.mock('../server/services/videoLocalizationService.js',()=>({downloadAndLocalizeVideo:vi.fn(async()=>'/uploads/new-video.mp4')}));
import fixture from './fixtures/apipath-docs-20261120.json';
import { db,sqlite } from '../server/db/index.js';
import { channels,models,modelPricing,contents,users,apipathChannelKeys,settings } from '../server/db/schema.js';
import { eq } from 'drizzle-orm';
import { ChannelService } from '../server/services/channelService.js';
import { listAuthorizedChannelModels,listChannelModelConfigurations,saveChannelModelConfiguration,previewAuthorizedChannelModelRequest } from '../server/services/channelModelConfigurationService.js';
import { getModelSpecification, inspectModelRoutes } from '../server/services/modelRoutingService.js';
import { handleSpecificationGeneration,resumeSpecificationTasks } from '../server/services/specificationGenerationService.js';
import type { ChannelModelDraft } from '../shared/channelModelConfiguration.js';

let channelId:number;
const video='seedance-2.5-YZ',image='gpt-image-2-5-flare';
const createFetch=()=>vi.fn(async(url:any,init:any={})=>{
  if(String(url).endsWith('/api/api-docs')) {expect(init.headers).toBeUndefined();return Response.json(fixture);}
  if(String(url).endsWith('/v1/models'))return Response.json({data:[video,image,'Seedance-2.0-mini-480-GK','gpt-image-2-5-sunburst','undocumented','unselected'].map(id=>({id}))});
  if(init.method==='POST'&&String(url).endsWith('/v1/video/generations')){
    expect(init.headers.Authorization).toBe('Bearer video-key');
    return Response.json({task_no:'new-original',status:'completed',url:'https://cdn.example/video.mp4'});
  }
  if(init.method==='POST'&&String(url).endsWith('/v1/images/generations')){
    expect(init.headers.Authorization).toBe('Bearer image-key');return Response.json({data:[{url:'https://cdn.example/image.png'}]});
  }
  throw new Error('Unexpected request '+url);
});
beforeEach(()=>{
  for(const table of [contents,models,modelPricing,channels,apipathChannelKeys,settings,users])db.delete(table).run();
  if(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='video_submission_receipts'").get())sqlite.exec('DELETE FROM video_submission_receipts');
  db.insert(users).values({id:1,email:'test@example.invalid',username:'test',passwordHash:'test',balance:100}).run();
  channelId=ChannelService.createChannel({type:'apipath',name:'Vx-魅影',baseUrl:'https://provider.invalid',apipathImageKey:'image-key',apipathVideoKey:'video-key'});
  vi.stubGlobal('fetch',createFetch());
});
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});afterAll(()=>sqlite.close());
async function draftFor(id:string):Promise<ChannelModelDraft>{const entry=(await listAuthorizedChannelModels(channelId)).find(e=>e.id===id)!;return {modelId:id,upstreamModel:id,displayName:id,kind:entry.kind!,limits:entry.limits!};}
async function save(draft:ChannelModelDraft){return saveChannelModelConfiguration(channelId,draft,listChannelModelConfigurations(channelId).version);}
const response=()=>{const r:any={headersSent:false,writableEnded:false,destroyed:false};r.status=vi.fn(()=>r);r.json=vi.fn(body=>{r.body=body;return r;});r.setHeader=vi.fn();r.flushHeaders=vi.fn(()=>r.headersSent=true);r.write=vi.fn();r.end=vi.fn(()=>r.writableEnded=true);return r;};

it('offers documented, type-bound authorized models without importing any catalog entry',async()=>{
  const entries=await listAuthorizedChannelModels(channelId);
  expect(entries.map(e=>e.id).sort()).toEqual([video,image,'Seedance-2.0-mini-480-GK','gpt-image-2-5-sunburst'].sort());
  expect(db.select().from(models).all()).toEqual([]);
  expect(listChannelModelConfigurations(channelId)).toMatchObject({apipath:true,canAdd:true,models:[]});
  expect(vi.mocked(fetch).mock.calls.every(c=>!c[1]?.method||c[1].method==='GET')).toBe(true);
});
it.each([video,image])('adds only selected %s, retains it on sync and binds the correct Key',async id=>{
  const draft=await draftFor(id);await save(draft);
  expect(db.select().from(models).all()).toMatchObject([{modelId:id,isActive:0}]);
  expect(listChannelModelConfigurations(channelId).models[0].editable).toBe(true);
  db.insert(modelPricing).values({modelPattern:id,inputPrice:3,extraParams:'{}'}).run();
  db.update(models).set({isActive:1,description:'管理员说明'}).where(eq(models.modelId,id)).run();
  const sync=await ChannelService.syncModels(channelId);
  expect(sync.models).toContain(id);expect(sync.models).not.toContain(id===video?image:video);
  expect(db.select().from(models).where(eq(models.modelId,id)).get()).toMatchObject({isActive:1,description:'管理员说明'});
  expect(db.select().from(modelPricing).all()[0].inputPrice).toBe(3);
  const executions=ChannelService.getActiveChannels().filter(c=>c.id===channelId&&c.supportedModels.includes(id));
  expect(executions).toHaveLength(1);expect(executions[0].apiKey).toBe(id===video?'video-key':'image-key');
  expect(inspectModelRoutes(getModelSpecification(id)!)[0].reasons).toEqual([]);
  expect(vi.mocked(fetch).mock.calls.every(c=>!c[1]?.method||c[1].method==='GET')).toBe(true);
});
it('previews and executes a dynamically added video with current standard fields and a single charge',async()=>{
  const draft=await draftFor(video);await save(draft);
  const preview=await previewAuthorizedChannelModelRequest(channelId,draft,{seconds:4,ratio:'1:1',resolution:'480p'});
  expect(preview).toMatchObject({path:'/v1/video/generations',body:{model:video,ratio:'1:1',duration:4,resolution:'480p',generation_mode:'multimodal'}});
  expect(preview.body).not.toHaveProperty('aspect_ratio');
  db.update(models).set({isActive:1}).where(eq(models.modelId,video)).run();
  db.insert(modelPricing).values({modelPattern:video,billingType:'per_second',inputPrice:.2}).run();
  vi.mocked(fetch).mockClear();
  await handleSpecificationGeneration({userId:1,headers:{},protocol:'https',get:()=> 'app.example',body:{model:video,prompt:'海浪',seconds:4,resolution:'480p',aspect_ratio:'1:1'}} as any,response(),'video');
  expect(db.select().from(contents).all()[0]).toMatchObject({status:'completed',cost:.8});
  expect(db.select().from(users).all()[0].balance).toBe(99.2);
  const post=vi.mocked(fetch).mock.calls.filter(c=>c[1]?.method==='POST');expect(post).toHaveLength(1);
  expect(JSON.parse(post[0][1]!.body as string)).toEqual({...preview.body,prompt:'海浪'});
  resumeSpecificationTasks();expect(db.select().from(users).all()[0].balance).toBe(99.2);
});
it('executes a selected image through the image Key without exposing video authorization',async()=>{
  await save(await draftFor(image));db.update(models).set({isActive:1}).where(eq(models.modelId,image)).run();
  db.insert(modelPricing).values({modelPattern:image,inputPrice:.1,billingType:'per_call'}).run();vi.mocked(fetch).mockClear();
  await handleSpecificationGeneration({userId:1,headers:{},protocol:'https',get:()=> 'app.example',body:{model:image,prompt:'海浪',aspect_ratio:'1:1'}} as any,response(),'image');
  expect(db.select().from(contents).all()[0]).toMatchObject({status:'completed',cost:.1});
  expect(fetch).toHaveBeenCalledOnce();
});
it('previews the selected model’s documented first-frame combination without a paid request',async()=>{
  const draft=await draftFor('Seedance-2.0-mini-480-GK');
  const preview=await previewAuthorizedChannelModelRequest(channelId,draft,{images:1,firstFrame:true,seconds:4});
  expect(preview.body).toMatchObject({generation_mode:'first_frame_reference',first_frame:'https://example.invalid/first.jpg',reference_images:['https://example.invalid/ref-1.jpg']});
  expect(vi.mocked(fetch).mock.calls.every(c=>!c[1]?.method||c[1].method==='GET')).toBe(true);
});
it.each(['resolution','duration','key-race','wrong-kind','undocumented'])('rejects %s without modifying bindings or charging',async mode=>{
  const draft=await draftFor(video);const version=listChannelModelConfigurations(channelId).version;
  if(mode==='resolution')draft.limits.resolutions=['8K'];
  if(mode==='duration')draft.limits.duration.max=200;
  if(mode==='wrong-kind')draft.kind='image';
  if(mode==='undocumented')draft.modelId=draft.upstreamModel='undocumented';
  if(mode==='key-race'){
    const prior=createFetch();vi.stubGlobal('fetch',vi.fn(async(url:any,init:any)=>{const r=await prior(url,init);if(String(url).endsWith('/v1/models'))ChannelService.updateChannel(channelId,{apipathVideoKey:'replacement'});return r;}));
  }
  await expect(saveChannelModelConfiguration(channelId,draft,version)).rejects.toThrow();
  expect(db.select().from(models).all()).toEqual([]);expect(db.select().from(contents).all()).toEqual([]);
  expect(db.select().from(users).all()[0].balance).toBe(100);
  expect(vi.mocked(fetch).mock.calls.every(c=>!c[1]?.method||c[1].method==='GET')).toBe(true);
});
it('does not offer videos through an image-only Key even if its raw catalog contains video IDs',async()=>{
  const row=db.select().from(apipathChannelKeys).all().find(k=>k.kind==='video')!;
  db.delete(apipathChannelKeys).where(eq(apipathChannelKeys.id,row.id)).run();
  expect((await listAuthorizedChannelModels(channelId)).every(e=>e.kind==='image')).toBe(true);
});
