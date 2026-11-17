import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../server/db/index.js';
import { apiTokens, contents, modelPricing, models, tiers, tierModelAccess, users } from '../server/db/schema.js';
import { env } from '../server/config/env.js';
import channelRoutes from '../server/routes/channels.js';
import apiRoutes from '../server/routes/v1.js';
import videoRoutes from '../server/routes/video.js';
import { batchStore, tickVideoBatches } from '../server/services/videoBatchService.js';
import { handleSpecificationGeneration, resumeSpecificationTasks } from '../server/services/specificationGenerationService.js';
import { WANFENG_BASE_URL, wanfengVideoLimits } from '../shared/wanfengVideo.js';

vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/services/videoLocalizationService.js', () => ({
  downloadAndLocalizeVideo: vi.fn(async () => '/uploads/wanfeng-result.mp4'),
}));

const localFetch = globalThis.fetch;
const modelId = 'seedance-configured-test';
const draft = {
  modelId, displayName: 'Seedance 测试', kind: 'video', upstreamModel: 'sd2.5', limits: wanfengVideoLimits('sd2.5'),
};
const distributorMessage = 'No available channel for model ' + draft.upstreamModel
  + ' under group default: the model is claimed by a task plugin, which has no enabled channel serving it (distributor)';
const input = { model: modelId, prompt: '海浪冲向礁石', seconds: 5, aspect_ratio: '16:9', resolution: '720p' };
let server: import('node:http').Server;
let origin: string;
let userId: number;
let userAuth: string;
let configUrl: string;

function addUser(username: string, role: string) {
  const id = Number(db.insert(users).values({ username, email: username + '@example.test', role, passwordHash: 'unused', balance: 100 }).run().lastInsertRowid);
  return { id, auth: 'Bearer ' + jwt.sign({ userId: id, role }, env.JWT_SECRET) };
}
const post = (path: string, authorization: string, body: unknown, method = 'POST') => localFetch(origin + path, {
  method, headers: { 'Content-Type': 'application/json', Authorization: authorization }, body: JSON.stringify(body),
});
const last = () => db.select().from(contents).where(eq(contents.modelId, modelId)).all().at(-1)!;
const balance = () => db.select().from(users).where(eq(users.id, userId)).get()!.balance;

