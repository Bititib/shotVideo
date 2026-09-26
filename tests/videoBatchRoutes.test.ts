import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3'); const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,is_active INTEGER,balance REAL);
    CREATE TABLE models(model_id TEXT,is_active INTEGER,capabilities TEXT);`);
  return { sqlite };
});
vi.mock('../server/config/env.js', () => ({ env: { PORT: 9876 } }));
vi.mock('../server/middleware/auth.js', () => ({ authMiddleware: (req: any, res: any, next: any) => {
  if (!req.headers.authorization) return res.status(401).json({ error: '请先登录' });
  req.userId = Number(req.headers.authorization.replace('Bearer ', '')); next();
} }));
vi.mock('../server/middleware/tier.js', () => ({ tierMiddleware: () => (_req: any, _res: any, next: any) => next() }));
vi.mock('../server/middleware/quota.js', () => ({ quotaMiddleware: (_req: any, _res: any, next: any) => next() }));
vi.mock('../server/services/contentService.js', () => ({ materializeContentMetadataAssets: (metadata: any) => ({ metadata }) }));
vi.mock('../server/services/videoBatchService.js', async () => {
  const { sqlite } = await import('../server/db/index.js');
  const { VideoBatchStore } = await import('../server/services/videoBatchStore');
  return { tickVideoBatches: vi.fn(), batchStore: new VideoBatchStore(sqlite, {
    deduct: (id, amount) => sqlite.prepare('UPDATE users SET balance=balance-? WHERE id=? AND balance>=?').run(amount, id, amount).changes ? { source: 'user' } : null,
    refund: (id, amount) => { sqlite.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(amount, id); },
  }) };
});

import routes from '../server/routes/videoBatches';
import { sqlite } from '../server/db/index.js';
const nativeFetch = globalThis.fetch;
let server: Server; let origin: string;
const input = { name: 'test', model: 'test-video', resolution: '720p', aspect_ratio: '9:16', video_length: 6,
  autoRetry: false, maxRetries: 2, creatives: [{ prompt: '用户原词', count: 20, reference_images: [] }], requestKey: 'unique-request-key-1234', expectedUnitCost: 1.5 };
const balance = () => (sqlite.prepare('SELECT balance FROM users WHERE id=1').get() as any).balance;
async function request(endpoint: string, body?: any, user = 1) {
  const response = await nativeFetch(`${origin}/api/video-batches${endpoint}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/api/video-batches', routes);
  server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => {
  sqlite.exec(`DELETE FROM video_batch_commands; DELETE FROM video_batch_attempts; DELETE FROM video_batch_items;
    DELETE FROM video_batches; DELETE FROM users; DELETE FROM models;
    INSERT INTO users VALUES(1,1,100),(2,1,100); INSERT INTO models VALUES('test-video',1,'["video"]');`);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === 'http://127.0.0.1:9876/api/video/validate') return Response.json({ unitCost: 1.5 });
    throw new Error('Unexpected upstream call');
  }));
});
afterAll(async () => { vi.unstubAllGlobals(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); sqlite.close(); });

describe('batch HTTP endpoints', () => {
  it('requires login and rejects oversized prompts before price checks or reservation', async () => {
    expect((await request('', undefined, 0)).status).toBe(401);
    const result = await request('/quote', { ...input, creatives: [{ ...input.creatives[0], prompt: '字'.repeat(5001) }] });
    expect(result.status).toBe(400); expect(result.body.error).toContain('5000'); expect(fetch).not.toHaveBeenCalled(); expect(balance()).toBe(100);
  });
  it.each([0, 101, 1.5])('rejects invalid quantity %s without reservation', async count => {
    expect((await request('', { ...input, creatives: [{ ...input.creatives[0], count }] })).status).toBe(400);
    expect(balance()).toBe(100);
  });
  it('quotes without deduction and refuses stale prices', async () => {
    expect((await request('/quote', input)).body).toEqual({ total: 20, unitCost: 1.5, totalCost: 30 });
    expect(balance()).toBe(100);
    expect((await request('', { ...input, expectedUnitCost: 0.1 })).body.error).toContain('价格已变化');
    expect(balance()).toBe(100);
  });
  it('concurrent repeated submissions create one batch with one pre-deduction', async () => {
    const results = await Promise.all([request('', input), request('', input)]);
    expect(results.map(r => r.status)).toEqual([200, 200]);
    expect(results[0].body.id).toBe(results[1].body.id); expect(balance()).toBe(70);
    expect(results[0].body.items).toHaveLength(20);
    expect(results[0].body.payload).toBeUndefined(); expect(results[0].body.items[0].receipt).toBeUndefined();
  });
  it('only the owner can inspect, cancel, retry, or download a batch', async () => {
    const { body } = await request('', input); const id = body.id;
    expect((await request(`/${id}`, undefined, 2)).status).toBe(400);
    expect((await request(`/${id}/cancel-pending`, {}, 2)).status).toBe(400);
    expect((await request(`/${id}/retry-failed`, { requestKey: 'retry-request-key-1234' }, 2)).status).toBe(400);
    expect((await request(`/${id}/download`, {}, 2)).status).toBe(400);
    expect((await request('', undefined, 2)).body).toEqual([]); expect(balance()).toBe(70);
    const cancelled = await request(`/${id}/cancel-pending`, {});
    expect(cancelled.body.refunded).toBe(30); expect(balance()).toBe(100);
  });
  it('does not accept a client-specified free price or hidden prepaid flag', async () => {
    expect((await request('', { ...input, expectedUnitCost: 0, prepaid: true, batchItemId: 100 })).status).toBe(400);
    expect(balance()).toBe(100);
  });
  it('preflight provider validation failure prevents deduction', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: '该模型仅支持 15 秒' }, { status: 400 })));
    expect((await request('', input)).body.error).toContain('15 秒'); expect(balance()).toBe(100);
  });
});
