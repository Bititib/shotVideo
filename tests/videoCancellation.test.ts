import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';

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
vi.mock('../server/config/env.js', () => ({ env: { NODE_ENV: 'test', JWT_SECRET: 'test', VIDEO_TASK_POLL_TIMEOUT_MS: 100000 } }));
vi.mock('../server/middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => { req.userId = 1; next(); },
  optionalAuthMiddleware: (_req: any, _res: any, next: any) => next(),
  activeApiKeyMiddleware: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../server/middleware/tier.js', () => ({ tierMiddleware: () => (_req: any, _res: any, next: any) => next() }));
vi.mock('../server/middleware/quota.js', () => ({ quotaMiddleware: (_req: any, _res: any, next: any) => next(), logUsage: vi.fn() }));
vi.mock('../server/services/videoLocalizationService.js', () => ({
  downloadAndLocalizeVideo: vi.fn(async () => '/uploads/cancel-test.mp4'), preferredVideoDownloadPath: (p: string) => p,
}));

import { db, sqlite } from '../server/db/index';
import { users, channels, channelApiKeys, models, modelPricing, contents } from '../server/db/schema';
import { ContentService, sanitizeContentRoutingForClient } from '../server/services/contentService';
import { reserveLegacyVideo } from '../server/services/legacyVideoBilling';
import { claimVideoSubmission, videoSubmissionPreparation } from '../server/services/videoSubmissionGuard';
import { resumeSpecificationTasks } from '../server/services/specificationGenerationService';
import { persistVideoSubmissionReceipt, findVideoSubmissionReceipt } from '../server/services/videoSubmissionReceiptService';
import { hmStudioQueue, hmStudioPoolKey } from '../server/services/hmStudioQueueService';
import { saveModelSpecification } from '../server/services/modelRoutingService';
import { defaultRoutingLimits } from '../shared/modelRouting';

const nativeFetch = globalThis.fetch, nativeTimer = globalThis.setTimeout;
let video: typeof import('../server/routes/video'), server: Server, origin: string;
const model = 'seedance_v2.5';
const row = () => db.select().from(contents).all().at(-1)!;
const wallet = () => db.select().from(users).get()!.balance;
const meta = () => JSON.parse(row().metadata);
const request = (id: number, method = 'POST', suffix = '/cancel') => nativeFetch(`${origin}/api/contents/${id}${suffix}`, { method });
const refundCount = () => (sqlite.prepare("SELECT COUNT(*) n FROM fund_ledger WHERE kind='refund'").get() as any).n;
const prepare = (extra = {}) => reserveLegacyVideo(1, 2, charge => ContentService.save({
  userId: 1, type: 'video', modelId: model, status: 'queued', cost: 2,
  metadata: { ...videoSubmissionPreparation(), billingReservationId: charge.id, billingStatus: 'reserved', reservedCost: 2,
    channelId: 1, model, prompt: 'cancel test', seconds: 6, resolution: '720p', ...extra },
})).contentId;

beforeAll(async () => {
  video = await import('../server/routes/video');
  const content = await import('../server/routes/content');
  const app = express(); app.use(express.json()); app.use('/api/video', video.default); app.use('/api/contents', content.default);
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  findVideoSubmissionReceipt(1);
});
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const table of ['fund_ledger_content_links', 'fund_ledger', 'contents', 'channel_api_keys', 'channels', 'users', 'models', 'model_pricing', 'settings', 'video_submission_receipts']) {
    if (sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) sqlite.exec('DELETE FROM ' + table);
  }
  sqlite.exec('DROP TABLE IF EXISTS billing_reservations');
  db.insert(users).values({ id: 1, email: 'cancel@test', username: 'test', passwordHash: 'test', balance: 100 }).run();
  db.insert(channels).values({ id: 1, name: 'HM cancel test', type: 'hmstudio', baseUrl: 'https://hm.invalid', apiKey: 'test', status: 1,
    supportedModels: JSON.stringify([model]), concurrencyLimit: 1 }).run();
  db.insert(channelApiKeys).values({ id: 1, channelId: 1, apiKey: 'test', concurrencyLimit: 1, status: 1 }).run();
  db.insert(models).values({ modelId: model, displayName: model, provider: 'hmstudio', capabilities: '["video"]', isActive: 1 }).run();
  db.insert(modelPricing).values({ modelPattern: model, billingType: 'per_call', inputPrice: 2, outputPrice: 0 }).run();
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms: number, ...args: any[]) => nativeTimer(fn, [1500, 5000, 8000, 10000, 12000].includes(ms) ? 2 : ms, ...args)) as any);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); sqlite.close(); });