beforeAll(async () => {
  const tierId = Number(db.insert(tiers).values({ name: 'free', displayName: 'Test', allowedFeatures: '["video"]', dailyQuota: -1 }).run().lastInsertRowid);
  const admin = addUser('wanfeng-admin', 'super_admin');
  ({ id: userId, auth: userAuth } = addUser('wanfeng-user', 'user'));
  const app = express();
  app.use(express.json());
  app.use('/api/admin/channels', channelRoutes);
  app.use('/api/video', videoRoutes);
  app.use('/v1', apiRoutes);
  server = await new Promise<import('node:http').Server>(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  origin = 'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port;
  const created = await post('/api/admin/channels', admin.auth, { type: 'wanfeng', name: '晚风', apiKey: 'upstream-test-key' });
  expect(created.ok, await created.clone().text()).toBe(true);
  const response = await created.json() as any;
  configUrl = '/api/admin/channels/' + (response.id ?? response.channelId) + '/model-configurations';
  const initial = await localFetch(origin + configUrl, { headers: { Authorization: admin.auth } });
  expect(initial.ok, await initial.clone().text()).toBe(true);
  const config = await initial.json() as any;
  expect(config).toMatchObject({ protocol: 'wanfeng', canAdd: true, models: [] });
  const unsupported = await post(configUrl, admin.auth, { version: config.version,
    draft: { ...draft, upstreamModel: 'sd2.5-flash' } }, 'PUT');
  expect(unsupported.status).toBe(400);
  const preview = await post(configUrl + '/preview', admin.auth, { draft, sample: { seconds: 5, videos: 1 } });
  expect(await preview.json()).toMatchObject({ path: '/v1/videos', body: { model: 'sd2.5', duration: 5, videos: [expect.any(String)] } });
  const saved = await post(configUrl, admin.auth, { version: config.version, draft }, 'PUT');
  expect(saved.ok, await saved.clone().text()).toBe(true);
  expect(await saved.json()).toMatchObject({ models: [{ modelId, upstreamModel: 'sd2.5', enabled: false }] });
  const enabled = db.update(models).set({ isActive: 1 }).where(eq(models.modelId, modelId)).returning().get();
  db.insert(tierModelAccess).values({ tierId, modelId: enabled.id }).run();
  db.insert(modelPricing).values({ modelPattern: modelId, billingType: 'per_call', inputPrice: 2 }).run();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
afterAll(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  sqlite.close();
});

it('submits the mapped video from the website and preserves the creation identifier', async () => {
  const before = balance();
  let receiptAtQuery: unknown;
  const upstream = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ id: 'task_web', task_id: 'task_web', status: 'queued' });
    receiptAtQuery = JSON.parse(last().metadata);
    return Response.json({ id: 'task_web', task_id: 'vid_internal', status: 'completed' });
  });
  vi.stubGlobal('fetch', upstream);
  const result = await post('/api/video/generate', userAuth, { ...input, model_parameters: { generate_audio: false } });
  expect(result.ok, await result.clone().text()).toBe(true);
  await result.text();
  expect(last()).toMatchObject({ status: 'completed', cost: 2 });
  expect(JSON.parse(last().metadata).upstreamResultUrl).toBe(WANFENG_BASE_URL + '/v1/videos/task_web/content');
  expect(upstream.mock.calls.map(([url]) => url)).toEqual([WANFENG_BASE_URL + '/v1/videos', WANFENG_BASE_URL + '/v1/videos/task_web']);
  expect(JSON.parse(String(upstream.mock.calls[0][1]?.body))).toMatchObject({ model: 'sd2.5', duration: 5, generateAudio: false });
  expect(receiptAtQuery).toMatchObject({ upstreamTaskId: 'task_web', wanfengReceipt: { id: 'task_web' } });
  expect(balance()).toBe(before - 2);
});

it.each([
  { status: 400, code: 'invalid_request_error', message: 'resolution is not supported by this model' },
  { status: 503, code: 'model_not_found', message: distributorMessage },
])('refunds a rejected API order once and retains the provider error ($code)', async ({ status, code, message }) => {
  const tokenKey = 'sk-wanfeng-api-test-' + status;
  db.insert(apiTokens).values({ userId, name: 'WanFeng API test', tokenKey, balance: 10 }).run();
  const upstream = vi.fn(async () => Response.json({ error: { code, message } }, { status }));
  vi.stubGlobal('fetch', upstream);
  const result = await post('/v1/videos', 'Bearer ' + tokenKey, input);
  expect(result.ok, await result.clone().text()).toBe(true);
  await vi.waitFor(() => expect(last().status).toBe('failed'));
  expect(JSON.parse(last().metadata)).toMatchObject({
    billingStatus: 'refunded', requiresReview: false, error: expect.stringContaining('HTTP ' + status + ' code=' + code),
  });
  resumeSpecificationTasks();
  resumeSpecificationTasks();
  expect(upstream).toHaveBeenCalledOnce();
  expect(db.select().from(apiTokens).where(eq(apiTokens.tokenKey, tokenKey)).get()?.balance).toBe(10);
});

