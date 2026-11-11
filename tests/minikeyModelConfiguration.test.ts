import { afterEach,beforeEach,expect,it,vi } from 'vitest';
vi.mock('../server/db/index.js',async()=>(await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
import { sqlite } from '../server/db/index.js';
import { ChannelService } from '../server/services/channelService.js';
import { saveMinikeyModelConfiguration, listMinikeyModelConfigurations, previewMinikeyModelRequest } from '../server/services/minikeyModelConfigurationService.js';
import { getModelSpecification, selectModelRoutes } from '../server/services/modelRoutingService.js';
import { submitSpecificationVideo,generateSpecificationImage } from '../server/services/specificationAdapters.js';
import { blankMinikeyModel } from '../shared/minikeyModelConfiguration.js';
import { getEnabledPublicModels } from '../server/services/modelCatalogService.js';

const catalog={models:[{model:'upstream-new',name:'视频',category:'video',maxImages:9,durations:[5,10],channels:[{id:238,name:'线路 A',prices:{5:3,10:3}}]},
  {model:'banana-new',name:'图片',category:'image',maxImages:14,prices:{'1K':0.2,'2K':0.3}},
  {model:'suno-v6',category:'audio',channels:[{id:22,name:'音乐',prices:{per:1}}]}]};
let channelId:number;
const draft=()=>({...blankMinikeyModel(),modelId:'custom-video',upstreamModel:'upstream-new',upstreamChannel:238,limits:{...blankMinikeyModel().limits,maxImages:3,resolutions:['720p']}});
beforeEach(()=>{sqlite.exec('SAVEPOINT minikey_config');channelId=ChannelService.createChannel({name:'mini',type:'minikey',baseUrl:'https://minikey.work',apiKey:'private-key'});vi.stubGlobal('fetch',vi.fn(async()=>Response.json(catalog)));});
afterEach(()=>{vi.unstubAllGlobals();sqlite.exec('ROLLBACK TO minikey_config; RELEASE minikey_config');});
it('previews without generation, adds disabled models and preserves price/activation on edits and sync',async()=>{
  expect(await previewMinikeyModelRequest(channelId,draft())).toMatchObject({path:'/openapi/v1/videos',body:{model:'upstream-new',channel:238,duration:5}});
  const saved=await saveMinikeyModelConfiguration(channelId,draft(),null);
  expect(sqlite.prepare('SELECT is_active FROM models WHERE model_id=?').get(saved.modelId)).toEqual({is_active:0});
  expect(getEnabledPublicModels('video')).toEqual([]);
  sqlite.prepare('UPDATE models SET is_active=1 WHERE model_id=?').run(saved.modelId);
  sqlite.prepare("INSERT INTO model_pricing(model_pattern,billing_type,input_price) VALUES(?,'per_call',2)").run(saved.modelId);
  const live=listMinikeyModelConfigurations(channelId)[0];
  await saveMinikeyModelConfiguration(channelId,{...live,limits:{...live.limits,maxImages:2}},live.version);
  await ChannelService.syncModels(channelId);
  expect(getModelSpecification(saved.modelId)?.limits.maxImages).toBe(2);
  expect(getEnabledPublicModels('video')[0]?.modelId).toBe(saved.modelId);
  expect(sqlite.prepare('SELECT input_price FROM model_pricing WHERE model_pattern=?').get(saved.modelId)).toEqual({input_price:2});
  for(const [,init] of vi.mocked(fetch).mock.calls)expect(init?.method || 'GET').toBe('GET');
});
it('rejects stale editors, occupied IDs and changes during catalog lookup',async()=>{
  const saved=await saveMinikeyModelConfiguration(channelId,draft(),null);
  await saveMinikeyModelConfiguration(channelId,{...saved,routeEnabled:false},saved.version);
  await expect(saveMinikeyModelConfiguration(channelId,saved,saved.version)).rejects.toThrow('变化');
  sqlite.prepare("INSERT INTO models(model_id,display_name,provider,capabilities) VALUES('taken','taken','other','[\"video\"]')").run();
  await expect(saveMinikeyModelConfiguration(channelId,{...draft(),modelId:'taken'},null)).rejects.toThrow('覆盖');
  vi.mocked(fetch).mockImplementationOnce(async()=>{sqlite.prepare('UPDATE channels SET api_key=? WHERE id=?').run('changed',channelId);return Response.json(catalog);});
  await expect(saveMinikeyModelConfiguration(channelId,{...draft(),modelId:'race'},null)).rejects.toThrow('变化');
  expect(getModelSpecification('race')).toBeUndefined();
});
it('rejects unsupported durations and registers music without activating or pricing it',async()=>{
  await expect(saveMinikeyModelConfiguration(channelId,{...draft(),upstreamChannel:999},null)).rejects.toThrow('线路');
  const d=draft();d.limits.duration.values=[6];d.limits.defaultSeconds=6;
  await expect(saveMinikeyModelConfiguration(channelId,d,null)).rejects.toThrow('秒数');
  const music=await saveMinikeyModelConfiguration(channelId,{...draft(),modelId:'music-new',kind:'music',upstreamModel:'suno-v6',upstreamChannel:22},null);
  expect(music).toMatchObject({enabled:true,routeEnabled:true});
  expect(sqlite.prepare('SELECT is_active FROM models WHERE model_id=?').get('music-new')).toEqual({is_active:0});
  expect(JSON.parse(ChannelService.getChannelRaw(channelId)!.supportedModels)).toContain('music-new');
});
it('uses the configured upstream model and line in the actual video submission entry',async()=>{
  await saveMinikeyModelConfiguration(channelId,draft(),null);
  sqlite.prepare("UPDATE models SET is_active=1 WHERE model_id='custom-video'").run();
  const spec=getModelSpecification('custom-video')!;
  const input={images:1,videos:0,audios:0,outputs:1,seconds:5,resolution:'720p',ratio:'16:9',firstFrame:false,lastFrame:false};
  const target=selectModelRoutes(spec,input)[0];expect(target).toBeTruthy();
  const id='a'.repeat(32), persist=vi.fn();
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({id,status:'queued'}));
  await submitSpecificationVideo(target,{input,body:{},prompt:'海浪',images:['data:image/png;base64,AA=='],videos:[],audios:[],firstFrame:'',lastFrame:'',publicBaseUrl:'https://app.example'},persist);
  const form=vi.mocked(fetch).mock.calls.at(-1)![1]!.body as FormData;
  expect(form.get('model')).toBe('upstream-new');expect(form.get('channel')).toBe('238');
  expect(persist.mock.calls[0][0].minikeyRequestId).toBe(form.get('client_request_id'));
  expect(persist).toHaveBeenLastCalledWith({videoId:id,upstreamTaskId:id});
});
it('uses the selected image parameter format for newly configured model names',async()=>{
  const d={...draft(),modelId:'art-new',kind:'image' as const,upstreamModel:'banana-new',upstreamChannel:null,
    limits:{...draft().limits,minImages:0,maxImages:14,maxOutputs:4,resolutions:['2K'],ratios:['1:1']}};
  await saveMinikeyModelConfiguration(channelId,d,null);sqlite.prepare("UPDATE models SET is_active=1 WHERE model_id='art-new'").run();
  const input={images:0,videos:0,audios:0,outputs:1,seconds:5,resolution:'2K',ratio:'1:1',firstFrame:false,lastFrame:false};
  const target=selectModelRoutes(getModelSpecification('art-new')!,input)[0],id='b'.repeat(32),persist=vi.fn();
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({task_id:id,status:'queued'})).mockResolvedValueOnce(Response.json({task_id:id,state:'success',is_final:true,result_url:'https://cdn.example/result.png'}));
  const result=await generateSpecificationImage(target,{input,body:{},prompt:'海浪',images:[],videos:[],audios:[],firstFrame:'',lastFrame:'',publicBaseUrl:'https://app.example'},vi.fn(),persist);
  expect(result.imageUrl).toBe('https://cdn.example/result.png');expect(persist).toHaveBeenCalledWith(id);
  const post=vi.mocked(fetch).mock.calls.find(([,i])=>i?.method==='POST')!;
  expect(JSON.parse(post[1]!.body as string)).toMatchObject({model:'banana-new',params:{aspectRatio:'1:1',imageSize:'2K',n:1}});
});
