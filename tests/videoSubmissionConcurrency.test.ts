import { beforeAll, beforeEach, afterEach, afterAll, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
const probes = vi.hoisted(() => ({
  video: vi.fn(), audio: vi.fn(),
}));
vi.mock('../server/services/videoDurationProbe.js', async importOriginal => ({
  ...await importOriginal<typeof import('../server/services/videoDurationProbe.js')>(),
  probeReferenceVideoSeconds: probes.video,
  probeReferenceAudioSeconds: probes.audio,
}));

vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { getTableConfig, SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core');
  const schema = await import('../server/db/schema');
  const sqlite = new Database(':memory:'), dialect = new SQLiteSyncDialect();
  for (const table of Object.values(schema)) {
    const config = getTableConfig(table as any);
    const columns = config.columns.map(c => {
      const value = typeof c.default === 'object' ? dialect.sqlToQuery(c.default as any).sql
        : typeof c.default === 'string' ? "'" + c.default.replace(/'/g, "''") + "'" : String(c.default);
      return '"' + c.name + '" ' + c.getSQLType() + (c.primary ? ' PRIMARY KEY' : c.isUnique ? ' UNIQUE' : '')
        + (c.default === undefined ? '' : ' DEFAULT ' + value);
    });
    sqlite.exec('CREATE TABLE "' + config.name + '" (' + columns.join(',') + ')');
  }
  return { sqlite, db: drizzle(sqlite, { schema }) };
});
vi.mock('../server/config/env.js', () => ({ env: { NODE_ENV: 'test', JWT_SECRET: 'test', VIDEO_TASK_POLL_TIMEOUT_MS: 100000, PORT: 9876 } }));
vi.mock('../server/middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => { req.userId = 1; next(); },
  optionalAuthMiddleware: (_req: any, _res: any, next: any) => next(),
  activeApiKeyMiddleware: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../server/middleware/tier.js', () => ({ tierMiddleware: () => (_req: any, _res: any, next: any) => next() }));
vi.mock('../server/middleware/quota.js', () => ({ quotaMiddleware: (_req: any, _res: any, next: any) => next(), logUsage: vi.fn() }));
vi.mock('../server/services/videoLocalizationService.js', () => ({
  downloadAndLocalizeVideo: vi.fn(async () => '/uploads/concurrency-test.mp4'), preferredVideoDownloadPath: (p: string) => p,
}));

import { db, sqlite } from '../server/db/index';
import { users, channels, channelApiKeys, models, modelPricing, contents, apiTokens } from '../server/db/schema';
import { getHmStudioUpstreamVideoModel } from '../shared/hmStudioVideo';
import { TokenService } from '../server/services/tokenService';
import { findVideoSubmissionReceipt } from '../server/services/videoSubmissionReceiptService';
import { claimVideoSubmission, releaseVideoSubmission, endVideoSubmission } from '../server/services/videoSubmissionGuard';
import { saveModelSpecification } from '../server/services/modelRoutingService';
import { defaultRoutingLimits } from '../shared/modelRouting';
import { VideoRecoveryService as ContentRecoveryService } from '../server/services/videoRecoveryService';
import { resumeSpecificationTasks } from '../server/services/specificationGenerationService';
import * as snumomAdapter from '../server/services/snumomWanAdapter';
import { settleDirectVideoBilling } from '../server/services/directVideoBillingService';
import { ensureBillingReservations } from '../server/services/billingReservation';
import { RETIRED_VIDEO_MODELS } from '../shared/retiredVideoModels';
import { getEnabledPublicModels } from '../server/services/modelCatalogService';
import { ChannelService } from '../server/services/channelService';
import { getModelSpecification } from '../server/services/modelRoutingService';
import { SNUMOM_OUTPUT_ONLY_MODELS } from '../shared/snumomWanNsfw';
import { existingModelLimits } from '../server/services/modelInputPresets';
import { funAiModelLimits } from '../shared/funAi';
import { batchStore, tickVideoBatches } from '../server/services/videoBatchService';

const nativeFetch = globalThis.fetch, nativeTimer = globalThis.setTimeout;
const model = 'wan3.0-video-nsfw';
let video: typeof import('../server/routes/video'), server: Server, origin: string, tokenKey: string, tokenId: number;
const row = () => db.select().from(contents).all().at(-1)!;
const wallet = () => db.select().from(users).get()!.balance;
const tokenWallet = () => db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get()!.balance;
const meta = () => JSON.parse(row().metadata);
const post = (path: string, body: any) => nativeFetch(origin + path, {
  method: 'POST', headers: { Authorization: 'Bearer ' + tokenKey, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body),
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
beforeAll(async () => {
  video = await import('../server/routes/video');
  const api = await import('../server/routes/v1'), content = await import('../server/routes/content');
  const batchRouter = await import('../server/routes/videoBatches');
  const app = express(); app.use(express.json()); app.use('/api/video-batches',batchRouter.default); app.use('/api/video', video.default); app.use('/v1', api.default); app.use('/api/contents', content.default);
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  findVideoSubmissionReceipt(1);
});
beforeEach(() => {
  sqlite.exec('DROP TABLE IF EXISTS api_video_requests');
  for (const table of ['video_batch_commands','video_batch_attempts','video_batch_items','video_batches']) {
    if (sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) sqlite.exec('DELETE FROM '+table);
  }
  for (const table of ['fund_ledger_content_links','fund_ledger']) {
    if (sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) sqlite.exec('DELETE FROM ' + table);
  }
  probes.video.mockReset().mockResolvedValue({ rawDurations: [5.01], durations: [5.1], total: 5.1 });
  probes.audio.mockReset().mockResolvedValue({ rawDurations: [3.01], durations: [3.1], total: 3.1 });
  for (const table of ['contents','channels','users','models','model_pricing','api_tokens','api_logs','settings','video_submission_receipts']) sqlite.exec('DELETE FROM ' + table);
  sqlite.exec('DROP TABLE IF EXISTS billing_reservations');
  db.insert(users).values({ id: 1, email: 'race@test', username: 'test', passwordHash: 'test', balance: 100 }).run();
  db.insert(channels).values({ id: 1, name: 'snumom test', type: 'snumom', baseUrl: 'https://upstream.invalid', apiKey: 'test', status: 1,
    supportedModels: JSON.stringify([model]), modelMapping: '{}' }).run();
  db.insert(models).values({ modelId: model, displayName: model, provider: 'snumom', capabilities: '["video"]', isActive: 1 }).run();
  db.insert(modelPricing).values({ modelPattern: model, billingType: 'per_second', inputPrice: 0.26, outputPrice: 0 }).run();
  const token = TokenService.createToken({ userId: 1, name: 'test', balance: 100 }); tokenKey = token.tokenKey; tokenId = token.id;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms: number, ...args: any[]) => nativeTimer(fn, [5000,8000,10000,12000].includes(ms) ? 2 : ms, ...args)) as any);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); sqlite.close(); });

function managed(targetModel = model) {
  const limits = { ...defaultRoutingLimits(), maxImages: 9, resolutions: ['720p'], ratios: ['16:9'],
    duration: { mode: 'options' as const, min: 15, max: 15, step: 1, values: [15] } };
  saveModelSpecification({ modelId: targetModel, enabled: true, aliases: [], kind: 'video', limits,
    routes: [{ id: 'race-route', channelId: 1, executionModel: targetModel, upstreamModel: targetModel, enabled: true,
      limits, cost: 1, costUnit: 'per_second', resolutionCosts: {}, priority: 0 }] });
}
const body = { model, prompt: '并发提交测试', seconds: 15, video_length: 15, resolution: '720p', aspect_ratio: '16:9' };