it.each([false, true])('actual website queue managed=%s: cancellation frees the queue, refunds once and never sends generation', async managed => {
  if (managed) {
    const limits = { ...defaultRoutingLimits(), maxImages: 9, resolutions: ['720p'], ratios: ['16:9'],
      duration: { mode: 'options' as const, min: 6, max: 6, step: 1, values: [6] } };
    saveModelSpecification({ modelId: model, enabled: true, aliases: [], kind: 'video', limits,
      routes: [{ id: 'cancel-route', channelId: 1, executionModel: model, upstreamModel: model, enabled: true,
        limits, cost: 1, costUnit: 'per_call', resolutionCosts: {}, priority: 0 }] });
  }
  const poolKey = hmStudioPoolKey(db.select().from(channels).get()!);
  hmStudioQueue.syncPools([{ poolKey, concurrencyLimit: 1 }]);
  let release!: () => void;
  const blocker = hmStudioQueue.adoptRunning({ id: 'blocker', userKey: 'blocker', poolKey, task: () => new Promise<void>(r => { release = r; }) });
  vi.stubGlobal('fetch', vi.fn());
  let stream: Response | undefined;
  try {
    stream = await nativeFetch(origin + '/api/video/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: 'cancel actual queue', resolution: '720p', video_length: 6, aspect_ratio: '16:9' }) });
    if (!stream.ok) throw new Error(await stream.text());
    await vi.waitFor(() => expect(row()?.status).toBe('queued'));
    expect(wallet()).toBe(98);
    expect((sanitizeContentRoutingForClient(row()) as any).canCancel).toBe(true);
    expect((await request(row().id, 'DELETE', '')).status).toBe(409);
    const responses = await Promise.all([request(row().id), request(row().id)]);
    expect(responses.map(r => r.status)).toEqual([200, 200]);
    expect(wallet()).toBe(100); expect(refundCount()).toBe(1);
    expect(row().status).toBe('failed'); expect(meta().cancelledBeforeSubmission).toBe(true);
    expect(() => claimVideoSubmission(row().id)).toThrow('任务已结束');
    expect(hmStudioQueue.has((managed ? 'spec-' : 'video:') + row().id)).toBe(false);
  } finally { release(); await blocker.completion; if (stream && !stream.bodyUsed) await stream.text(); }
  video.resumeAllPendingVideoTasks();
  resumeSpecificationTasks();
  expect(fetch).not.toHaveBeenCalled(); expect(wallet()).toBe(100); expect(refundCount()).toBe(1);
});

it.each(['submitting', 'accepted', 'unknown'])('rejects cancellation and deletion for %s without losing the order or refunding', async state => {
  const id = prepare({ videoSubmissionState: state, videoId: state === 'accepted' ? 'task-original' : undefined });
  expect((await request(id)).status).toBe(409);
  expect((await request(id, 'DELETE', '')).status).toBe(409);
  expect(row().id).toBe(id); expect(wallet()).toBe(98); expect(refundCount()).toBe(0);
  expect((sanitizeContentRoutingForClient(row()) as any).canCancel).toBe(false);
});

it('a durable receipt blocks cancellation even when metadata still says preparing', async () => {
  const id = prepare();
  persistVideoSubmissionReceipt({ contentId: id, upstreamTaskId: 'task-original', channelId: 1, channelApiKeyId: null, provider: 'hmstudio' });
  expect((await request(id)).status).toBe(409);
  expect(wallet()).toBe(98); expect(findVideoSubmissionReceipt(id)?.upstreamTaskId).toBe('task-original');
  expect((sanitizeContentRoutingForClient(row()) as any).canCancel).toBe(false);
});

it.each([false, true])('managed=%s: refund failure rolls back cancellation; retry then refunds exactly once', async managedSpecification => {
  const id = prepare({ managedSpecification });
  sqlite.exec("CREATE TRIGGER block_cancel_refund BEFORE UPDATE ON users WHEN NEW.balance > OLD.balance BEGIN SELECT RAISE(ABORT,'refund unavailable'); END");
  try {
    expect((await request(id)).status).toBe(500);
    expect(row().status).toBe('queued'); expect(meta().cancelledBeforeSubmission).toBeUndefined();
    expect(meta().videoSubmissionState).toBe('preparing'); expect(wallet()).toBe(98); expect(refundCount()).toBe(0);
  } finally { sqlite.exec('DROP TRIGGER block_cancel_refund'); }
  expect((await request(id)).status).toBe(200); expect(wallet()).toBe(100); expect(refundCount()).toBe(1);
});

it('denies cancellation for another owner and rejects unknown legacy state', async () => {
  const id = prepare();
  db.update(contents).set({ userId: 2 }).where(eq(contents.id, id)).run();
  expect((await request(id)).status).toBe(403);
  db.update(contents).set({ userId: 1, metadata: JSON.stringify({ ...meta(), videoSubmissionState: undefined }) }).where(eq(contents.id, id)).run();
  expect((await request(id)).status).toBe(409); expect(wallet()).toBe(98);
});

it('while POST awaits acceptance, cancel is refused and the original task can still complete', async () => {
  let accept!: (r: Response) => void;
  const upstream = vi.fn(async (_url: any, options: any) => options?.method === 'POST'
    ? new Promise<Response>(r => { accept = r; })
    : Response.json({ id: 'task-original', status: 'completed', video_url: 'https://media.invalid/result.mp4' }));
  vi.stubGlobal('fetch', upstream);
  video.enqueueHmStudioVideoContent(prepare());
  await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce());
  try {
    expect(meta().videoSubmissionState).toBe('submitting');
    expect((await request(row().id)).status).toBe(409);
    expect((await request(row().id, 'DELETE', '')).status).toBe(409);
    expect(wallet()).toBe(98); expect(refundCount()).toBe(0);
  } finally { accept(Response.json({ id: 'task-original' })); }
  await vi.waitFor(() => expect(row().status).toBe('completed'));
  expect(row().resultUrl).toBe('/uploads/cancel-test.mp4'); expect(wallet()).toBe(98); expect(refundCount()).toBe(0);
  expect(upstream.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});
