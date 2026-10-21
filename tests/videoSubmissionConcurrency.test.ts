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
import { users, channels, models, modelPricing, contents, apiTokens } from '../server/db/schema';
import { TokenService } from '../server/services/tokenService';
import { findVideoSubmissionReceipt } from '../server/services/videoSubmissionReceiptService';
import { claimVideoSubmission, releaseVideoSubmission, endVideoSubmission } from '../server/services/videoSubmissionGuard';
import { saveModelSpecification } from '../server/services/modelRoutingService';
import { defaultRoutingLimits } from '../shared/modelRouting';
import { VideoRecoveryService as ContentRecoveryService } from '../server/services/videoRecoveryService';
import { resumeSpecificationTasks } from '../server/services/specificationGenerationService';

const nativeFetch = globalThis.fetch, nativeTimer = globalThis.setTimeout;
const model = 'wan3.0-video-prime';
let video: typeof import('../server/routes/video'), server: Server, origin: string, tokenKey: string, tokenId: number;
const row = () => db.select().from(contents).all().at(-1)!;
const wallet = () => db.select().from(users).get()!.balance;
const tokenWallet = () => db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get()!.balance;
const meta = () => JSON.parse(row().metadata);
const post = (path: string, body: any) => nativeFetch(origin + path, {
  method: 'POST', headers: { Authorization: 'Bearer ' + tokenKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
beforeAll(async () => {
  video = await import('../server/routes/video');
  const api = await import('../server/routes/v1'), content = await import('../server/routes/content');
  const app = express(); app.use(express.json()); app.use('/api/video', video.default); app.use('/v1', api.default); app.use('/api/contents', content.default);
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  findVideoSubmissionReceipt(1);
});
beforeEach(() => {
  probes.video.mockReset().mockResolvedValue({ rawDurations: [5.01], durations: [5.1], total: 5.1 });
  probes.audio.mockReset().mockResolvedValue({ rawDurations: [3.01], durations: [3.1], total: 3.1 });
  for (const table of ['contents','channels','users','models','model_pricing','api_tokens','api_logs','settings','video_submission_receipts']) sqlite.exec('DELETE FROM ' + table);
  sqlite.exec('DROP TABLE IF EXISTS billing_reservations');
  db.insert(users).values({ id: 1, email: 'race@test', username: 'test', passwordHash: 'test', balance: 100 }).run();
  db.insert(channels).values({ id: 1, name: 'snumom test', type: 'snumom', baseUrl: 'https://upstream.invalid', apiKey: 'test', status: 1,
    supportedModels: JSON.stringify([model]), modelMapping: '{}' }).run();
  db.insert(models).values({ modelId: model, displayName: model, provider: 'snumom', capabilities: '["video"]', isActive: 1 }).run();
  db.insert(modelPricing).values({ modelPattern: model, billingType: 'per_call', inputPrice: 3.9, outputPrice: 0 }).run();
  const token = TokenService.createToken({ userId: 1, name: 'test', balance: 100 }); tokenKey = token.tokenKey; tokenId = token.id;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms: number, ...args: any[]) => nativeTimer(fn, [5000,8000,10000,12000].includes(ms) ? 2 : ms, ...args)) as any);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); sqlite.close(); });

function managed() {
  const limits = { ...defaultRoutingLimits(), maxImages: 9, resolutions: ['720p'], ratios: ['16:9'],
    duration: { mode: 'options' as const, min: 15, max: 15, step: 1, values: [15] } };
  saveModelSpecification({ modelId: model, enabled: true, aliases: [], kind: 'video', limits,
    routes: [{ id: 'race-route', channelId: 1, executionModel: model, upstreamModel: model, enabled: true,
      limits, cost: 1, costUnit: 'per_call', resolutionCosts: {}, priority: 0 }] });
}
const body = { model, prompt: '并发提交测试', seconds: 15, video_length: 15, resolution: '720p', aspect_ratio: '16:9' };

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
  const standard = 'wan3.0-video';
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
    if (polls < 3) {
      expect(row().status).toBe('processing'); expect(meta().queueRefunded).not.toBe(true);
      return Response.json({ message: 'temporarily unavailable' }, { status: polls === 1 ? 404 : 503 });
    }
    return Response.json({ id: 'task_query_retry', status: 'completed', metadata: { url: 'https://media.invalid/result.mp4' } });
  });
  vi.stubGlobal('fetch', upstream);
  await (await post(endpoint, body)).text();
  await vi.waitFor(() => expect(row().status).toBe('completed'));
  expect(polls).toBe(3); expect(upstream.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1);
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
