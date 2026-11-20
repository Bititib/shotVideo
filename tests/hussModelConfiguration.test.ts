import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
vi.mock('../server/db/index.js',async()=> (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/services/videoLocalizationService.js',()=>({downloadAndLocalizeVideo:vi.fn(async()=>'/uploads/huss-config.mp4')}));
import {db,sqlite} from '../server/db/index.js';
import {channels,models,settings,modelPricing,users,contents} from '../server/db/schema.js';
import '../server/routes/channels.js';
import {listChannelModelConfigurations,listAuthorizedChannelModels,saveChannelModelConfiguration,previewAuthorizedChannelModelRequest} from '../server/services/channelModelConfigurationService.js';
import {ChannelService} from '../server/services/channelService.js';
import {pruneChannelCatalogBindings} from '../server/services/channelCatalogBindings.js';
import {getModelSpecification} from '../server/services/modelRoutingService.js';
import {handleSpecificationGeneration,resumeSpecificationTasks} from '../server/services/specificationGenerationService.js';
import {downloadAndLocalizeVideo} from '../server/services/videoLocalizationService.js';
import {hussConfigurationCatalog} from '../shared/hussConfiguration.js';
import {hussUnifiedModels} from '../shared/hussUnifiedModels.js';
import {submitHussVideo,recoverHussSubmission} from '../server/services/hussVideoAdapter.js';
import type {ChannelModelDraft} from '../shared/channelModelConfiguration.js';
const A='bb-2.5-301010-渠道A',B='hss-2.5-301010-渠道B',MJ='Midjourney V8.2';
let channelId:number;
const draft=(upstream=A,id='custom-video'):ChannelModelDraft=>{
 const e=hussConfigurationCatalog().find(e=>e.id===upstream)!;
 return {modelId:id,displayName:id,upstreamModel:upstream,kind:e.kind!,limits:e.limits!};
};
const version=()=>listChannelModelConfigurations(channelId).version;
const catalog=()=>Response.json({data:[{id:A},{id:B},{id:MJ},{id:'unknown-video'}]});
const capabilityRows=()=>{
 const known=hussUnifiedModels.map(m=>({model:String(m.id),duration:m.duration,resolutions:m.resolutions,ratios:m.ratios,reference_limits:m.references,reference_transport:'public_https_url',requirements:{}}));
 const sample=known.find(m=>m.model==='GP-2.5-301010渠道A')!;
 return [...known,...Array.from({length:12},(_,i)=>({...sample,model:'account-video-'+i}))];
};
const capabilities=()=>Response.json({contract:'unified-v1',models:capabilityRows()});
const authorize=(ids:string[])=>vi.stubGlobal('fetch',vi.fn(async(url:any)=>String(url).endsWith('/videos/models')?capabilities():Response.json({data:ids.map(id=>({id}))})));
beforeEach(()=>{
 for(const table of ['settings','contents','models','channels','users','model_pricing','billing_reservations','fund_ledger','video_submission_receipts']) {
  if(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))sqlite.exec('DELETE FROM '+table);
 }
 channelId=Number(db.insert(channels).values({name:'HUSS',type:'huss',baseUrl:'https://huss.test',apiKey:'test-key',status:1}).run().lastInsertRowid);
 db.insert(settings).values({key:'deleted_model_ids',value:JSON.stringify(['bb-2.5-301010','hss-2.5-301010'])}).run();
 vi.stubGlobal('fetch',vi.fn(async(url:any)=>String(url).endsWith('/videos/models')?capabilities():catalog()));
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
afterAll(()=>sqlite.close());

it('lists authorized implemented models, saves disabled routes, preserves them on sync and startup pruning',async()=>{
 expect(listChannelModelConfigurations(channelId)).toMatchObject({canAdd:true,huss:true});
 expect((await listAuthorizedChannelModels(channelId)).map(e=>e.id)).toEqual([A,B,MJ,'unknown-video']);
 const d=draft();const saved=await saveChannelModelConfiguration(channelId,d,version());
 expect(saved.models[0]).toMatchObject({editable:true,enabled:false,upstreamModel:A});
 expect(getModelSpecification(d.modelId)!.routes[0].limits.maxReferences).toBe(30);
 db.insert(modelPricing).values({modelPattern:d.modelId,billingType:'per_call',inputPrice:9}).run();
 await saveChannelModelConfiguration(channelId,{...d,routeEnabled:false,limits:{...d.limits,maxImages:4}},version());
 await ChannelService.syncModels(channelId);
 const ch=ChannelService.getChannelRaw(channelId)!;
 expect(pruneChannelCatalogBindings(sqlite,ch)).toEqual([]);
 expect(getModelSpecification(d.modelId)!.routes[0]).toMatchObject({enabled:false,limits:{maxImages:4}});
 expect(JSON.parse(ch.supportedModels)).toContain(d.modelId);
 expect(db.select().from(models).where(eq(models.modelId,'bb-2.5-301010')).get()).toBeUndefined();
 expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern,d.modelId)).get()!.inputPrice).toBe(9);
 await expect(saveChannelModelConfiguration(channelId,d,saved.version)).rejects.toThrow('配置已变化');
});

