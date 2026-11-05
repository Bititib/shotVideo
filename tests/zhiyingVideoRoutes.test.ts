import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';

vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/services/videoLocalizationService.js', () => ({
  downloadAndLocalizeVideo: vi.fn(async () => '/uploads/videos/zhiying-test.mp4'),
}));
import { db, sqlite } from '../server/db/index.js';
import { apiTokens, contents, models, modelPricing, tiers, users } from '../server/db/schema.js';
import { env } from '../server/config/env.js';
import { ChannelService } from '../server/services/channelService.js';
import { batchStore, tickVideoBatches } from '../server/services/videoBatchService.js';
import videoRouter from '../server/routes/video.js';
import batchRouter from '../server/routes/videoBatches.js';
import apiRouter from '../server/routes/v1.js';
import { privateReferences } from '../server/middleware/privateReferences.js';
import { privateMediaStore } from '../server/routes/media.js';
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService.js';
import { ZHIYING_BASE_URL, ZHIYING_VIDEO_MODELS } from '../shared/zhiyingVideo.js';

const localFetch = globalThis.fetch;
const token = 'sk-zhiying-local-test';
const websiteToken = jwt.sign({ userId: 1, role: 'user' }, env.JWT_SECRET);
const [line1, line2] = ZHIYING_VIDEO_MODELS;
const originalPort = env.PORT;
let server: Server, origin: string;
const created: Array<{ payload: Record<string, any>; key: string | null }> = [];
const uploaded: Buffer[] = [];
let reject: boolean;

function call(path: string, body?: object, key?: string) {
  return localFetch(origin + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + (path.startsWith('/v1/') ? token : websiteToken),
      'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const accountBalance = () => db.select().from(users).get()!.balance;
const tokenBalance = () => db.select().from(apiTokens).get()!.balance;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/video', privateReferences, videoRouter);
  app.use('/api/video-batches', batchRouter);
  app.use('/v1', privateReferences, apiRouter);
  server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  env.PORT = (server.address() as AddressInfo).port;
  origin = 'http://127.0.0.1:' + env.PORT;
});
beforeEach(async () => {
  for (const {name} of sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]) {
    sqlite.exec(`DELETE FROM "${name}"`);
  }
  created.length = 0;
  uploaded.length = 0;
  reject = false;
  db.insert(tiers).values({ id: 1, name: 'test', displayName: 'test', dailyQuota: -1, allowedFeatures: '["video"]' }).run();
  db.insert(users).values({ id: 1, username: 'test', email: 'video@example.test', passwordHash: 'unused', balance: 100 }).run();
  db.insert(apiTokens).values({ id: 1, userId: 1, tokenKey: token, name: 'test', balance: 100 }).run();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const target = new URL(url);
    if (target.origin === origin) return localFetch(url, init);
    if (target.origin !== ZHIYING_BASE_URL) throw new Error('Unexpected test destination: ' + target.origin);
    if (target.pathname === '/v1/models') return Response.json({ data: ZHIYING_VIDEO_MODELS.map(id => ({id, media_type:'video', status:'available'})) });
    if (target.pathname === '/v1/files' && init?.method === 'POST') {
      const file = (init.body as FormData).get('file') as Blob;
      uploaded.push(Buffer.from(await file.arrayBuffer()));
      return Response.json({id:'file_' + uploaded.length}, {status:201});
    }
    if (target.pathname === '/v1/generations' && init?.method === 'POST') {
      const payload = JSON.parse(String(init.body));
      created.push({payload, key: new Headers(init.headers).get('Idempotency-Key')});
      if (reject) return Response.json({ error: { code: 'insufficient_points', message: '测试渠道积分不足', request_id: 'req_balance' } }, {status:402});
      return Response.json({id:'video_task_abcdefghijklmn', object:'video', model:payload.model, status:'succeeded', cost_points:498,
        result_url:'https://cdn.example.test/original.mp4?sig=test'}, {status:202});
    }
    if (target.pathname === '/v1/generations/video_task_abcdefghijklmn') return Response.json({id:'video_task_abcdefghijklmn', object:'video', status:'succeeded', result_url:'https://cdn.example.test/original.mp4?sig=test'});
    throw new Error('Unexpected Zhiying API path: ' + target.pathname);
  }));
  const id = ChannelService.createChannel({name:'test',type:'zhiying',baseUrl:ZHIYING_BASE_URL,apiKey:'upstream-test-only'});
  await ChannelService.syncModels(id);
  db.update(models).set({isActive:1}).run();
  for (const modelPattern of ZHIYING_VIDEO_MODELS) db.insert(modelPricing).values({modelPattern,billingType:'per_call',inputPrice:2,outputPrice:0}).run();
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(async () => {
  env.PORT = originalPort;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  sqlite.close();
});