function extraSetup(id: string, provider: 'hmstudio'|'funai', spec: boolean) {
  const upstream=provider==='hmstudio'?getHmStudioUpstreamVideoModel(id):id.replace(/^funai-/,'');
  db.delete(channelApiKeys).run();
  if(provider==='hmstudio')db.insert(channelApiKeys).values({channelId:1,apiKey:'test-extra-key',status:1,concurrencyLimit:5}).run();
  db.update(channels).set({type:provider,supportedModels:JSON.stringify([id]),modelMapping:JSON.stringify({[id]:upstream})}).run();
  db.update(models).set({modelId:id,displayName:id,provider}).run();
  db.update(modelPricing).set({modelPattern:id,billingType:'per_call',inputPrice:1}).run();
  if(spec) {
    const limits=provider==='funai'?funAiModelLimits(upstream):existingModelLimits(id,'video')!;
    saveModelSpecification({modelId:id,kind:'video',enabled:true,aliases:[],limits,
      routes:[{id:'extras-route',channelId:1,executionModel:id,upstreamModel:upstream,enabled:true,limits,cost:1,costUnit:'per_call',resolutionCosts:{},priority:0}]});
  }
  return {model:provider==='funai'?upstream:id,prompt:'参数传递测试',seconds:4,video_length:4,resolution:'720p',aspect_ratio:'16:9'};
}
function extraUpstream(provider: string) {
  const payloads: any[]=[];
  vi.stubGlobal('fetch',vi.fn(async(_url:any,options:any)=>{
    if(options?.method==='POST') {payloads.push(JSON.parse(options.body));return Response.json({id:'extras-accepted',task_id:'extras-accepted'},{status:202});}
    return Response.json(provider==='hmstudio'?{status:'success',result_urls:['https://media.invalid/extras.mp4']}:{id:'extras-accepted',status:'completed',url:'https://media.invalid/extras.mp4'});
  }));return payloads;
}
for(const endpoint of ['/v1/videos','/api/video/generate']) {
  for(const spec of [false,true]) it.each([
    ['MiniMax-H3','first_last_frames'],['sd2.5-933','first_last_frames'],['seedance_v2.0-933','multi_frame'],
  ])(`${endpoint} managed=${spec}: HM %s carries explicit %s through the real queue/adapter`,async(id,mode)=>{
    const input=extraSetup(id,'hmstudio',spec),payloads=extraUpstream('hmstudio');
    const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
    const response=await post(endpoint,{...input,reference_images:[image,image],model_parameters:{function_mode:mode}});
    expect(response.status,await response.clone().text()).toBe(endpoint.startsWith('/v1')&&!spec?202:200);await response.text();await vi.waitFor(()=>expect(row()?.status).toBe('completed'));
    expect(payloads).toHaveLength(1);expect(payloads[0].function_mode).toBe(mode);expect(payloads[0]).not.toHaveProperty('materials');
    if(mode==='multi_frame')expect(payloads[0].multi_frames).toHaveLength(2);else expect(payloads[0]).toMatchObject({first_frame_url:expect.any(String),end_frame_url:expect.any(String)});
    expect(endpoint.startsWith('/v1')?tokenWallet():wallet()).toBe(99);
  });
  it.each(['funai-veo-3.1','funai-veo-3.1-lite'])(`${endpoint}: %s audio=false survives API normalization and actual managed submission`,async(id)=>{
    const input=extraSetup(id,'funai',true),payloads=extraUpstream('funai');
    const response=await post(endpoint,{...input,model_parameters:{audio:false}});expect(response.status).toBe(200);await response.text();
    await vi.waitFor(()=>expect(row()?.status).toBe('completed'));expect(payloads).toHaveLength(1);expect(payloads[0].audio).toBe(false);
  });
  it.each(['frame','style','element'])(`${endpoint}: Omni %s maps every reference to the documented field`,async(mode)=>{
    const input=extraSetup('funai-gemini-omni-flash','funai',true),payloads=extraUpstream('funai');
    const response=await post(endpoint,{...input,reference_images:['https://assets.invalid/1.png'],model_parameters:{reference_mode:mode}});
    expect(response.status).toBe(200);await response.text();await vi.waitFor(()=>expect(row()?.status).toBe('completed'));
    expect(payloads).toHaveLength(1);
    expect(payloads[0][mode==='frame'?'input_reference':mode==='style'?'style_references':'element_references']).toEqual(mode==='frame'?'https://assets.invalid/1.png':['https://assets.invalid/1.png']);
  });
  it.each([
    ['funai-veo-3.1',{audio:'false'},[]],
    ['funai-gemini-omni-flash',{reference_mode:'frame'},['https://assets.invalid/1.png','https://assets.invalid/2.png']],
    ['funai-gemini-omni-flash',{reference_mode:'style'},[]],
    ['seedance_v2.0-933',{function_mode:'multi_frame'},['https://assets.invalid/1.png']],
    ['MiniMax-H3',{function_mode:'first_last_frames'},['https://assets.invalid/1.png','https://assets.invalid/2.png','https://assets.invalid/3.png']],
  ])(`${endpoint}: invalid %s extras/media are rejected before task creation or deduction`,async(id,values,images)=>{
    const input=extraSetup(id as string,String(id).startsWith('funai-')?'funai':'hmstudio',true),payloads=extraUpstream('funai');
    const response=await post(endpoint,{...input,reference_images:images,model_parameters:values});
    expect(response.status).toBe(400);expect(await response.json()).toHaveProperty('error');expect(payloads).toEqual([]);
    expect(db.select().from(contents).all()).toHaveLength(0);expect(wallet()).toBe(100);expect(tokenWallet()).toBe(100);
  });
}
it('multipart API preserves audio=false as a typed special parameter, not an uploaded audio asset',async()=>{
  const input=extraSetup('funai-veo-3.1','funai',true),payloads=extraUpstream('funai'),form=new FormData();
  for(const [key,value] of Object.entries(input))form.set(key,String(value));form.set('model_parameters',JSON.stringify({audio:false}));
  const response=await nativeFetch(origin+'/v1/videos',{method:'POST',headers:{Authorization:'Bearer '+tokenKey},body:form});
  expect(response.status).toBe(200);await response.text();await vi.waitFor(()=>expect(row()?.status).toBe('completed'));
  expect(payloads[0].audio).toBe(false);
});
it('batch quote, persisted settings and actual worker keep typed audio=false without charging or submitting twice',async()=>{
  extraSetup('funai-veo-3.1','funai',true);const payloads:any[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:any,options:any)=>{
    if(String(url).startsWith('http://127.0.0.1:9876/'))return nativeFetch(origin+new URL(String(url)).pathname,options);
    if(options?.method==='POST'){payloads.push(JSON.parse(options.body));return Response.json({id:'extras-batch-'+payloads.length});}
    return Response.json({id:String(url).split('/').at(-1),status:'completed',url:'https://media.invalid/batch.mp4'});
  }));
  const input={model:'funai-veo-3.1',name:'special parameters batch',aspect_ratio:'16:9',resolution:'720p',video_length:4,autoRetry:false,maxRetries:0,
    requestKey:'special-batch-request-key-111',expectedUnitCost:1,model_parameters:{audio:false},creatives:[{prompt:'自然风景',count:2,reference_images:[]}]};
  const response=await post('/api/video-batches',input);expect(response.status,await response.clone().text()).toBe(200);const batch:any=await response.json();
  await vi.waitFor(()=>{tickVideoBatches();expect(db.select().from(contents).all()).toHaveLength(2);expect(db.select().from(contents).all().every(c=>c.status==='completed')).toBe(true);});
  expect(payloads).toHaveLength(2);expect(payloads.every(p=>p.audio===false)).toBe(true);expect(wallet()).toBe(98);
  expect((await(await post('/api/video-batches',input)).json()).id).toBe(batch.id);tickVideoBatches();expect(payloads).toHaveLength(2);expect(wallet()).toBe(98);
});

const nsfwModel = 'wan3.0-video-nsfw';
const nsfwPaths = [
  ['/v1/videos',false],['/api/video/generate',false],
  ['/v1/videos',true],['/api/video/generate',true],
] as const;
function setupNsfw(spec: boolean, unlimited = false) {
  db.update(channels).set({supportedModels:JSON.stringify([nsfwModel]),concurrencyLimit:10}).run();
  db.update(models).set({modelId:nsfwModel,displayName:nsfwModel}).run();
  db.update(modelPricing).set({modelPattern:nsfwModel,billingType:'per_second',inputPrice:1}).run();
  if (unlimited) db.update(apiTokens).set({balance:-1}).run();
  if (spec) {
    const limits = {...defaultRoutingLimits(),maxImages:10,maxVideos:5,maxAudios:5,firstFrame:true,lastFrame:true,
      resolutions:['480p','720p','1080p'],ratios:['16:9','9:16','adaptive'],duration:{mode:'range' as const,min:2,max:30,step:1,values:[]}};
    saveModelSpecification({modelId:nsfwModel,kind:'video',enabled:true,aliases:[],limits,
      routes:[{id:'nsfw-route',channelId:1,executionModel:nsfwModel,upstreamModel:nsfwModel,enabled:true,limits,cost:1,costUnit:'per_second',resolutionCosts:{},priority:0}]});
  }
}
const nsfwBody = {model:nsfwModel,prompt:'测试自然风景',seconds:10,video_length:10,resolution:'720p',aspect_ratio:'16:9',
  reference_videos:['https://example.com/reference.mp4'],audio_urls:['https://example.com/voice.wav'],reference_video_seconds:0.01};