it('rejects unauthorized, deleted, unknown and over-limit configurations before creation',async()=>{
 await expect(saveChannelModelConfiguration(channelId,draft(A,'bb-2.5-301010'),version())).rejects.toThrow('已删除');
 await expect(saveChannelModelConfiguration(channelId,{...draft(),upstreamModel:'unknown-video'},version())).rejects.toThrow('型号');
 await expect(saveChannelModelConfiguration(channelId,{...draft(),limits:{...draft().limits,resolutions:['4k']}},version())).rejects.toThrow('分辨率可选');
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({data:[{id:MJ}]})));
 await expect(saveChannelModelConfiguration(channelId,draft(),version())).rejects.toThrow('授权目录');
 expect(db.select().from(models).all()).toHaveLength(0);
});

it('previews exact A and B material fields and the Midjourney async contract without POST',async()=>{
 for(const [upstream,field] of [[A,'reference_images'],[B,'reference_images']]){
  const p=await previewAuthorizedChannelModelRequest(channelId,draft(upstream),{images:1,videos:1,audios:1,seconds:10});
  expect(p).toMatchObject({path:'/v1/videos',headers:{'X-Huss-Video-API':'unified-v1'},body:{model:upstream,duration:10}});
  expect(p.body[field]).toHaveLength(1);
 }
 const mj=draft(MJ,MJ);
 expect(await previewAuthorizedChannelModelRequest(channelId,mj,{images:1})).toMatchObject({path:'/v1/images/edits/async',body:{model:MJ,n:1,resolution:'1k'}});
 expect(vi.mocked(fetch).mock.calls.every(c=>!c[1]?.method||c[1].method==='GET')).toBe(true);
 await saveChannelModelConfiguration(channelId,mj,version());
 expect(listChannelModelConfigurations(channelId).models[0]).toMatchObject({editable:true,capabilities:['image']});
});