it.each([[line1, 'Lx-Seedance2.5-1'], [line2, 'Lx-Seedance2.5-2']])('uses the advertised defaults through the website for %s', async (model, name) => {
  const resolution = '720p';
  const catalog = await (await call('/api/video/models')).json() as any[];
  expect(catalog.find(m => m.id === model)).toMatchObject({name,routingLimits:{defaultSeconds:30,resolutions:[resolution]}});
  expect(catalog).not.toContainEqual(expect.objectContaining({id:'SD-特价'}));
  const input = {model, prompt:'有阳光的山谷'};
  const quote = await call('/api/video/validate', input);
  expect(await quote.json()).toMatchObject({valid:true,unitCost:2});
  expect(created).toHaveLength(0);
  expect(accountBalance()).toBe(100);
  const stream = await (await call('/api/video/generate', input)).text();
  expect(stream).toContain('"type":"complete"');
  expect(created).toHaveLength(1);
  expect(created[0].payload).toMatchObject({model, resolution, duration:30, aspect_ratio:'16:9'});
  expect(created[0].key?.length).toBeGreaterThanOrEqual(8);
  expect(accountBalance()).toBe(98);
});
it('checks each dedicated line and rejects unsupported batch assets before reservation', async () => {
  const prompt = '山'.repeat(20001);
  expect((await call('/api/video/validate', {model:line1,prompt})).status).toBe(400);
  expect((await call('/api/video/validate', {model:line2,prompt})).status).toBe(200);
  const batch = {name:'test',model:line1,resolution:'720p',aspect_ratio:'16:9',video_length:30,autoRetry:false,maxRetries:0,
    creatives:[{prompt:'sea',count:1,first_frame:'https://media.example/first.jpg'}]};
  expect((await call('/api/video-batches/quote',batch)).status).toBe(400);
  expect((await call('/v1/videos',{model:line2,prompt:'test',aspect_ratio:'4:3'})).status).toBe(400);
  expect((await call('/v1/videos',{model:'SD-特价',prompt:'test'})).ok).toBe(false);
  expect(created).toHaveLength(0);
  expect(accountBalance()).toBe(100);
  expect(tokenBalance()).toBe(100);
});
it('preserves the external task ID and charges once for repeated submissions', async () => {
  const input = { model:line2, prompt:'test', seconds:7, ratio:'21:9' };
  const first = await (await call('/v1/videos',input,'site-idem-01')).json() as any;
  expect(first.id).toMatch(/^task_req_/);
  await vi.waitFor(() => expect(db.select().from(contents).get()?.status).toBe('completed'));
  const repeat = await call('/v1/videos',input,'site-idem-01');
  expect(repeat.headers.get('X-Idempotency-Replayed')).toBe('true');
  expect(await repeat.json()).toMatchObject({id:first.id,status:'completed'});
  expect(created).toHaveLength(1);
  expect(created[0].payload).toMatchObject({model:line2,duration:7,aspect_ratio:'21:9'});
  expect(tokenBalance()).toBe(98);
});
it('carries a documented rejection through the real batch dispatcher and refunds exactly once', async () => {
  reject = true;
  const batch = {name:'batch', model:line1, aspect_ratio:'4:3', resolution:'720p', video_length:5,autoRetry:true,maxRetries:2,
    creatives:[{prompt:'批量',count:1,reference_images:[],audio_urls:[]}]};
  expect(await (await call('/api/video-batches/quote',batch)).json()).toMatchObject({unitCost:2,total:1});
  expect(created).toHaveLength(0);
  const result = await (await call('/api/video-batches',{...batch, requestKey:'batch-zhiying-0001',expectedUnitCost:2})).json() as any;
  expect(result.items).toHaveLength(1);
  const itemId = result.items[0].id;
  await vi.waitFor(() => {
    tickVideoBatches();
    expect(batchStore.item(itemId)).toMatchObject({status:'failed',billing_state:'refunded',attempts:1});
  });
  tickVideoBatches();
  expect(accountBalance()).toBe(100);
  expect(created).toHaveLength(1);
  const meta = JSON.parse(db.select().from(contents).get()!.metadata);
  expect(meta.error).toContain('测试渠道积分不足');
});