it.each(['disconnect', 'ambiguous-503'])('keeps an uncertain batch reservation without redispatching (%s)', async scenario => {
  const before = balance();
  const previousId = last().id;
  const upstream = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/video/generate')) return localFetch(origin + '/api/video/generate', init);
    expect(url).toBe(WANFENG_BASE_URL + '/v1/videos');
    if (scenario === 'ambiguous-503') {
      return Response.json({ error: { code: 'model_not_found', message: 'upstream status unavailable' } }, { status: 503 });
    }
    throw new Error('connection dropped after submission');
  });
  vi.stubGlobal('fetch', upstream);
  batchStore.create(userId, 'wanfeng-batch-test-' + scenario, {
    name: '晚风测试批次', model: modelId, resolution: '720p', video_length: 5, aspect_ratio: '16:9',
    creatives: [{ prompt: '海浪', count: 1, reference_images: [], reference_videos: [], audio_urls: [] }],
    autoRetry: true, maxRetries: 2,
  }, 2, origin);
  tickVideoBatches();
  await vi.waitFor(() => {
    expect(last().id).not.toBe(previousId);
    expect(last().status).toBe('review');
  });
  resumeSpecificationTasks();
  tickVideoBatches();
  tickVideoBatches();
  expect(last().status).toBe('review');
  expect(upstream.mock.calls.filter(([url]) => url.startsWith(WANFENG_BASE_URL))).toHaveLength(1);
  expect(balance()).toBe(before - 2);
});

it('settles the distributor rejection in the batch ledger once', async () => {
  const before = balance();
  const previousId = last().id;
  const upstream = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/video/generate')) return localFetch(origin + '/api/video/generate', init);
    expect(url).toBe(WANFENG_BASE_URL + '/v1/videos');
    return Response.json({ error: { code: 'model_not_found', message: distributorMessage } }, { status: 503 });
  });
  vi.stubGlobal('fetch', upstream);
  batchStore.create(userId, 'wanfeng-batch-distributor-rejection', {
    name: '晚风测试批次', model: modelId, resolution: '720p', video_length: 5, aspect_ratio: '16:9',
    creatives: [{ prompt: '海浪', count: 1, reference_images: [], reference_videos: [], audio_urls: [] }],
    autoRetry: false, maxRetries: 0,
  }, 2, origin);
  tickVideoBatches();
  await vi.waitFor(() => {
    expect(last().id).not.toBe(previousId);
    expect(last().status).toBe('failed');
  });
  await vi.waitFor(() => {
    tickVideoBatches();
    expect(JSON.parse(last().metadata)).toMatchObject({ billingStatus: 'refunded', batchConfirmedFailure: true });
  });
  resumeSpecificationTasks();
  tickVideoBatches();
  expect(balance()).toBe(before);
  expect(upstream.mock.calls.filter(([url]) => url.startsWith(WANFENG_BASE_URL))).toHaveLength(1);
});

it('resumes an accepted original task after the query window without submitting again', async () => {
  vi.useFakeTimers();
  const before = balance();
  let firstQuery = true;
  const upstream = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ id: 'task_resume', status: 'queued' });
    if (firstQuery) {
      firstQuery = false;
      vi.setSystemTime(Date.now() + 2 * 60 * 60_000 + 1);
      return Response.json({ error: { code: 'maintenance', message: 'query unavailable' } }, { status: 503 });
    }
    return Response.json({ id: 'task_resume', status: 'completed' });
  });
  vi.stubGlobal('fetch', upstream);
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn() };
  const running = handleSpecificationGeneration({ userId, headers: {}, protocol: 'https', get: () => 'site.example',
    body: input } as any, res as any, 'video');
  await vi.advanceTimersByTimeAsync(13_000);
  await running;
  expect(last().status).toBe('processing');
  expect(JSON.parse(last().metadata)).toMatchObject({ videoId: 'task_resume', upstreamQueryError: expect.stringContaining('maintenance') });
  expect(balance()).toBe(before - 2);
  await vi.advanceTimersByTimeAsync(60_001);
  resumeSpecificationTasks();
  resumeSpecificationTasks();
  await vi.waitFor(() => expect(last().status).toBe('completed'));
  expect(upstream.mock.calls.map(([url]) => url)).toEqual([
    WANFENG_BASE_URL + '/v1/videos', WANFENG_BASE_URL + '/v1/videos/task_resume', WANFENG_BASE_URL + '/v1/videos/task_resume',
  ]);
  expect(balance()).toBe(before - 2);
});
