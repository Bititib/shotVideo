import { beforeAll, afterAll, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/services/videoCompatibilityService.js', () => ({
  prepareVideoForDelivery: async (file: string) => file, videoDeliveryContentType: () => 'video/mp4', cacheVideoForDelivery: vi.fn(),
}));
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import { db, sqlite } from '../server/db/index.js';
import { contents } from '../server/db/schema.js';
import routes from '../server/routes/v1.js';

let server: Server, base: string, root: string, file: string;
const original = Buffer.from('0000ftypmp42' + 'frame-data-'.repeat(100));
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-range-'));
  fs.mkdirSync(path.join(root, 'data/uploads'), { recursive: true });
  file = path.join(root, 'data/uploads/video.mp4'); fs.writeFileSync(file, original);
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  db.insert(contents).values({ id: 1, userId: 1, type: 'video', status: 'completed', resultUrl: '/uploads/video.mp4', cost: 4 }).run();
  const app = express(); app.use('/v1', routes);
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = 'http://127.0.0.1:' + (server.address() as any).port + '/v1/videos/task_1/content';
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); sqlite.close(); });

it('serves the actual video endpoint with strong ETag and correct remaining bytes', async () => {
  const full = await fetch(base), etag = full.headers.get('etag')!;
  expect(full.status).toBe(200);
  expect(etag).toBe('"sha256-' + crypto.createHash('sha256').update(original).digest('hex') + '"');
  expect(full.headers.get('accept-ranges')).toBe('bytes');
  expect(Buffer.from(await full.arrayBuffer())).toEqual(original);
  const remaining = await fetch(base, { headers: { Range: 'bytes=32-', 'If-Range': etag } });
  expect(remaining.status).toBe(206);
  expect(remaining.headers.get('content-range')).toBe(`bytes 32-${original.length-1}/${original.length}`);
  expect(remaining.headers.get('etag')).toBe(etag);
  expect(Buffer.from(await remaining.arrayBuffer())).toEqual(original.subarray(32));
  expect(db.select().from(contents).all()).toHaveLength(1);
  expect(db.select().from(contents).get()!.cost).toBe(4);
});

it('sends a complete new representation when If-Range no longer matches', async () => {
  const old = await fetch(base); const etag = old.headers.get('etag')!; await old.arrayBuffer();
  const changed = Buffer.concat([original, Buffer.from('changed')]); fs.writeFileSync(file, changed);
  const response = await fetch(base, { headers: { Range: 'bytes=32-', 'If-Range': etag } });
  expect(response.status).toBe(200);
  expect(response.headers.get('etag')).not.toBe(etag);
  expect(response.headers.get('content-range')).toBeNull();
  expect(Buffer.from(await response.arrayBuffer())).toEqual(changed);
});

it('returns 416 for an invalid offset without creating or charging a new task', async () => {
  const full = await fetch(base); const etag = full.headers.get('etag')!; await full.arrayBuffer();
  const response = await fetch(base, { headers: { Range: 'bytes=99999999-', 'If-Range': etag } });
  expect(response.status).toBe(416); await response.arrayBuffer();
  expect(db.select().from(contents).all()).toHaveLength(1);
  expect(db.select().from(contents).get()!.cost).toBe(4);
});
