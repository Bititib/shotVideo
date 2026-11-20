import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async ()=>(await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/routes/imageGen.js',()=>({localizeGeneratedImage:vi.fn(async()=>'/uploads/new-image.png')}));
vi.mock('../server/services/videoLocalizationService.js',()=>({downloadAndLocalizeVideo:vi.fn(async()=>'/uploads/new-video.mp4')}));
import fixture from './fixtures/apipath-docs-20261120.json';
import runtimeFixture from './fixtures/apipath-transformers-20261120.json';
import * as imageValidation from '../server/services/imageReferenceValidationService.js';
import { db,sqlite } from '../server/db/index.js';
import { channels,models,modelPricing,contents,users,apipathChannelKeys,settings } from '../server/db/schema.js';
import { eq } from 'drizzle-orm';
import { ChannelService } from '../server/services/channelService.js';
import { listAuthorizedChannelModels,listChannelModelConfigurations,saveChannelModelConfiguration,previewAuthorizedChannelModelRequest } from '../server/services/channelModelConfigurationService.js';
import { getModelSpecification, inspectModelRoutes } from '../server/services/modelRoutingService.js';
import { handleSpecificationGeneration,resumeSpecificationTasks } from '../server/services/specificationGenerationService.js';
import type { ChannelModelDraft } from '../shared/channelModelConfiguration.js';

let channelId:number;
const video='seedance-2.5-YZ',image='gpt-image-2-5-flare',transformer=runtimeFixture.model.code;
const createFetch=()=>vi.fn(async(url:any,init:any={})=>{
  if(String(url).endsWith('/api/api-docs')) {expect(init.headers).toBeUndefined();return Response.json(fixture);}
  if(String(url).endsWith('/api/models')) {expect(init.headers).toBeUndefined();return Response.json({code:0,data:[runtimeFixture.model]});}
  if(String(url).endsWith('/v1/models'))return Response.json({data:[video,image,transformer,'Seedance-2.0-mini-480-GK','gpt-image-2-5-sunburst','undocumented','unselected'].map(id=>({id}))});
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

it.each(['image','video'] as const)('saves and previews a manually entered %s offline and retains its typed binding on sync', async kind => {
  const id = '手填-' + kind;
  const { defaultRoutingLimits } = await import('../shared/modelRouting.js');
  const limits = defaultRoutingLimits();
  if (kind === 'image') limits.resolutions = ['default'];
  const draft = { modelId: id, upstreamModel: id, displayName: id, kind, limits, apipathManual: true };
  const preview = await previewAuthorizedChannelModelRequest(channelId, draft);
  expect(preview.body.model).toBe(id);
  const saved = await save(draft);
  expect(saved.models).toMatchObject([{ modelId: id, apipathManual: true, editable: true, enabled: false }]);
  await save({ ...draft, displayName: '修改名称' });
  expect(fetch).not.toHaveBeenCalled();
  await ChannelService.syncModels(channelId);
  const bound = ChannelService.getActiveChannels().filter(key => key.id === channelId && key.supportedModels.includes(id));
  expect(bound.map(key => key.apiKey)).toEqual([kind + '-key']);
  expect(getModelSpecification(id)?.limits).toEqual(limits);
  db.update(models).set({isActive:1}).where(eq(models.modelId,id)).run();
  db.insert(modelPricing).values({modelPattern:id,inputPrice:.1,billingType:'per_call'}).run();
  vi.mocked(fetch).mockClear();
  const body = {model:id,prompt:'海浪',aspect_ratio:'1:1', ...(kind === 'video' ? {seconds:4,resolution:'720p'} : {})};
  await handleSpecificationGeneration({userId:1,headers:{},protocol:'https',get:()=> 'app.example',body} as any,response(),kind);
  expect(db.select().from(contents).all()[0]).toMatchObject({status:'completed',cost:.1});
  expect(fetch).toHaveBeenCalledOnce();
});

it('offers documented, type-bound authorized models without importing any catalog entry',async()=>{
  const entries=await listAuthorizedChannelModels(channelId);
  expect(entries.map(e=>e.id).sort()).toEqual([video,image,transformer,'Seedance-2.0-mini-480-GK','gpt-image-2-5-sunburst'].sort());
  expect(db.select().from(models).all()).toEqual([]);
  expect(listChannelModelConfigurations(channelId)).toMatchObject({apipath:true,canAdd:true,models:[]});
  expect(vi.mocked(fetch).mock.calls.every(c=>!c[1]?.method||c[1].method==='GET')).toBe(true);
});
it.each([video,image,transformer])('adds only selected %s, retains it on sync and binds the correct Key',async id=>{
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
  expect(executions).toHaveLength(1);expect(executions[0].apiKey).toBe(id===image?'image-key':'video-key');
  expect(inspectModelRoutes(getModelSpecification(id)!)[0].reasons).toEqual([]);
  expect(sync.warnings?.some(w=>w.includes('未自动导入')&&w.includes(id))).toBe(false);
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

it('offers Transformers with its own four resolutions and limits when it has no document-list entry',async()=>{
  expect(fixture.data.items.some(d=>d.model_code===transformer)).toBe(false);
  const draft=await draftFor(transformer);
  expect(draft.limits).toMatchObject({resolutions:['480p','720p','1080p','4k'],ratios:['16:9','9:16','1:1','3:4','4:3','21:9'],maxImages:30,maxVideos:10,maxAudios:10,
    firstFrame:false,lastFrame:false,defaultSeconds:5,duration:{mode:'range',min:4,max:30,step:1}});
  await save(draft);
  const model=db.select().from(models).where(eq(models.modelId,transformer)).get()!;
  expect(model.isActive).toBe(0);expect(db.select().from(modelPricing).all()).toEqual([]);
  expect(model.description).toContain('15000');expect(model.description).toContain('4k');
  expect(getModelSpecification(transformer)!.routes[0].apipath).toMatchObject({modes:[],modeOptional:true,maxPromptChars:15000});
  const preview=await previewAuthorizedChannelModelRequest(channelId,draft,{seconds:30,resolution:'4k',images:30,videos:10,audios:10});
  expect(preview.body).toMatchObject({model:transformer,duration:30,resolution:'4k',ratio:'16:9',count:1});
  expect(preview.body).not.toHaveProperty('generation_mode');expect((preview.body.reference_images as string[])).toHaveLength(30);
  expect((preview.body.reference_videos as string[])).toHaveLength(10);expect((preview.body.reference_audios as string[])).toHaveLength(10);
});

it.each(['480p','720p','1080p','4k'])('executes Transformers %s with the video Key and selected per-call sale price, once',async resolution=>{
  await save(await draftFor(transformer));
  db.update(models).set({isActive:1}).where(eq(models.modelId,transformer)).run();
  const prices={'480p':1,'720p':2,'1080p':3,'4k':4};
  db.insert(modelPricing).values({modelPattern:transformer,billingType:'per_call',inputPrice:1,extraParams:JSON.stringify(prices)}).run();
  const images=['https://app.example/a.jpg','https://app.example/b.jpg'];
  const validation=vi.spyOn(imageValidation,'validateAndNormalizeImageReferences').mockResolvedValue(images);
  vi.mocked(fetch).mockClear();
  try{
    await handleSpecificationGeneration({userId:1,headers:{},protocol:'https',get:()=> 'app.example',body:{model:transformer,prompt:'海浪',seconds:30,resolution,aspect_ratio:'21:9',
      reference_images:images,reference_videos:['https://cdn.example/one.mp4'],reference_audios:['https://cdn.example/one.mp3']}} as any,response(),'video');
    expect(db.select().from(contents).all()[0]).toMatchObject({status:'completed',cost:prices[resolution as keyof typeof prices]});
    expect(fetch).toHaveBeenCalledOnce();
    const [url,init]=vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://provider.invalid/v1/video/generations');expect((init?.headers as any).Authorization).toBe('Bearer video-key');
    const body=JSON.parse(init!.body as string);
    expect(body).toMatchObject({model:transformer,ratio:'21:9',duration:30,resolution,count:1,reference_images:images,
      reference_videos:['https://cdn.example/one.mp4'],reference_audios:['https://cdn.example/one.mp3']});
    expect(body).not.toHaveProperty('generation_mode');resumeSpecificationTasks();
    expect(fetch).toHaveBeenCalledOnce();expect(db.select().from(users).all()[0].balance).toBe(100-prices[resolution as keyof typeof prices]);
  }finally{validation.mockRestore();}
});

it.each(['missing-limits','conflicting-size','wrong-media-field','unknown-frame-shape','not-enabled','no-api-authorization','unknown-mode'])('does not offer incomplete or unauthorized runtime model: %s',async scenario=>{
  const model=structuredClone(runtimeFixture.model) as any;
  if(scenario==='missing-limits')delete model.runtime_rule.video.duration_min;
  if(scenario==='conflicting-size')model.input_schema.properties.resolution.enum=['8k'];
  if(scenario==='wrong-media-field')model.runtime_rule.video.reference_videos.key='videos';
  if(scenario==='unknown-frame-shape')model.runtime_rule.video.frames={first_frame:true};
  if(scenario==='not-enabled')model.is_enabled=false;
  if(scenario==='unknown-mode')model.runtime_rule.video.supported_generation_modes=['provider-private-mode'];
  const prior=createFetch();
  vi.stubGlobal('fetch',vi.fn(async(url:any,init:any)=>{
    if(String(url).endsWith('/api/models'))return Response.json({code:0,data:[model]});
    if(String(url).endsWith('/v1/models')&&scenario==='no-api-authorization')return Response.json({data:[{id:video}]});
    return prior(url,init);
  }));
  expect((await listAuthorizedChannelModels(channelId)).some(e=>e.id===transformer)).toBe(false);
  expect(db.select().from(models).all()).toEqual([]);expect(db.select().from(users).all()[0].balance).toBe(100);
});

it('does not use runtime fallback to bypass an incompatible model-specific document',async()=>{
  const prior=createFetch();vi.stubGlobal('fetch',vi.fn(async(url:any,init:any)=>String(url).endsWith('/api/api-docs')
    ?Response.json({...fixture,data:{items:[...fixture.data.items,{model_code:transformer,category:'video',is_published:true,endpoint:'/private/new-protocol',content:{}}]}}):prior(url,init)));
  expect((await listAuthorizedChannelModels(channelId)).some(e=>e.id===transformer)).toBe(false);
});

it('preserves existing bindings when official runtime catalog lookup fails',async()=>{
  await save(await draftFor(transformer));const original=db.select().from(apipathChannelKeys).all();
  const prior=createFetch();vi.stubGlobal('fetch',vi.fn(async(url:any,init:any)=>String(url).endsWith('/api/models')?new Response('temporary',{status:503}):prior(url,init)));
  await expect(ChannelService.syncModels(channelId)).rejects.toThrow('HTTP 503');
  expect(db.select().from(apipathChannelKeys).all()).toEqual(original);
});

it.each(['long-prompt','unpublished-mode','invalid-duration','too-many-images'])('rejects unsupported Transformers request %s without a paid submission',async scenario=>{
  await save(await draftFor(transformer));db.update(models).set({isActive:1}).where(eq(models.modelId,transformer)).run();
  db.insert(modelPricing).values({modelPattern:transformer,billingType:'per_call',inputPrice:4}).run();
  const body:any={model:transformer,prompt:'海浪',seconds:4,resolution:'480p',ratio:'16:9'};
  if(scenario==='long-prompt')body.prompt='海'.repeat(15001);
  if(scenario==='unpublished-mode')body.generation_mode='multimodal';
  if(scenario==='invalid-duration')body.seconds=31;
  if(scenario==='too-many-images')body.reference_images=Array(31).fill('https://app.example/a.jpg');
  vi.mocked(fetch).mockClear();await handleSpecificationGeneration({userId:1,headers:{},protocol:'https',get:()=> 'app.example',body} as any,response(),'video');
  expect(fetch).not.toHaveBeenCalled();expect(db.select().from(users).all()[0].balance).toBe(100);
  resumeSpecificationTasks();expect(fetch).not.toHaveBeenCalled();expect(db.select().from(users).all()[0].balance).toBe(100);
});

it.each(['rejected','unknown'])('keeps original billing evidence for a runtime model %s response',async outcome=>{
  await save(await draftFor(transformer));db.update(models).set({isActive:1}).where(eq(models.modelId,transformer)).run();
  db.insert(modelPricing).values({modelPattern:transformer,billingType:'per_call',inputPrice:4}).run();
  vi.stubGlobal('fetch',vi.fn(async()=>{if(outcome==='unknown')throw new Error('socket closed');return Response.json({error:'provider_error'},{status:502});}));
  await handleSpecificationGeneration({userId:1,headers:{},protocol:'https',get:()=> 'app.example',body:{model:transformer,prompt:'海浪',seconds:4,resolution:'480p',ratio:'16:9'}} as any,response(),'video');
  const row=db.select().from(contents).all()[0];
  if(outcome==='rejected')expect(row.status).toBe('failed');else expect(JSON.parse(row.metadata).requiresReview).toBe(true);
  resumeSpecificationTasks();resumeSpecificationTasks();expect(fetch).toHaveBeenCalledOnce();
  expect(db.select().from(users).all()[0].balance).toBe(outcome==='rejected'?100:96);
});