for(const [newModel,definition] of Object.entries(SNUMOM_OUTPUT_ONLY_MODELS)) {
  function setupOutputOnly(spec:boolean) {
    setupNsfw(false);
    db.update(models).set({modelId:newModel}).run();
    db.update(modelPricing).set({modelPattern:newModel}).run();
    db.update(channels).set({supportedModels:JSON.stringify([newModel])}).run();
    if(spec){const limits=existingModelLimits(newModel,'video')!;saveModelSpecification({modelId:newModel,kind:'video',enabled:true,aliases:[],limits,
      routes:[{id:'output-only-route',channelId:1,executionModel:newModel,upstreamModel:newModel,enabled:true,limits,cost:1,costUnit:'per_second',resolutionCosts:{},priority:0}]});}
    return {...nsfwBody,model:newModel,seconds:30,video_length:30,resolution:definition.resolution};
  }
  for(const state of ['completed','failed','timeout'] as const)it.each(nsfwPaths)(`${newModel} %s spec=%s ${state}: 30 seconds plus reference, output-only billing and idempotent recovery`,async(endpoint,spec)=>{
    const request=setupOutputOnly(spec);let payload:any;
    const upstream=vi.fn(async(_url:any,options:any)=>{
      if(options?.method==='POST'){payload=JSON.parse(options.body);if(state==='timeout')throw new Error('socket hang up');return Response.json({id:'task_output_only'});}
      return Response.json({id:'task_output_only',status:state,error:state==='failed'?{message:'confirmed rejection'}:undefined,
        usage:{output_seconds:30,reference_video_seconds:5.1},metadata:{url:'https://media.invalid/result.mp4'}});
    });vi.stubGlobal('fetch',upstream);
    await(await post(endpoint,request)).text();
    if(state==='timeout')await vi.waitFor(()=>expect(meta().billingStatus).toBe('review'));
    else await vi.waitFor(()=>expect(row().status).toBe(state));
    expect(payload).toMatchObject({model:newModel,seconds:'30',size:definition.resolution.toUpperCase(),reference_videos:[{url:expect.any(String)}]});
    expect(meta().billableSeconds).toBe(30);expect(meta().referenceVideoSeconds).toBe(5.1);
    expect(endpoint.startsWith('/v1')?tokenWallet():wallet()).toBeCloseTo(state==='failed'?100:70);
    video.resumeAllPendingVideoTasks();resumeSpecificationTasks();
    expect(endpoint.startsWith('/v1')?tokenWallet():wallet()).toBeCloseTo(state==='failed'?100:70);
    expect(upstream.mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(1);
  });
  it.each(nsfwPaths)(`${newModel} %s spec=%s: invalid duration/resolution and probe failure reject before charging`,async(endpoint,spec)=>{
    const request=setupOutputOnly(spec);vi.stubGlobal('fetch',vi.fn());
    for(const bad of [{...request,seconds:4,video_length:4},{...request,resolution:'480p'}]){const r=await post(endpoint,bad);expect(r.status).toBe(400);await r.text();}
    probes.video.mockRejectedValue(new Error('reference probe unavailable'));
    const response=await post(endpoint,request);expect(response.status).toBe(400);await response.text();
    expect(db.select().from(contents).all()).toHaveLength(0);expect(wallet()).toBe(100);expect(tokenWallet()).toBe(100);expect(fetch).not.toHaveBeenCalled();
  });
  it.each(nsfwPaths)(`${newModel} %s spec=%s: minimum duration and immediate completed receipt charge output only`,async(endpoint,spec)=>{
    const request=setupOutputOnly(spec),seconds=definition.seconds[0];
    db.update(models).set({displayName:'operator alias'}).run();
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({id:'task_output_immediate',status:'completed',usage:{output_seconds:seconds,reference_video_seconds:5.1},metadata:{url:'https://media.invalid/result.mp4'}})));
    await(await post(endpoint,{...request,model:'operator alias',seconds:undefined,video_length:undefined,duration_seconds:seconds})).text();await vi.waitFor(()=>expect(row().status).toBe('completed'));
    expect(row().cost).toBe(seconds);expect(endpoint.startsWith('/v1')?tokenWallet():wallet()).toBe(100-seconds);expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([false,true])(`${newModel} batch spec=%s: references are free, repeated request key cannot double reserve`,async spec=>{
    setupOutputOnly(spec);let submitted=0;
    vi.stubGlobal('fetch',vi.fn(async(url:any,options:any)=>{
      if(String(url).startsWith('http://127.0.0.1:9876/'))return nativeFetch(origin+new URL(String(url)).pathname,options);
      if(options?.method==='POST')return Response.json({id:'task_output_batch_'+(++submitted)});
      return Response.json({id:String(url).split('/').at(-1),status:'completed',usage:{output_seconds:30,reference_video_seconds:5.1},metadata:{url:'https://media.invalid/result.mp4'}});
    }));
    const input={model:newModel,name:'output-only batch',aspect_ratio:'16:9',resolution:definition.resolution,video_length:30,autoRetry:false,maxRetries:0,
      requestKey:'output-only-batch-key-20261030',expectedUnitCost:30,creatives:[{prompt:'风景测试',count:2,reference_videos:nsfwBody.reference_videos,audio_urls:nsfwBody.audio_urls}]};
    const first=await post('/api/video-batches',input);expect(first.status).toBe(200);const batch:any=await first.json();
    await vi.waitFor(()=>{tickVideoBatches();expect(db.select().from(contents).all()).toHaveLength(2);expect(db.select().from(contents).all().every(c=>c.status==='completed')).toBe(true);});
    tickVideoBatches();expect(wallet()).toBe(40);expect(submitted).toBe(2);
    const again=await post('/api/video-batches',input);expect((await again.json()).id).toBe(batch.id);tickVideoBatches();expect(wallet()).toBe(40);expect(submitted).toBe(2);
  });
}

for (const retired of RETIRED_VIDEO_MODELS) {
  it.each([false,true])(`retired ${retired} managed=%s: all website/API aliases and batch entrances reject before debit or POST`,async spec=>{
    db.update(models).set({modelId:retired,displayName:'old operator name'}).run();
    db.update(modelPricing).set({modelPattern:retired}).run();
    db.update(channels).set({supportedModels:'["*"]'}).run();
    if(spec)managed(retired);
    vi.stubGlobal('fetch',vi.fn());
    for(const endpoint of ['/api/video/generate','/api/video/validate','/v1/videos','/v1/videos/generations','/v1/video/generations']){
      const response=await post(endpoint,{...body,model:retired});
      expect(response.status).toBe(410);expect(await response.text()).toContain('已下架');
    }
    for(const endpoint of ['/api/video-batches','/api/video-batches/quote']){
      const response=await post(endpoint,{model:retired,requestKey:'retired-model-request-key'});expect(response.status).toBe(410);await response.text();
    }
    const alias=await post('/v1/videos',{...body,model:'old operator name'});expect(alias.status).toBe(410);await alias.text();
    expect(getEnabledPublicModels('video').map(m=>m.modelId)).not.toContain(retired);
    expect(ChannelService.findChannelForModel(retired)).toBeNull();
    expect(wallet()).toBe(100);expect(tokenWallet()).toBe(100);expect(db.select().from(apiTokens).get()!.usedAmount).toBe(0);
    expect(db.select().from(contents).all()).toHaveLength(0);expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['/v1/videos','/api/video/generate'])(`retired upstream ${retired} cannot be reached through another public specification at %s`,async endpoint=>{
    setupNsfw(true);
    const spec=getModelSpecification(nsfwModel)!;
    saveModelSpecification({...spec,routes:spec.routes.map(r=>({...r,upstreamModel:retired}))});
    vi.stubGlobal('fetch',vi.fn());
    const response=await post(endpoint,nsfwBody);expect(response.status).toBeGreaterThanOrEqual(400);await response.text();
    expect(fetch).not.toHaveBeenCalled();expect(wallet()).toBe(100);expect(tokenWallet()).toBe(100);
    expect(db.select().from(contents).all()).toHaveLength(0);
  });
}

it('snumom model sync excludes retired products without modifying existing prices or balances',async()=>{
  const prices=JSON.stringify(db.select().from(modelPricing).all());
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({data:[...RETIRED_VIDEO_MODELS,nsfwModel,'sd-mini'].map(id=>({id}))})));
  const result=await ChannelService.syncModels(1);
  expect(result.models).toEqual([nsfwModel,'sd-mini']);
  for(const retired of RETIRED_VIDEO_MODELS)expect(db.select().from(models).all().some(m=>m.modelId===retired)).toBe(false);
  expect(JSON.stringify(db.select().from(modelPricing).all())).toBe(prices);expect(wallet()).toBe(100);expect(tokenWallet()).toBe(100);
});

