import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/services/videoLocalizationService.js', () => ({ downloadAndLocalizeVideo: vi.fn(async () => '/uploads/optional-idempotency.mp4') }));
import express from 'express';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { db, sqlite } from '../server/db/index.js';
import { users, apiTokens, models, modelPricing, contents } from '../server/db/schema.js';
import v1Routes from '../server/routes/v1.js';
import { ChannelService } from '../server/services/channelService.js';
import { resumeSpecificationTasks } from '../server/services/specificationGenerationService.js';

const nativeFetch = globalThis.fetch, userKey = 'sk-optional-test-only';
const video = { model: 'gemini-omni-flash', prompt: 'same original request', seconds: 10, ratio: '9:16' };
const paths = ['/v1/videos', '/v1/videos/generations', '/v1/video/generations'];
let server: Server, origin: string, posts: number;
let upstream: ReturnType<typeof vi.fn>;
const balance = () => db.select().from(apiTokens).get()!.balance;
const rows = () => db.select().from(contents).all();
async function api(path: string, body?: any, key?: string) {
  const response = await nativeFetch(origin + path, { method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + userKey, 'Content-Type': 'application/json', ...(key === undefined ? {} : { 'Idempotency-Key': key }) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, replayed: response.headers.get('x-idempotency-replayed'), body: await response.json() as any };
}
async function settled(id: string) {
  let result: any;
  await vi.waitFor(async () => { result = (await api('/v1/videos/' + id)).body; expect(['failed', 'completed'].includes(result.status) || result.requires_review).toBe(true); });
  return result;
}
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/v1', v1Routes);
  server = await new Promise<Server>(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  origin = 'http://127.0.0.1:' + (server.address() as any).port;
});
beforeEach(async () => {
  vi.clearAllMocks();
  for (const { name } of sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) sqlite.exec(`DELETE FROM "${name}"`);
  db.insert(users).values({ id: 1, username: 'test', email: 'optional@example.test', passwordHash: 'unused', balance: 100 }).run();
  db.insert(apiTokens).values({ id: 1, userId: 1, tokenKey: userKey, name: 'test', balance: 100 }).run();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: 'omniomni-flash-1.1' }] })));
  const channelId = ChannelService.createChannel({ name: 'test channel', type: 'funai', baseUrl: 'https://provider.invalid', apiKey: 'private-test-only' });
  await ChannelService.syncModels(channelId);
  db.update(models).set({ isActive: 1 }).run();
  db.insert(modelPricing).values({ modelPattern: 'funai-gemini-omni-flash', billingType: 'per_call', inputPrice: 0.6, outputPrice: 0 }).run();
  posts = 0;
  upstream = vi.fn(async (_url, init) => init?.method === 'POST'
    ? Response.json({ id: 'upstream-' + ++posts, status: 'queued' })
    : Response.json({ status: 'completed', url: 'https://cdn.invalid/result.mp4' }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); sqlite.close(); });