it.each(['success','rejection','save-retry','query-retry'])('configured video reaches real generation and billing path: %s',async scenario=>{
 vi.useFakeTimers();const upstream='account-video-0';
 authorize([upstream]);
 const d={...draft('GP-2.5-301010渠道A'),upstreamModel:upstream};await saveChannelModelConfiguration(channelId,d,version());
 db.update(models).set({isActive:1}).where(eq(models.modelId,d.modelId)).run();
 db.insert(modelPricing).values({modelPattern:d.modelId,billingType:'per_call',inputPrice:2}).run();
 const userId=Number(db.insert(users).values({username:'test',email:'config@test',passwordHash:'unused',balance:10}).run().lastInsertRowid);
 let failSave=scenario==='save-retry';
 vi.mocked(downloadAndLocalizeVideo).mockImplementation(async()=>{if(failSave)throw new Error('socket closed');return '/uploads/huss-config.mp4';});
 let queryCount=0;
 const f=vi.fn(async(_:any,opts:any)=> scenario==='query-retry' && opts?.method!=='POST' && queryCount++===0
  ? Response.json({error:{code:'auth_unavailable',message:'query unavailable'}},{status:503}) : scenario==='rejection'
  ? Response.json({error:{code:'invalid_prompt',message:'rejected prompt'}},{status:400})
  : Response.json(opts?.method==='POST'?{id:'original-task',status:'queued'}:{id:'original-task',status:'completed',url:'https://cdn.test/result.mp4'}));
 vi.stubGlobal('fetch',f);
 const res:any={status:vi.fn(),json:vi.fn(),setHeader:vi.fn(),flushHeaders:vi.fn(),write:vi.fn(),end:vi.fn()};res.status.mockReturnValue(res);
 const pending=handleSpecificationGeneration({userId,headers:{},protocol:'https',get:()=> 'local.test',body:{model:d.modelId,prompt:'test',video_length:10,resolution:'720p',aspect_ratio:'16:9'}} as any,res,'video');
 const row=()=>db.select().from(contents).where(eq(contents.modelId,d.modelId)).get()!;
 if(scenario==='query-retry'){
  await vi.waitFor(()=>expect(row() && JSON.parse(row().metadata).queryFailures).toBe(1));
  expect(row().status).toBe('processing');
  expect(db.select().from(users).where(eq(users.id,userId)).get()!.balance).toBe(8);
  await vi.advanceTimersByTimeAsync(61000);
 }
 if(scenario==='save-retry'){
  await vi.waitFor(()=>expect(row() && JSON.parse(row().metadata).resultSaveError).toContain('socket closed'));
  expect(row().status).toBe('processing');expect(JSON.parse(row().metadata).upstreamStatus).toBe('completed');
  expect(db.select().from(users).where(eq(users.id,userId)).get()!.balance).toBe(8);
  failSave=false;await vi.advanceTimersByTimeAsync(61000);
 }
 await pending;
 await vi.waitFor(()=>expect(row().status).toBe(scenario==='rejection'?'failed':'completed'));
 expect(db.select().from(users).where(eq(users.id,userId)).get()!.balance).toBe(scenario==='rejection'?10:8);
 expect(f.mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(1);
 expect(JSON.parse(f.mock.calls.find(c=>c[1]?.method==='POST')![1].body).model).toBe(upstream);
 resumeSpecificationTasks();await vi.advanceTimersByTimeAsync(100);
 expect(db.select().from(users).where(eq(users.id,userId)).get()!.balance).toBe(scenario==='rejection'?10:8);
});

it.each(['db-seedance2.0-900','GP-2.5-301010渠道A','account-video-0'])('new unified model %s keeps exact request and key for receipt recovery',async model=>{
 const d=draft(model==='account-video-0'?'GP-2.5-301010渠道A':model);const ch={type:'huss',baseUrl:'https://huss.test',apiKey:'test-key'};
 let snapshot:any;
 const f=vi.fn().mockRejectedValueOnce(new TypeError('network interrupted')).mockResolvedValueOnce(Response.json({id:'same-original-task',status:'queued'}));
 vi.stubGlobal('fetch',f);
 await expect(submitHussVideo(ch,{unifiedLimits:d.limits,model,prompt:'test',seconds:10,resolution:d.limits.resolutions[0],ratio:d.limits.ratios[0],images:['https://example.invalid/image.jpg'],videos:[],audios:[],publicBaseUrl:'',idempotencyKey:'original-key'},p=>{snapshot=p;})).rejects.toMatchObject({uncertain:true});
 expect(f).toHaveBeenCalledTimes(1);
 expect(snapshot.huss_api_mode).toBe('unified-v1');expect(snapshot.reference_images).toHaveLength(1);
 expect(await recoverHussSubmission(ch,'original-key',snapshot)).toMatchObject({state:'accepted',taskId:'same-original-task'});
 expect(f.mock.calls[0][1].body).toBe(f.mock.calls[1][1].body);
 expect(JSON.parse(f.mock.calls[1][1].body)).not.toHaveProperty('huss_configured_limits');
 expect(f.mock.calls[1][1].headers['Idempotency-Key']).toBe('original-key');
});

it('lists all account IDs beyond the seven public models and retains unknown protocols with reasons',async()=>{
 const ids=[...Array.from({length:12},(_,i)=>'account-video-'+i),'unknown-image',MJ];authorize(ids);
 const entries=await listAuthorizedChannelModels(channelId);
 expect(entries.map(e=>e.id)).toEqual(ids);
 expect(entries.filter(e=>e.kind==='video'&&e.limits)).toHaveLength(12);
 expect(entries.find(e=>e.id==='unknown-image')!.unavailableReason).toContain('统一视频能力');
 const d={...draft('GP-2.5-301010渠道A'),upstreamModel:'account-video-11'};
 await saveChannelModelConfiguration(channelId,d,version());
 await ChannelService.syncModels(channelId);
 expect(pruneChannelCatalogBindings(sqlite,ChannelService.getChannelRaw(channelId)!)).toEqual([]);
 expect(getModelSpecification(d.modelId)!.routes[0]).toMatchObject({upstreamModel:'account-video-11',huss:{protocol:'unified-v1'}});
});

it('keeps the full model list visible when capability lookup fails, without permitting unknown video creation',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:any)=>String(url).endsWith('/videos/models')?Response.json({error:{message:'capabilities unavailable'}},{status:503}):catalog()));
 const entries=await listAuthorizedChannelModels(channelId);
 expect(entries).toHaveLength(4);
 expect(entries.find(e=>e.id===A)!.unavailableReason).toContain('能力读取失败');
 expect(entries.find(e=>e.id===MJ)!.limits).toBeDefined();
 await expect(saveChannelModelConfiguration(channelId,draft(),version())).rejects.toThrow('能力读取失败');
 expect(getModelSpecification('custom-video')).toBeUndefined();
});