it.each(['/v1/videos','/api/video/generate'])('NSFW %s: wildcard channels cannot bypass snumom reference billing',async endpoint=>{
  setupNsfw(false);
  db.insert(channels).values({id:2,name:'other wildcard',type:'openai',baseUrl:'https://other.invalid',apiKey:'test',status:1,
    supportedModels:'["*"]',modelMapping:'{}',priority:-100}).run();
  const upstream=vi.fn(async(url:any,o:any)=>{
    expect(String(url)).toContain('upstream.invalid');
    return o?.method==='POST'?Response.json({id:'task_nsfw_provider'}):Response.json({id:'task_nsfw_provider',status:'completed',metadata:{url:'https://media.invalid/result.mp4'}});
  });
  vi.stubGlobal('fetch',upstream);
  await(await post(endpoint,nsfwBody)).text();await vi.waitFor(()=>expect(row().status).toBe('completed'));
  expect(meta().channelId).toBe(1);expect(meta().billableSeconds).toBe(15.1);
  expect(upstream.mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(1);
});

it.each(nsfwPaths)('NSFW %s managed=%s: probes references, reserves output+rounded-video seconds, not audio, and refunds failure once', async (endpoint,spec) => {
  setupNsfw(spec);
  let sent: any;
  const upstream = vi.fn(async (_url:any, options:any)=> {
    if (options?.method==='POST') {sent=JSON.parse(options.body);return Response.json({id:'task_nsfw_failed',status:'queued'});}
    return Response.json({id:'task_nsfw_failed',status:'failed',error:{code:'DataInspectionFailed',message:'image rejected'}});
  });
  vi.stubGlobal('fetch',upstream);
  const result = await post(endpoint,nsfwBody); await result.text();
  await vi.waitFor(()=>expect(row().status).toBe('failed'));
  expect(sent).toMatchObject({model:nsfwModel,seconds:'10',size:'720P',reference_videos:[{url:expect.any(String)}],reference_audios:[{url:expect.any(String)}]});
  expect(meta()).toMatchObject({referenceVideoSeconds:5.1,referenceAudioSeconds:3.1,billableSeconds:15.1,billingStatus:'refunded'});
  expect(wallet()).toBe(100);expect(tokenWallet()).toBe(100);expect(db.select().from(apiTokens).get()!.usedAmount).toBe(0);
  expect(probes.video).toHaveBeenCalledOnce();expect(probes.audio).toHaveBeenCalledOnce();
  video.resumeAllPendingVideoTasks();resumeSpecificationTasks();
  expect(wallet()).toBe(100);expect(tokenWallet()).toBe(100);
  expect(upstream.mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(1);
});

it.each(nsfwPaths)('NSFW %s managed=%s: probe errors cannot create a task or debit funds', async(endpoint,spec)=>{
  setupNsfw(spec);probes.video.mockRejectedValue(new Error('unreachable reference video'));
  vi.stubGlobal('fetch',vi.fn());
  const response=await post(endpoint,nsfwBody);expect(response.status).toBe(400);expect(await response.text()).toContain('unreachable');
  expect(wallet()).toBe(100);expect(tokenWallet()).toBe(100);expect(fetch).not.toHaveBeenCalled();expect(db.select().from(contents).all()).toHaveLength(0);
});

it.each(nsfwPaths)('NSFW %s managed=%s: unknown submit acceptance keeps the full reference reservation without replay/refund',async(endpoint,spec)=>{
  setupNsfw(spec);vi.stubGlobal('fetch',vi.fn(async()=>{throw new DOMException('connection lost','TimeoutError');}));
  await(await post(endpoint,nsfwBody)).text();
  await vi.waitFor(()=>expect(meta().billingStatus).toBe('review'));
  expect(endpoint.startsWith('/v1')?tokenWallet():wallet()).toBeCloseTo(84.9);
  video.resumeAllPendingVideoTasks();resumeSpecificationTasks();expect(fetch).toHaveBeenCalledOnce();
  expect(endpoint.startsWith('/v1')?tokenWallet():wallet()).toBeCloseTo(84.9);
});

it.each(nsfwPaths)('NSFW %s managed=%s: explicit no-channel rejection ends and refunds the original reservation once',async(endpoint,spec)=>{
  setupNsfw(spec);vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error:{message:'No available channel for model wan3.0-video-nsfw under group default (distributor)'}},{status:503})));
  await(await post(endpoint,nsfwBody)).text();await vi.waitFor(()=>expect(row().status).toBe('failed'));
  expect(wallet()).toBe(100);expect(tokenWallet()).toBe(100);expect(meta().billingStatus).toBe('refunded');
  video.resumeAllPendingVideoTasks();resumeSpecificationTasks();expect(fetch).toHaveBeenCalledOnce();
  expect(wallet()).toBe(100);expect(tokenWallet()).toBe(100);
});

it.each([false,true].flatMap(spec=>['completed','failed'].map(status=>({spec,status}))))('NSFW managed=$spec status=$status: real batch bridge reserves references once and reuses the original batch request key',async ({spec,status})=>{
  setupNsfw(spec);let submissions=0;
  const upstream=vi.fn(async(url:any,options:any)=>{
    if(String(url).startsWith('http://127.0.0.1:9876/'))return nativeFetch(origin+new URL(String(url)).pathname,options);
    if(options?.method==='POST')return Response.json({id:'task_nsfw_batch_'+(++submissions)});
    return Response.json({id:String(url).split('/').at(-1),status,error:status==='failed'?{code:'DataInspectionFailed',message:'image rejected'}:undefined,metadata:status==='completed'?{url:'https://media.invalid/result.mp4'}:undefined});
  });vi.stubGlobal('fetch',upstream);
  const input={model:nsfwModel,name:'reference batch',aspect_ratio:'16:9',resolution:'720p',video_length:10,autoRetry:false,maxRetries:0,
    requestKey:'nsfw-batch-duplicate-key-20261030',expectedUnitCost:15.1,
    creatives:[{prompt:'风景视频',count:2,reference_images:[],reference_videos:nsfwBody.reference_videos,audio_urls:nsfwBody.audio_urls}]};
  const first=await post('/api/video-batches',input);expect(first.status).toBe(200);const batch:any=await first.json();
  await vi.waitFor(()=>{tickVideoBatches();expect(db.select().from(contents).all(),JSON.stringify(batchStore.detail(batch.id,1).items)).toHaveLength(2);expect(db.select().from(contents).all().every(c=>c.status===status)).toBe(true);});
  tickVideoBatches();tickVideoBatches();
  expect(wallet()).toBeCloseTo(status==='completed'?69.8:100);expect(tokenWallet()).toBe(100);expect(submissions).toBe(2);
  expect(batchStore.detail(batch.id,1)).toMatchObject({spent:status==='completed'?30.2:0,refunded:status==='failed'?30.2:0,reserved:0});
  const again=await post('/api/video-batches',input);expect((await again.json()).id).toBe(batch.id);
  tickVideoBatches();expect(wallet()).toBeCloseTo(status==='completed'?69.8:100);expect(submissions).toBe(2);
});