describe('optional video idempotency through real routes and isolated billing', () => {
  it.each(['', 'contains spaces'])('rejects an invalid explicit key %j before creating an order or charging', async key => {
    const response = await api(paths[0], video, key);
    expect(response.status).toBe(400); expect(rows()).toEqual([]); expect(posts).toBe(0); expect(balance()).toBe(100);
  });
  it.each(paths)('%s creates fresh concurrent tasks for identical unkeyed requests and queries never charge again', async path => {
    const [first, second] = await Promise.all([api(path, video), api(path, video)]);
    expect(first.body.id).not.toBe(second.body.id); expect(first.replayed).toBeNull(); expect(second.replayed).toBeNull();
    expect(await settled(first.body.id)).toMatchObject({ status: 'completed', billing_status: 'settled' });
    expect(await settled(second.body.id)).toMatchObject({ status: 'completed', billing_status: 'settled' });
    expect(posts).toBe(2); expect(rows()).toHaveLength(2); expect(balance()).toBeCloseTo(98.8);
    await api('/v1/videos/' + first.body.id); await api('/v1/videos/' + second.body.id); resumeSpecificationTasks();
    expect(posts).toBe(2); expect(balance()).toBeCloseTo(98.8);
  });
  it('does not replay the historical body-hash quota failure, and preserves its original refund record', async () => {
    upstream.mockImplementationOnce(async () => { posts++; return Response.json({ error: { code: 'insufficient_user_quota', message: '额度不足' } }, { status: 403 }); });
    const first = await api('/v1/videos', video);
    expect(await settled(first.body.id)).toMatchObject({ status: 'failed', billing_status: 'refunded', refund_amount: 0.6 });
    expect(balance()).toBe(100);
    const legacy = sqlite.prepare('SELECT fingerprint FROM api_video_requests WHERE id=?').get(first.body.id) as any;
    sqlite.prepare('UPDATE api_video_requests SET key_hash=? WHERE id=?').run(createHash('sha256').update('body:' + legacy.fingerprint).digest('hex'), first.body.id);
    const original = rows()[0];
    const second = await api('/v1/videos', video);
    expect(second.body.id).not.toBe(first.body.id);
    expect(await settled(second.body.id)).toMatchObject({ status: 'completed', billing_status: 'settled' });
    expect((await api('/v1/videos/' + first.body.id)).body).toMatchObject({ status: 'failed', billing_status: 'refunded' });
    expect(rows()[0]).toEqual(original); expect(posts).toBe(2); expect(balance()).toBeCloseTo(99.4);
  });
  it.each(['completed', 'failed'])('keeps explicit-key concurrent and terminal %s replays at one upstream call and one settlement', async outcome => {
    upstream.mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') { posts++; return Response.json({ id: 'original-task' }); }
      return outcome === 'completed' ? Response.json({ status: 'completed', url: 'https://cdn.invalid/original.mp4' })
        : Response.json({ status: 'failed', error: { code: 'generation_failed', message: '生成失败' } });
    });
    const key = 'same-logical-request';
    const [first, second] = await Promise.all([api(paths[0], video, key), api(paths[1], video, key)]);
    expect(second.body.id).toBe(first.body.id); expect([first.replayed, second.replayed]).toContain('true');
    expect(await settled(first.body.id)).toMatchObject({ status: outcome });
    expect((await api(paths[2], video, key)).body.id).toBe(first.body.id);
    expect(posts).toBe(1); expect(rows()).toHaveLength(1); expect(balance()).toBeCloseTo(outcome === 'completed' ? 99.4 : 100);
    const conflict = await api(paths[0], { ...video, seconds: 5 }, key);
    expect(conflict.status).toBe(409); expect(conflict.body.error.code).toBe('idempotency_conflict'); expect(posts).toBe(1);
  });
  it('keeps explicit-key unknown acceptance reserved across replays and worker recovery without resending', async () => {
    upstream.mockImplementation(async () => { posts++; throw new Error('response lost'); });
    const first = await api(paths[0], video, 'unknown-request');
    expect(await settled(first.body.id)).toMatchObject({ requires_review: true, billing_status: 'review' });
    expect((await api(paths[1], video, 'unknown-request')).body.id).toBe(first.body.id);
    resumeSpecificationTasks(); resumeSpecificationTasks();
    expect(posts).toBe(1); expect(rows()).toHaveLength(1); expect(balance()).toBeCloseTo(99.4);
  });
  it('refunds a rejected new unkeyed task without refunding or resending the earlier unknown task', async () => {
    upstream.mockImplementationOnce(async () => { posts++; throw new Error('response lost'); });
    const first = await api(paths[0], video);
    expect(await settled(first.body.id)).toMatchObject({ requires_review: true, billing_status: 'review' });
    upstream.mockImplementationOnce(async () => { posts++; return Response.json({ error: { code: 'insufficient_user_quota', message: '额度不足' } }, { status: 403 }); });
    const second = await api(paths[0], video);
    expect(second.body.id).not.toBe(first.body.id);
    expect(await settled(second.body.id)).toMatchObject({ status: 'failed', billing_status: 'refunded' });
    expect((await api('/v1/videos/' + first.body.id)).body).toMatchObject({ requires_review: true, billing_status: 'review' });
    resumeSpecificationTasks(); expect(posts).toBe(2); expect(balance()).toBeCloseTo(99.4);
  });
});