it('applies per-model enumeration and media limits from the official unified capabilities',async()=>{
 authorize(['db-seedance2.0-900','GP-2.5-301010渠道A']);
 const list=await listAuthorizedChannelModels(channelId);
 expect(await ChannelService.testChannel(channelId)).toMatchObject({success:true});
 expect(list.find(e=>e.id==='db-seedance2.0-900')!.limits).toMatchObject({resolutions:['default'],duration:{mode:'options',values:[5,10,15]},maxVideos:0});
 expect(list.find(e=>e.id==='GP-2.5-301010渠道A')!.limits!.resolutions).toContain('4k');
 const d=draft('db-seedance2.0-900');
 await expect(previewAuthorizedChannelModelRequest(channelId,d,{seconds:6})).rejects.toThrow();
 await expect(previewAuthorizedChannelModelRequest(channelId,d,{videos:1})).rejects.toThrow();
 await saveChannelModelConfiguration(channelId,d,version());
 await ChannelService.syncModels(channelId);
 expect(listChannelModelConfigurations(channelId).models).toContainEqual(expect.objectContaining({modelId:d.modelId,editable:true,upstreamModel:d.upstreamModel}));
});

it('allows editing the existing synchronized Midjourney route without changing its price or enabled state',async()=>{
 await ChannelService.syncModels(channelId);
 db.update(models).set({isActive:1}).where(eq(models.modelId,MJ)).run();
 db.insert(modelPricing).values({modelPattern:MJ,billingType:'per_call',inputPrice:0.5}).run();
 expect(listChannelModelConfigurations(channelId).models.find(m=>m.modelId===MJ)).toMatchObject({editable:true,enabled:true});
 const d=draft(MJ,MJ);d.limits={...d.limits,resolutions:['2K']};
 await saveChannelModelConfiguration(channelId,d,version());
 await ChannelService.syncModels(channelId);
 expect(getModelSpecification(MJ)!.limits.resolutions).toEqual(['2K']);
 expect(db.select().from(models).where(eq(models.modelId,MJ)).get()!.isActive).toBe(1);
 expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern,MJ)).get()!.inputPrice).toBe(0.5);
});