it.each(nsfwPaths.flatMap(([endpoint,spec])=>[13,17].map(actual=>({endpoint,spec,actual}))))('NSFW $endpoint managed=$spec: settles actual=$actual once with the original snapshot',async({endpoint,spec,actual})=>{
  setupNsfw(spec);
  const upstream=vi.fn(async(_url:any,options:any)=>{
    if(options?.method==='POST'){db.update(modelPricing).set({inputPrice:99}).run();return Response.json({id:'task_nsfw_actual'});}
    return Response.json({id:'task_nsfw_actual',status:'completed',usage:{billable_seconds:actual},metadata:{url:'https://media.invalid/result.mp4'}});
  });vi.stubGlobal('fetch',upstream);
  await(await post(endpoint,nsfwBody)).text();await vi.waitFor(()=>expect(row().status).toBe('completed'));
  expect(row().cost).toBe(actual);expect(endpoint.startsWith('/v1')?tokenWallet():wallet()).toBe(100-actual);
  if(endpoint.startsWith('/v1'))expect(db.select().from(apiTokens).get()!.usedAmount).toBe(actual);
  video.resumeAllPendingVideoTasks();resumeSpecificationTasks();
  expect(endpoint.startsWith('/v1')?tokenWallet():wallet()).toBe(100-actual);
  expect(upstream.mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(1);
});

it.each(nsfwPaths)('NSFW %s managed=%s: delayed ID plus concurrent recovery scans never refunds or sends another POST',async(endpoint,spec)=>{
  setupNsfw(spec);const started=deferred<void>(),reply=deferred<Response>();
  const upstream=vi.fn(async(_url:any,options:any)=>{if(options?.method==='POST'){started.resolve();return reply.promise;}return Response.json({id:'task_nsfw_delayed',status:'completed',metadata:{url:'https://media.invalid/result.mp4'}});});
  vi.stubGlobal('fetch',upstream);const pending=post(endpoint,nsfwBody);await started.promise;
  const id=row().id,stale={...row(),metadata:'{}'};
  for(let i=0;i<3;i++){
    await Promise.all([video.resumePollForTask(id,stale),ContentRecoveryService.inspect(id).catch(()=>undefined),nativeFetch(origin+'/api/contents/'+id).then(r=>r.text())]);
    video.resumeAllPendingVideoTasks();resumeSpecificationTasks();
  }
  expect(row().status).toBe('processing');expect(meta().videoSubmissionState).toBe('submitting');
  expect(endpoint.startsWith('/v1')?tokenWallet():wallet()).toBeCloseTo(84.9);expect(meta().queueRefunded).not.toBe(true);
  expect(upstream.mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(1);
  reply.resolve(Response.json({id:'task_nsfw_delayed',status:'queued'}));await(await pending).text();await vi.waitFor(()=>expect(row().status).toBe('completed'));
  expect(findVideoSubmissionReceipt(id)?.upstreamTaskId).toBe('task_nsfw_delayed');
  expect(endpoint.startsWith('/v1')?tokenWallet():wallet()).toBeCloseTo(84.9);
});

it.each(nsfwPaths.flatMap(([endpoint,spec])=>['completed','failed'].map(status=>({endpoint,spec,status}))))('NSFW $endpoint managed=$spec: immediate $status is consumed after persisting the task ID',async({endpoint,spec,status})=>{
  setupNsfw(spec);
  const upstream=vi.fn(async(_url:any,o:any)=>{
    if(o?.method!=='POST')throw new Error('terminal create response must not require another query');
    return Response.json({id:'task_nsfw_terminal',status,error:status==='failed'?{code:'DataInspectionFailed',message:'image rejected'}:undefined,
      usage:status==='completed'?{billable_seconds:13}:undefined,metadata:status==='completed'?{url:'https://media.invalid/result.mp4'}:undefined});
  });vi.stubGlobal('fetch',upstream);
  await(await post(endpoint,nsfwBody)).text();await vi.waitFor(()=>expect(row().status).toBe(status));
  expect(meta().videoId).toBe('task_nsfw_terminal');expect(findVideoSubmissionReceipt(row().id)?.upstreamTaskId).toBe('task_nsfw_terminal');
  expect(endpoint.startsWith('/v1')?tokenWallet():wallet()).toBe(status==='completed'?87:100);
  video.resumeAllPendingVideoTasks();resumeSpecificationTasks();expect(upstream).toHaveBeenCalledOnce();
});

it.each(nsfwPaths)('NSFW %s managed=%s: insufficient actual-settlement balance preserves result and original charge, not a generation failure',async(endpoint,spec)=>{
  setupNsfw(spec);vi.stubGlobal('fetch',vi.fn(async(_url:any,o:any)=>o?.method==='POST'?Response.json({id:'task_nsfw_shortfall'}):Response.json({id:'task_nsfw_shortfall',status:'completed',usage:{billable_seconds:101},metadata:{url:'https://media.invalid/result.mp4'}})));
  await(await post(endpoint,nsfwBody)).text();await vi.waitFor(()=>expect(row().status).toBe('review'));
  expect(meta()).toMatchObject({reviewKind:'settlement',billingStatus:'review',upstreamStatus:'completed'});
  expect(row().resultUrl).toBeTruthy();expect(endpoint.startsWith('/v1')?tokenWallet():wallet()).toBeCloseTo(84.9);
  video.resumeAllPendingVideoTasks();resumeSpecificationTasks();expect(endpoint.startsWith('/v1')?tokenWallet():wallet()).toBeCloseTo(84.9);
});

it.each(nsfwPaths)('NSFW %s managed=%s: rejects tail-only frames and wrong billing configuration before any reservation',async(endpoint,spec)=>{
  setupNsfw(spec);vi.stubGlobal('fetch',vi.fn());
  const invalid=await post(endpoint,{...nsfwBody,last_frame:'https://example.com/end.jpg',reference_videos:[],audio_urls:[]});
  expect(invalid.status).toBe(400);await invalid.text();expect(wallet()).toBe(100);expect(tokenWallet()).toBe(100);
  db.update(modelPricing).set({billingType:'per_call'}).run();
  const wrongPrice=await post(endpoint,nsfwBody);await wrongPrice.text();
  expect(fetch).not.toHaveBeenCalled();expect(db.select().from(contents).all()).toHaveLength(0);expect(wallet()).toBe(100);expect(tokenWallet()).toBe(100);
});

it.each(nsfwPaths)('NSFW %s managed=%s: media objects and size are normalized without trusting supplied reference duration',async(endpoint,spec)=>{
  setupNsfw(spec);let sent:any;
  vi.stubGlobal('fetch',vi.fn(async(_url:any,o:any)=>{if(o?.method==='POST'){sent=JSON.parse(o.body);return Response.json({id:'task_nsfw_objects'});}return Response.json({id:'task_nsfw_objects',status:'completed',metadata:{url:'https://media.invalid/result.mp4'}});}));
  await(await post(endpoint,{...nsfwBody,resolution:undefined,size:'1080P',reference_videos:[{url:'https://example.com/reference.mp4',duration:0.001}],audio_urls:undefined,reference_audios:[{url:'https://example.com/voice.wav'}]})).text();
  await vi.waitFor(()=>expect(row().status).toBe('completed'));
  expect(sent).toMatchObject({size:'1080P',seconds:'10',reference_videos:[{url:expect.any(String)}],reference_audios:[{url:expect.any(String)}]});
  expect(row().cost).toBeCloseTo(15.1);expect(endpoint.startsWith('/v1')?tokenWallet():wallet()).toBeCloseTo(84.9);
});

it.each([false,true])('NSFW managed=%s: unlimited Token refunds both original wallet and used quota once',async spec=>{
  setupNsfw(spec,true);
  vi.stubGlobal('fetch',vi.fn(async(_url:any,o:any)=>o?.method==='POST'?Response.json({id:'task_nsfw_unlimited'}):Response.json({id:'task_nsfw_unlimited',status:'failed',error:{message:'confirmed failure'}})));
  await(await post('/v1/videos',nsfwBody)).text();await vi.waitFor(()=>expect(row().status).toBe('failed'));
  expect(wallet()).toBe(100);expect(tokenWallet()).toBe(-1);expect(db.select().from(apiTokens).get()!.usedAmount).toBe(0);
  video.resumeAllPendingVideoTasks();resumeSpecificationTasks();expect(wallet()).toBe(100);
});

it.each([false,true])('NSFW managed=%s: batch validation includes probed reference seconds but never creates a reservation',async spec=>{
  setupNsfw(spec);vi.stubGlobal('fetch',vi.fn());
  const response=await post('/api/video/validate',nsfwBody);expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({unitCost:15.1});expect(fetch).not.toHaveBeenCalled();
  expect(wallet()).toBe(100);expect(db.select().from(contents).all()).toHaveLength(0);
});

it.each(['/v1/videos', '/api/video/generate'])('%s: audio probing failure rejects before any debit or POST', async endpoint => {
  probes.audio.mockRejectedValue(new Error('probe unavailable'));
  vi.stubGlobal('fetch', vi.fn());
  const response = await post(endpoint, { ...body, audio_urls: ['https://example.com/ref.wav'] });
  expect(response.status).toBe(400);
  expect(await response.text()).toContain('probe unavailable');
  expect(wallet()).toBe(100); expect(tokenWallet()).toBe(100);
  expect(fetch).not.toHaveBeenCalled(); expect(db.select().from(contents).all()).toHaveLength(0);
});

it.each(['/v1/videos', '/api/video/generate'])('%s: audio over the duration limit is rejected without a charge', async endpoint => {
  probes.audio.mockResolvedValue({ rawDurations: [15.01], durations: [15.1], total: 15.1 });
  vi.stubGlobal('fetch', vi.fn());
  const response = await post(endpoint, { ...body, audio_urls: ['https://example.com/ref.wav'] });
  expect(response.status).toBe(400); await response.text();
  expect(wallet()).toBe(100); expect(tokenWallet()).toBe(100); expect(fetch).not.toHaveBeenCalled();
});

it.each(['/v1/videos', '/api/video/generate'])('%s: forwards smart-duration and input media; audio is validated but not billed', async endpoint => {
  const standard = 'wan3.0-video-nsfw';
  db.update(channels).set({ supportedModels: JSON.stringify([standard]) }).run();
  db.update(models).set({ modelId: standard }).run();
  db.update(modelPricing).set({ modelPattern: standard, billingType: 'per_second', inputPrice: 1 }).run();
  let sent: any;
  const upstream = vi.fn(async (_url: any, options: any) => {
    if (options?.method === 'POST') { sent = JSON.parse(options.body); return Response.json({ id: 'task_smart' }); }
    return Response.json({ id: 'task_smart', status: 'completed', metadata: { url: 'https://media.invalid/result.mp4' } });
  });
  vi.stubGlobal('fetch', upstream);
  await (await post(endpoint, { model: standard, prompt: 'smart test', resolution: '720p', aspect_ratio: '16:9',
    parameters: { duration: -1, prompt_extend: false }, reference_videos: ['https://example.com/ref.mp4'],
    audio_urls: ['https://example.com/ref.wav'], input: { media: [{ type: 'link', url: 'https://example.com/article' }] } })).text();
  await vi.waitFor(() => expect(row().status).toBe('completed'));
  expect(sent).toMatchObject({ parameters: { duration: -1, prompt_extend: false },
    input: { media: [{ type: 'link', url: 'https://example.com/article' }] } });
  expect(sent).not.toHaveProperty('seconds');
  expect(meta()).toMatchObject({ referenceVideoSeconds: 5.1, referenceAudioSeconds: 3.1, billableSeconds: 10.2 });
  expect(row().cost).toBeCloseTo(10.2);
  expect(endpoint.startsWith('/v1') ? tokenWallet() : wallet()).toBeCloseTo(89.8);
  expect(upstream.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1);
});

it.each([
  ['/v1/videos', 12], ['/api/video/generate', 12],
  ['/v1/videos', 18], ['/api/video/generate', 18],
] as const)('%s: settles explicit upstream billable seconds %s once using the submitted price snapshot', async (endpoint, actualSeconds) => {
  db.update(modelPricing).set({ billingType: 'per_second', inputPrice: 1 }).run();
  const upstream = vi.fn(async (_url: any, options: any) => {
    if (options?.method === 'POST') {
      db.update(modelPricing).set({ inputPrice: 10 }).run();
      return Response.json({ id: 'task_actual' });
    }
    return Response.json({ id: 'task_actual', status: 'completed',
      usage: { billable_seconds: actualSeconds }, metadata: { url: 'https://media.invalid/result.mp4' } });
  });
  vi.stubGlobal('fetch', upstream);
  await (await post(endpoint, body)).text();
  await vi.waitFor(() => expect(row().status).toBe('completed'));
  expect(row().cost).toBe(actualSeconds);
  expect(endpoint.startsWith('/v1') ? tokenWallet() : wallet()).toBeCloseTo(100 - actualSeconds);
  if (endpoint.startsWith('/v1')) expect(db.select().from(apiTokens).get()!.usedAmount).toBeCloseTo(actualSeconds);
  await video.resumePollForTask(row().id, row());
  expect(endpoint.startsWith('/v1') ? tokenWallet() : wallet()).toBeCloseTo(100 - actualSeconds);
  expect(upstream.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1);
});

it.each([
  ['legacy API','/v1/videos',false], ['legacy website','/api/video/generate',false],
  ['managed API','/v1/videos',true], ['managed website','/api/video/generate',true],
] as const)('%s: concurrent detail/status/recovery reads cannot fail or refund before the delayed ID', async (_name, endpoint, spec) => {
  if (spec) managed();
  const started = deferred<void>(), reply = deferred<Response>();
  const upstream = vi.fn(async (_url: any, options: any) => {
    if (options?.method === 'POST') { started.resolve(); return reply.promise; }
    return Response.json({ id: 'task_race', status: 'completed', metadata: { url: 'https://media.invalid/result.mp4' } });
  });
  vi.stubGlobal('fetch', upstream);
  const responsePromise = post(endpoint, body);
  await started.promise;
  const id = row().id, stale = { ...row(), metadata: '{}' };
  const chargedWallet = wallet(), chargedToken = tokenWallet();
  const charges = sqlite.prepare("SELECT content_id FROM fund_ledger WHERE kind='charge'").all() as any[];
  expect(charges.length).toBeGreaterThan(0); expect(charges.every(r => r.content_id === id)).toBe(true);
  for (let i = 0; i < 3; i++) {
    await Promise.all([
      nativeFetch(origin + '/v1/videos/task_' + id, { headers: { Authorization: 'Bearer ' + tokenKey } }).then(r => r.text()),
      nativeFetch(origin + '/api/contents/' + id).then(r => r.text()),
      video.resumePollForTask(id, stale), ContentRecoveryService.inspect(id).catch(() => undefined),
    ]);
    video.resumeAllPendingVideoTasks(); resumeSpecificationTasks();
  }
  expect(row().status).toBe('processing'); expect(meta().videoSubmissionState).toBe('submitting');
  expect(meta().queueRefunded).not.toBe(true); expect(wallet()).toBe(chargedWallet); expect(tokenWallet()).toBe(chargedToken);
  expect(upstream.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  expect(() => claimVideoSubmission(id)).toThrow('禁止重复提交');
  reply.resolve(Response.json({ id: 'task_race', request_id: 'trace_not_a_task', status: 'queued' }));
  await (await responsePromise).text();
  await vi.waitFor(() => expect(row().status).toBe('completed'));
  expect(meta().videoId).toBe('task_race'); expect(findVideoSubmissionReceipt(id)?.upstreamTaskId).toBe('task_race');
  expect(wallet()).toBe(chargedWallet); expect(tokenWallet()).toBe(chargedToken);
  expect(endpoint.startsWith('/v1') ? chargedToken : chargedWallet).toBeCloseTo(96.1);
  await video.resumePollForTask(id, stale); video.resumeAllPendingVideoTasks();
  expect(upstream.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});

it.each([
  ['/v1/videos', false], ['/api/video/generate', false], ['/v1/videos', true], ['/api/video/generate', true],
] as const)('%s managed=%s: a lost create response holds funds and never replays POST', async (endpoint, spec) => {
  if (spec) managed();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('socket closed after upstream accepted'); }));
  const responseText = await (await post(endpoint, body)).text();
  if (endpoint.startsWith('/api/')) expect(responseText).not.toContain('"type":"error"');
  const id = row().id;
  expect(['review','processing']).toContain(row().status); expect(meta().requiresReview).toBe(true);
  const before = [wallet(), tokenWallet()];
  await video.resumePollForTask(id, row()); video.resumeAllPendingVideoTasks();
  expect([wallet(), tokenWallet()]).toEqual(before); expect(fetch).toHaveBeenCalledOnce();
  expect(meta().queueRefunded).not.toBe(true);
});

it.each([false, true])('website managed=%s: closing the browser while submitting does not cancel, refund or replay the paid job', async spec => {
  if (spec) managed();
  const started = deferred<void>(), reply = deferred<Response>();
  const upstream = vi.fn(async (_url: any, options: any) => {
    if (options?.method === 'POST') { started.resolve(); return reply.promise; }
    return Response.json({ id: 'task_disconnected', status: 'completed', metadata: { url: 'https://media.invalid/result.mp4' } });
  });
  vi.stubGlobal('fetch', upstream);
  const responsePromise = post('/api/video/generate', body);
  await started.promise;
  const response = await responsePromise;
  await response.body!.cancel();
  video.resumeAllPendingVideoTasks();
  expect(row().status).toBe('processing'); expect(wallet()).toBeCloseTo(96.1);
  reply.resolve(Response.json({ id: 'task_disconnected' }));
  await vi.waitFor(() => expect(row().status).toBe('completed'));
  expect(wallet()).toBeCloseTo(96.1); expect(upstream.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1);
});

it.each([
  ['/v1/videos', false], ['/api/video/generate', false], ['/v1/videos', true], ['/api/video/generate', true],
] as const)('%s managed=%s: temporary 404/503 queries do not refund or create another video', async (endpoint, spec) => {
  if (spec) managed();
  let polls = 0;
  const upstream = vi.fn(async (_url: any, options: any) => {
    if (options?.method === 'POST') return Response.json({ id: 'task_query_retry', request_id: 'trace_only' });
    polls++;
    if (polls < 8) {
      expect(row().status).toBe('processing'); expect(meta().queueRefunded).not.toBe(true);
      return Response.json({ message: 'temporarily unavailable' }, { status: polls === 1 ? 404 : 503 });
    }
    return Response.json({ id: 'task_query_retry', status: 'completed', metadata: { url: 'https://media.invalid/result.mp4' } });
  });
  vi.stubGlobal('fetch', upstream);
  await (await post(endpoint, body)).text();
  await vi.waitFor(() => expect(row().status).toBe('completed'));
  expect(polls).toBe(8); expect(upstream.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1);
  expect(endpoint.startsWith('/v1') ? tokenWallet() : wallet()).toBeCloseTo(96.1);
});

it.each([
  ['/v1/videos', false], ['/api/video/generate', false], ['/v1/videos', true], ['/api/video/generate', true],
] as const)('%s managed=%s: confirmed upstream failure refunds once; late duplicate failure does not refund again', async (endpoint, spec) => {
  if (spec) managed();
  vi.stubGlobal('fetch', vi.fn(async (_url: any, options: any) => Response.json(options?.method === 'POST'
    ? { id: 'task_confirmed_failure' } : { id: 'task_confirmed_failure', status: 'failed', message: 'confirmed failure' })));
  await (await post(endpoint, body)).text();
  await vi.waitFor(() => expect(row().status).toBe('failed'));
  expect(wallet()).toBe(100); expect(tokenWallet()).toBe(100);
  const refunds = sqlite.prepare("SELECT content_id FROM fund_ledger WHERE kind='refund'").all() as any[];
  expect(refunds.length).toBeGreaterThan(0); expect(refunds.every(r => r.content_id === row().id)).toBe(true);
  await Promise.all([video.failHmQueuedVideo(row().id, new Error('late failure'), true), video.failHmQueuedVideo(row().id, new Error('late failure'), true)]);
  expect(wallet()).toBe(100); expect(tokenWallet()).toBe(100);
});

it.each([
  ['/v1/videos', false], ['/api/video/generate', false], ['/v1/videos', true], ['/api/video/generate', true],
] as const)('%s managed=%s: a 503 create response is uncertain, without refund or automatic fallback POST', async (endpoint, spec) => {
  if (spec) managed();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'service unavailable' }, { status: 503 })));
  await (await post(endpoint, body)).text();
  await vi.waitFor(() => expect(meta().requiresReview).toBe(true));
  expect(endpoint.startsWith('/v1') ? tokenWallet() : wallet()).toBeCloseTo(96.1);
  expect(meta().queueRefunded).not.toBe(true); expect(fetch).toHaveBeenCalledOnce();
  video.resumeAllPendingVideoTasks(); resumeSpecificationTasks();
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([
  ['/v1/videos', false], ['/api/video/generate', false], ['/v1/videos', true], ['/api/video/generate', true],
] as const)('%s managed=%s: explicit no-channel rejection refunds once, including repeated recovery reads', async (endpoint, spec) => {
  const grok = 'grok-imagine-video-1.5';
  db.update(channels).set({ supportedModels: JSON.stringify([grok]) }).run();
  db.update(models).set({ modelId: grok }).run();
  db.update(modelPricing).set({ modelPattern: grok }).run();
  if (spec) managed(grok);
  const rejection = { error: { message: 'No available channel for model grok-imagine-video-1.5（按次） under group default (distributor) (request id: trace_123)' }, request_id: 'trace_123' };
  for (const status of [500, 503, 200]) {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(rejection, { status })));
    await (await post(endpoint, { ...body, model: grok })).text();
    await vi.waitFor(() => expect(row().status).toBe('failed'));
    expect(wallet()).toBe(100); expect(tokenWallet()).toBe(100);
    expect(db.select().from(apiTokens).get()!.usedAmount).toBe(0);
    const id = row().id;
    const refundsBefore = sqlite.prepare("SELECT COUNT(*) n FROM fund_ledger WHERE kind='refund' AND content_id=?").get(id);
    expect((refundsBefore as any).n).toBeGreaterThan(0);
    await Promise.all([video.failHmQueuedVideo(id, new Error('duplicate rejection'), true),
      video.failHmQueuedVideo(id, new Error('duplicate rejection'), true), video.resumePollForTask(id, row()),
      nativeFetch(origin + '/api/contents/' + id).then(r => r.text()),
      nativeFetch(origin + '/v1/videos/task_' + id, { headers: { Authorization: 'Bearer ' + tokenKey } }).then(r => r.text())]);
    video.resumeAllPendingVideoTasks(); resumeSpecificationTasks();
    expect(wallet()).toBe(100); expect(tokenWallet()).toBe(100);
    expect(db.select().from(apiTokens).get()!.usedAmount).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM fund_ledger WHERE kind='refund' AND content_id=?").get(id)).toEqual(refundsBefore);
    expect(fetch).toHaveBeenCalledOnce();
  }
});

