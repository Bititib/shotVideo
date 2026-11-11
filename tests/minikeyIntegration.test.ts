import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/services/videoLocalizationService.js',()=>({downloadAndLocalizeVideo:vi.fn(async()=>'/uploads/minikey-test.mp4')}));
vi.mock('../server/routes/imageGen.js',()=>({localizeGeneratedImage:vi.fn(async()=>'/uploads/minikey-test.png')}));
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService.js';
import { localizeGeneratedImage } from '../server/routes/imageGen.js';
import { minikeyCredential } from '../server/services/minikeyAdapter.js';
import { reserveUserCharge, linkReservationContent } from '../server/services/billingReservation.js';
import { activeSpecificationTasks } from '../server/services/videoRecoveryAction.js';
import { db, sqlite } from '../server/db/index.js';
import { channels, contents, models, modelPricing, settings, users } from '../server/db/schema.js';
import { ChannelService } from '../server/services/channelService.js';
import { saveModelSpecification } from '../server/services/modelRoutingService.js';
import { handleSpecificationGeneration, resumeSpecificationTasks } from '../server/services/specificationGenerationService.js';
import { defaultRoutingLimits } from '../shared/modelRouting.js';
beforeEach(() => {
  db.delete(contents).run(); db.delete(settings).run(); db.delete(models).run(); db.delete(channels).run(); db.delete(modelPricing).run(); db.delete(users).run();
  db.insert(users).values({ id: 1, email: 'mini@test.invalid', username: 'test', passwordHash: 'test', balance: 100 }).run();
  const channelId = ChannelService.createChannel({ name: 'miniKey', type: 'minikey', baseUrl: 'https://minikey.work', apiKey: 'mk_test', supportedModels: ['30video'], maxRetries: 3 });
  db.insert(models).values({modelId:'30video',provider:'minikey',displayName:'测试',capabilities:'["video"]',isActive:1}).run();
  db.insert(modelPricing).values({modelPattern:'30video',billingType:'per_call',inputPrice:2,outputPrice:0}).run();
  const limits = defaultRoutingLimits();
  saveModelSpecification({modelId:'30video',kind:'video',enabled:true,aliases:[],limits,routes:[{id:'mini',channelId,upstreamModel:'30video',executionModel:'30video',enabled:true,limits,cost:null,costUnit:'unknown',resolutionCosts:{},priority:0}]});
});
afterEach(() => {vi.unstubAllGlobals();vi.restoreAllMocks();});
afterAll(() => sqlite.close());
function res() { const r:any={headersSent:false};r.status=vi.fn(()=>r);r.json=vi.fn(body=>{r.body=body;return r;});r.setHeader=vi.fn();r.flushHeaders=vi.fn();r.write=vi.fn();r.end=vi.fn();return r; }
const req = () => ({userId:1,headers:{},protocol:'https',get:()=> 'app.example',body:{model:'30video',prompt:'海浪',seconds:5,aspect_ratio:'9:16'}} as any);
it('actual generation entry refunds an explicit rejection once, including recovery', async () => {
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({detail:'账户积分不足'},{status:402})));
  const response=res(); await handleSpecificationGeneration(req(),response,'video'); expect(response.body?.error).toBeUndefined();
  const record=db.select().from(contents).all().at(-1)!;
  expect(record.status).toBe('failed');
  expect(JSON.parse(record.metadata).requiresReview).not.toBe(true);
  expect(db.select().from(users).all()[0].balance).toBe(100);
  resumeSpecificationTasks();resumeSpecificationTasks();
  await new Promise(resolve=>setTimeout(resolve,20));
  expect(fetch).toHaveBeenCalledOnce();
  expect(db.select().from(users).all()[0].balance).toBe(100);
});
it('actual generation entry holds unknown acceptance without retry or refund',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('disconnect');}));
  const response=res(); await handleSpecificationGeneration(req(),response,'video'); expect(response.body?.error).toBeUndefined();
  const record=db.select().from(contents).all().at(-1)!;
  expect(record.status).toBe('processing');
  expect(JSON.parse(record.metadata).requiresReview).toBe(true);
  expect(db.select().from(users).all()[0].balance).toBe(98);
  expect(fetch).toHaveBeenCalledOnce();
});
it('video immediate completion persists evidence and finishes without a redundant status query',async()=>{
  const id='b'.repeat(32);vi.stubGlobal('fetch',vi.fn(async()=>Response.json({id,status:'success',videoUrl:'https://cdn.example/test.mp4'})));
  await handleSpecificationGeneration(req(),res(),'video');
  const record=db.select().from(contents).all().at(-1)!;
  expect(record.status).toBe('completed');expect(JSON.parse(record.metadata).minikeyCompletedReceipt.taskId).toBe(id);
  expect(downloadAndLocalizeVideo).toHaveBeenCalled();expect(fetch).toHaveBeenCalledOnce();expect(db.select().from(users).get()?.balance).toBe(98);
});
it('resumes a completed video download from its receipt, but stops on a changed credential',async()=>{
  const channel=db.select().from(channels).get()!,upstream='c'.repeat(32),reservation=reserveUserCharge(1,2,'generate_video');
  const meta={managedSpecification:true,reservedCost:2,count:1,requestedModel:'30video',actualModel:'30video',channelId:channel.id,videoId:upstream,
    minikeyCredential:minikeyCredential(channel),minikeyCompletedReceipt:{taskId:upstream,resultUrl:'https://cdn.example/test.mp4'},billingReservationId:reservation.id};
  const record=db.insert(contents).values({userId:1,type:'video',modelId:'30video',status:'processing',cost:2,metadata:JSON.stringify(meta)}).returning().get();linkReservationContent(reservation.id,record.id);
  sqlite.prepare('UPDATE channels SET api_key=? WHERE id=?').run('changed',channel.id);
  vi.stubGlobal('fetch',vi.fn());resumeSpecificationTasks();await vi.waitFor(()=>expect(db.select().from(contents).get()?.status).toBe('review'));
  expect(fetch).not.toHaveBeenCalled();sqlite.prepare('UPDATE channels SET api_key=? WHERE id=?').run(channel.apiKey,channel.id);
  await vi.waitFor(()=>expect(activeSpecificationTasks.has(record.id)).toBe(false));
  resumeSpecificationTasks();await vi.waitFor(()=>expect(db.select().from(contents).get()?.status).toBe('completed'));
  expect(fetch).not.toHaveBeenCalled();expect(db.select().from(users).get()?.balance).toBe(98);
});
function enableImage(){
  const channel=db.select().from(channels).get()!;
  db.insert(models).values({modelId:'banana-2',provider:'minikey',displayName:'图片',capabilities:'["image"]',isActive:1}).run();
  db.insert(modelPricing).values({modelPattern:'banana-2',billingType:'per_call',inputPrice:2,outputPrice:0}).run();
  sqlite.prepare('UPDATE channels SET supported_models=?').run('["30video","banana-2"]');
  const limits={...defaultRoutingLimits(),resolutions:['2K'],ratios:['1:1']};
  saveModelSpecification({modelId:'banana-2',kind:'image',enabled:true,aliases:[],limits,routes:[{id:'image',channelId:channel.id,upstreamModel:'banana-2',executionModel:'banana-2',enabled:true,limits,cost:null,costUnit:'unknown',resolutionCosts:{},priority:0}]});
  return {...req(),body:{model:'banana-2',prompt:'海边',resolution:'2K',aspect_ratio:'1:1'}};
}
it('accepted image explicit failure refunds once rather than becoming uncertain',async()=>{
  const request=enableImage(),id='d'.repeat(32);
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(Response.json({task_id:id,status:'pending'})).mockResolvedValueOnce(Response.json({task_id:id,state:'failed',is_final:true,error:'图片审核拒绝'})));
  await handleSpecificationGeneration(request,res(),'image');
  expect(db.select().from(contents).get()?.status).toBe('failed');expect(db.select().from(users).get()?.balance).toBe(100);
  resumeSpecificationTasks();expect(fetch).toHaveBeenCalledTimes(2);
});
it('image file save failure recovers the accepted original without another paid POST',async()=>{
  const request=enableImage(),id='e'.repeat(32);
  vi.mocked(localizeGeneratedImage).mockRejectedValueOnce(new Error('disk temporarily unavailable'));
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(Response.json({task_id:id,status:'pending'})).mockResolvedValueOnce(Response.json({task_id:id,state:'success',is_final:true,result_url:'https://cdn.example/image.png'})));
  await handleSpecificationGeneration(request,res(),'image');
  expect(JSON.parse(db.select().from(contents).get()!.metadata).requiresReview).toBe(true);expect(db.select().from(users).get()?.balance).toBe(98);
  resumeSpecificationTasks();await vi.waitFor(()=>expect(db.select().from(contents).get()?.status).toBe('completed'));
  expect(fetch).toHaveBeenCalledTimes(2);expect(db.select().from(users).get()?.balance).toBe(98);
});