it('keeps private API materials scoped to the token owner, even when no login cookie is present', async () => {
  const store = privateMediaStore();
  const bytes = Buffer.from([137,80,78,71,13,10,26,10,32]);
  const mine = store.put(1, bytes, 'image/png', 'mine.png');
  const theirs = store.put(2, bytes, 'image/png', 'theirs.png');
  try {
    const body = { model: line1, prompt: '傍晚', reference_images: ['/api/media/' + theirs.id] };
    expect((await call('/v1/videos', body)).status).toBe(400);
    expect(uploaded).toHaveLength(0);
    const accepted = await call('/v1/videos', {...body, reference_images: ['/api/media/' + mine.id]});
    expect(accepted.ok).toBe(true);
    await vi.waitFor(() => expect(db.select().from(contents).get()?.status).toBe('completed'));
    expect(uploaded).toEqual([bytes]);
    expect(created[0].payload.reference_images).toEqual(['file_1']);
    expect(tokenBalance()).toBe(98);
  } finally {
    fs.rmSync(store.filePath(mine), {force:true});
    fs.rmSync(store.filePath(theirs), {force:true});
  }
});

it('dispatches every inline batch reference in its original order', async () => {
  const images = [24, 42].map(tail => Buffer.from([137,80,78,71,13,10,26,10,tail]));
  const batch = {name:'图序',model:line2,aspect_ratio:'16:9',resolution:'720p',video_length:7,autoRetry:false,maxRetries:0,
    creatives:[{prompt:'海岸',count:1,reference_images:images.map(b=>'data:image/png;base64,' + b.toString('base64'))}]};
  const quote = await call('/api/video-batches/quote',batch);
  expect(await quote.json()).toMatchObject({unitCost:2});
  expect(uploaded).toHaveLength(0);
  const result = await (await call('/api/video-batches',{...batch,requestKey:'batch-reference-order',expectedUnitCost:2})).json() as any;
  expect(result.items).toHaveLength(1);
  await vi.waitFor(() => {
    tickVideoBatches();
    expect(db.select().from(contents).get()?.status).toBe('completed');
  });
  expect(uploaded).toEqual(images);
  expect(created[0].payload).toMatchObject({duration:7,reference_images:['file_1','file_2']});
  expect(accountBalance()).toBe(98);
});

it('uses the upstream receipt and original credential to recover a missing API download', async () => {
  const result = await (await call('/v1/videos',{model:line2,prompt:'森林'})).json() as any;
  await vi.waitFor(() => expect(db.select().from(contents).get()?.status).toBe('completed'));
  const row = db.select().from(contents).get()!;
  const meta = JSON.parse(row.metadata);
  delete meta.upstreamResultUrl;
  delete meta.zhiyingCompletedReceipt;
  db.update(contents).set({metadata:JSON.stringify(meta)}).where(eq(contents.id,row.id)).run();
  const localize = vi.mocked(downloadAndLocalizeVideo);
  localize.mockClear();
  localize.mockRejectedValueOnce(new Error('test original task refresh'));
  expect((await call('/v1/videos/' + result.id + '/content')).status).toBe(502);
  expect(localize).toHaveBeenCalledWith('', 'video_task_abcdefghijklmn', line2,meta.channelId,meta.channelApiKeyId,undefined,meta.zhiyingCredential);
  expect(created).toHaveLength(1);
  expect(tokenBalance()).toBe(98);
});