it.each([
  ['/v1/videos', false], ['/v1/videos', true],
] as const)('%s managed=%s: no-channel refunds unlimited Token usage and personal balance only once', async (endpoint, spec) => {
  if (spec) managed();
  db.update(apiTokens).set({ balance: -1 }).where(eq(apiTokens.id, tokenId)).run();
  vi.stubGlobal('fetch', vi.fn(async () => {
    expect(wallet()).toBeCloseTo(96.1);
    expect(db.select().from(apiTokens).get()!.usedAmount).toBeCloseTo(3.9);
    return Response.json({ error: { message: 'No available channel for model wan3.0-video-nsfw under group default (distributor)' } }, { status: 503 });
  }));
  await (await post(endpoint, body)).text();
  await vi.waitFor(() => expect(row().status).toBe('failed'));
  expect(wallet()).toBe(100); expect(db.select().from(apiTokens).get()!.usedAmount).toBe(0);
  const refunds = sqlite.prepare("SELECT id FROM fund_ledger WHERE kind='refund'").all();
  expect(refunds).toHaveLength(2);
  await Promise.all([video.failHmQueuedVideo(row().id, new Error('duplicate'), true), video.failHmQueuedVideo(row().id, new Error('duplicate'), true)]);
  expect(wallet()).toBe(100); expect(db.select().from(apiTokens).get()!.usedAmount).toBe(0);
  expect(sqlite.prepare("SELECT id FROM fund_ledger WHERE kind='refund'").all()).toEqual(refunds);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([
  ['/v1/videos', false], ['/api/video/generate', false], ['/v1/videos', true], ['/api/video/generate', true],
] as const)('%s managed=%s: no-channel wording does not bypass uncertain-response protection', async (endpoint, spec) => {
  if (spec) managed();
  const message = 'No available channel for model wan3.0-video-nsfw under group default (distributor)';
  for (const scenario of [
    () => Response.json({ error: { message }, task_id: 'task_known' }, { status: 503 }),
    () => Response.json({ error: { message } }, { status: 503, headers: { 'x-task-id': 'task_known' } }),
    () => Response.json({ error: { message } }, { status: 504 }),
    () => new Response(JSON.stringify({ error: { message } }).slice(0, -1), { status: 500 }),
    () => { throw new DOMException('response deadline exceeded', 'TimeoutError'); },
  ]) {
    vi.stubGlobal('fetch', vi.fn(async () => scenario()));
    const before = endpoint.startsWith('/v1') ? tokenWallet() : wallet();
    await (await post(endpoint, body)).text();
    await vi.waitFor(() => expect(meta().requiresReview).toBe(true));
    expect(endpoint.startsWith('/v1') ? tokenWallet() : wallet()).toBeCloseTo(before - 3.9);
    expect(meta().queueRefunded).not.toBe(true);
    const id = row().id;
    await video.resumePollForTask(id, row()); video.resumeAllPendingVideoTasks(); resumeSpecificationTasks();
    expect(endpoint.startsWith('/v1') ? tokenWallet() : wallet()).toBeCloseTo(before - 3.9);
    expect(sqlite.prepare("SELECT id FROM fund_ledger WHERE kind='refund' AND content_id=?").all(id)).toHaveLength(0);
    expect(fetch).toHaveBeenCalledOnce();
  }
});

it.each([
  ['/v1/videos', false], ['/api/video/generate', false], ['/v1/videos', true], ['/api/video/generate', true],
] as const)('%s managed=%s: diagnostic request IDs do not turn clear rejections into review', async (endpoint, spec) => {
  if (spec) managed();
  for (const status of [400, 401, 402, 403, 422, 429, 200]) {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ request_id: 'diagnostic_trace', error: { message: 'invalid parameter or unauthorized' } }, { status })));
    await (await post(endpoint, body)).text();
    await vi.waitFor(() => expect(row().status).toBe('failed'));
    expect(wallet()).toBe(100); expect(tokenWallet()).toBe(100);
    expect(db.select().from(apiTokens).get()!.usedAmount).toBe(0);
    const id = row().id;
    const before = sqlite.prepare("SELECT id FROM fund_ledger WHERE kind='refund' AND content_id=?").all(id);
    await Promise.all([video.failHmQueuedVideo(id, new Error('duplicate'), true), video.failHmQueuedVideo(id, new Error('duplicate'), true)]);
    expect(sqlite.prepare("SELECT id FROM fund_ledger WHERE kind='refund' AND content_id=?").all(id)).toEqual(before);
    expect(wallet()).toBe(100); expect(tokenWallet()).toBe(100); expect(fetch).toHaveBeenCalledOnce();
  }
});

it.each([
  ['/v1/videos', false], ['/api/video/generate', false], ['/v1/videos', true], ['/api/video/generate', true],
] as const)('%s managed=%s: local payload failure before POST fails and refunds, not review', async (endpoint, spec) => {
  if (spec) managed();
  vi.spyOn(snumomAdapter, 'buildSnumomWanPayload').mockImplementation(() => { throw new Error('local payload construction failed'); });
  vi.stubGlobal('fetch', vi.fn());
  await (await post(endpoint, body)).text();
  await vi.waitFor(() => expect(row().status).toBe('failed'));
  expect(wallet()).toBe(100); expect(tokenWallet()).toBe(100); expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ['/v1/videos', false], ['/api/video/generate', false], ['/v1/videos', true], ['/api/video/generate', true],
] as const)('%s managed=%s: a proven connection-not-established error refunds, unlike a socket disconnect', async (endpoint, spec) => {
  if (spec) managed();
  vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }));
  await (await post(endpoint, body)).text();
  await vi.waitFor(() => expect(row().status).toBe('failed'));
  expect(wallet()).toBe(100); expect(tokenWallet()).toBe(100); expect(fetch).toHaveBeenCalledOnce();
});

it.each([
  ['/v1/videos', false], ['/api/video/generate', false], ['/v1/videos', true], ['/api/video/generate', true],
] as const)('%s managed=%s: refund write failure rolls back funds, is settlement review, then refunds once after repair', async (endpoint, spec) => {
  if (spec) managed();
  sqlite.exec(`CREATE TRIGGER block_wallet_refund BEFORE UPDATE ON users WHEN NEW.balance > OLD.balance BEGIN SELECT RAISE(ABORT,'refund temporarily unavailable'); END;
    CREATE TRIGGER block_token_refund BEFORE UPDATE ON api_tokens WHEN NEW.balance > OLD.balance BEGIN SELECT RAISE(ABORT,'refund temporarily unavailable'); END;`);
  try {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'invalid parameter' }, request_id: 'trace_only' }, { status: 400 })));
    await (await post(endpoint, body)).text();
    await vi.waitFor(() => expect(meta().reviewKind).toBe('settlement'));
    expect(meta()).toMatchObject({ upstreamStatus: 'failed', requiresReview: true });
    expect(endpoint.startsWith('/v1') ? tokenWallet() : wallet()).toBeCloseTo(96.1);
    expect(sqlite.prepare("SELECT id FROM fund_ledger WHERE kind='refund' AND content_id=?").all(row().id)).toHaveLength(0);
    video.resumeAllPendingVideoTasks(); resumeSpecificationTasks();
    expect(fetch).toHaveBeenCalledOnce();
  } finally { sqlite.exec('DROP TRIGGER block_wallet_refund; DROP TRIGGER block_token_refund;'); }
  // Replay the existing confirmed-failure finalizer, not a new paid submission.
  if (!spec) {
    await Promise.all([video.failHmQueuedVideo(row().id, new Error('confirmed rejection'), true), video.failHmQueuedVideo(row().id, new Error('duplicate rejection'), true)]);
    expect(wallet()).toBe(100); expect(tokenWallet()).toBe(100);
    expect(db.select().from(apiTokens).get()!.usedAmount).toBe(0);
  }
});

it.each(['/v1/videos', '/api/video/generate'])('%s managed: generated result is retained and settlement failure never replays POST', async endpoint => {
  managed();
  ensureBillingReservations();
  sqlite.exec("CREATE TRIGGER block_settle BEFORE UPDATE ON billing_reservations WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'settlement unavailable'); END");
  try {
    vi.stubGlobal('fetch', vi.fn(async (_url: any, options: any) => Response.json(options?.method === 'POST'
      ? { id: 'task_billing_review' } : { id: 'task_billing_review', status: 'completed', metadata: { url: 'https://media.invalid/result.mp4' } })));
    await (await post(endpoint, body)).text();
    await vi.waitFor(() => expect(meta().reviewKind).toBe('settlement'));
    expect(row().resultUrl).toBe('/uploads/concurrency-test.mp4');
    expect(meta()).toMatchObject({ upstreamStatus: 'completed', requiresReview: true });
    const before = [wallet(), tokenWallet()];
    resumeSpecificationTasks(); await video.resumePollForTask(row().id, row());
    expect([wallet(), tokenWallet()]).toEqual(before);
    expect((fetch as any).mock.calls.filter(([, o]: any) => o?.method === 'POST')).toHaveLength(1);
  } finally { sqlite.exec('DROP TRIGGER block_settle'); }
});

it('API exposes settlement review separately from generation and does not re-debit on query', async () => {
  db.update(apiTokens).set({ balance: 1, usedAmount: 3.9 }).where(eq(apiTokens.id, tokenId)).run();
  const id = Number(db.insert(contents).values({ userId: 1, type: 'video', modelId: model, status: 'processing', cost: 3.9,
    metadata: JSON.stringify({ source: 'api', tokenId, billingSource: 'token', channelId: 1, videoId: 'task_settlement' }) }).run().lastInsertRowid);
  settleDirectVideoBilling(id, 8, {}, '/uploads/settlement.mp4');
  expect(meta()).toMatchObject({ reviewKind: 'settlement', requiresReview: true });
  vi.stubGlobal('fetch', vi.fn());
  const response = await nativeFetch(origin + '/v1/videos/task_' + id, { headers: { Authorization: 'Bearer ' + tokenKey } });
  const data = await response.json();
  expect(data).toMatchObject({ review_kind: 'settlement', billing_status: 'review', generation_status: 'completed' });
  expect(data.message).toContain('费用结算待核实');
  expect(tokenWallet()).toBe(1); expect(db.select().from(apiTokens).get()!.usedAmount).toBe(3.9);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ['/v1/videos', false], ['/api/video/generate', false], ['/v1/videos', true], ['/api/video/generate', true],
] as const)('%s managed=%s: HTTP 200 lookup error is not a failed generation', async (endpoint, spec) => {
  if (spec) managed();
  let polls = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: any, options: any) => {
    if (options?.method === 'POST') return Response.json({ id: 'task_lookup_error' });
    if (++polls < 3) return Response.json({ id: 'task_lookup_error', status: 'error', error: { code: 'task_not_found', message: 'lookup unavailable' } });
    expect(endpoint.startsWith('/v1') ? tokenWallet() : wallet()).toBeCloseTo(96.1);
    return Response.json({ id: 'task_lookup_error', status: 'completed', metadata: { url: 'https://media.invalid/result.mp4' } });
  }));
  await (await post(endpoint, body)).text();
  await vi.waitFor(() => expect(row().status).toBe('completed'));
  expect(polls).toBe(3);
  expect(endpoint.startsWith('/v1') ? tokenWallet() : wallet()).toBeCloseTo(96.1);
  expect((fetch as any).mock.calls.filter(([, o]: any) => o?.method === 'POST')).toHaveLength(1);
});

it.each([
  ['/v1/videos', false], ['/api/video/generate', false], ['/v1/videos', true], ['/api/video/generate', true],
] as const)('%s managed=%s: real task evidence in a 4xx rejection envelope still protects the precharge', async (endpoint, spec) => {
  if (spec) managed();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ task_id: 'task_maybe_started', request_id: 'trace_only', error: { message: 'invalid parameter' } }, { status: 400 })));
  await (await post(endpoint, body)).text();
  await vi.waitFor(() => expect(meta().requiresReview).toBe(true));
  expect(endpoint.startsWith('/v1') ? tokenWallet() : wallet()).toBeCloseTo(96.1);
  expect(sqlite.prepare("SELECT id FROM fund_ledger WHERE kind='refund'").all()).toHaveLength(0);
  video.resumeAllPendingVideoTasks(); resumeSpecificationTasks(); expect(fetch).toHaveBeenCalledOnce();
});

it('after a process interruption the durable submit marker blocks resubmission; expiry only permits review', async () => {
  const id = Number(db.insert(contents).values({ userId: 1, type: 'video', modelId: model, status: 'processing', cost: 3.9, metadata: '{"channelId":1}' }).run().lastInsertRowid);
  claimVideoSubmission(id); releaseVideoSubmission(id);
  vi.stubGlobal('fetch', vi.fn());
  await video.resumePollForTask(id, row());
  expect(row().status).toBe('processing');
  const m = meta(); m.videoSubmissionDeadline = Date.now() - 1;
  sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?').run(JSON.stringify(m), id);
  await video.resumePollForTask(id, row());
  expect(row().status).toBe('review'); expect(wallet()).toBe(100); expect(fetch).not.toHaveBeenCalled();
  expect(() => claimVideoSubmission(id)).toThrow('禁止重复提交');
  endVideoSubmission(id, 'unknown');
});

it.each([
  ['/v1/videos', false], ['/api/video/generate', false], ['/v1/videos', true], ['/api/video/generate', true],
] as const)('%s managed=%s: a confirmed 400 rejection refunds exactly once', async (endpoint, spec) => {
  if (spec) managed();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'invalid parameter' }, { status: 400 })));
  await (await post(endpoint, body)).text();
  await vi.waitFor(() => expect(row().status).toBe('failed'));
  expect(wallet()).toBe(100); expect(tokenWallet()).toBe(100); expect(fetch).toHaveBeenCalledOnce();
  await video.failHmQueuedVideo(row().id, new Error('duplicate rejection'), true);
  expect(wallet()).toBe(100); expect(tokenWallet()).toBe(100);
});

it.each([
  ['/v1/videos', false], ['/api/video/generate', false], ['/v1/videos', true], ['/api/video/generate', true],
] as const)('%s managed=%s: unreadable accepted JSON holds the reservation without any replay', async (endpoint, spec) => {
  if (spec) managed();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"id":"task_truncated', { status: 202 })));
  await (await post(endpoint, body)).text();
  await vi.waitFor(() => expect(meta().requiresReview).toBe(true));
  expect(meta().videoSubmissionState).toBe('unknown');
  expect(endpoint.startsWith('/v1') ? tokenWallet() : wallet()).toBeCloseTo(96.1);
  expect(fetch).toHaveBeenCalledOnce();
  video.resumeAllPendingVideoTasks(); resumeSpecificationTasks();
  expect(fetch).toHaveBeenCalledOnce(); expect(meta().queueRefunded).not.toBe(true);
});
