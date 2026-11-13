import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
vi.mock('../server/middleware/auth.js', () => ({ authMiddleware: (_req: any, _res: any, next: any) => next() }));
vi.mock('@distube/ytdl-core', () => ({ default: {} }));
import router from '../server/routes/proxy';
const realFetch = globalThis.fetch;
let server: Server, endpoint: string;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use(router);
  server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/image`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
afterEach(() => vi.unstubAllGlobals());
const request = (body: unknown) => realFetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
it('returns every carousel image in order and audio metadata without downloading a default image', async () => {
  const images = ['https://example.com/1.jpg', 'https://example.com/2.jpg', 'https://example.com/3.jpg'];
  const upstream = vi.fn().mockResolvedValue(Response.json({ data: { images, music_info: { play: 'audio', title: '原声' } } }));
  vi.stubGlobal('fetch', upstream);
  const response = await request({ url: 'https://vm.tiktok.com/abc', mode: 'list' });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ images, audioTitle: '原声' });
  expect(upstream).toHaveBeenCalledTimes(1);
});
it('keeps direct links and cover-only posts available', async () => {
  const upstream = vi.fn().mockResolvedValue(Response.json({ data: { cover: 'https://example.com/cover.jpg' } }));
  vi.stubGlobal('fetch', upstream);
  expect(await (await request({ url: 'https://example.com/direct.jpg', mode: 'list' })).json()).toMatchObject({ images: ['https://example.com/direct.jpg'] });
  expect(upstream).not.toHaveBeenCalled();
  expect(await (await request({ url: 'https://www.tiktok.com/@a/video/1', mode: 'list' })).json()).toMatchObject({ images: ['https://example.com/cover.jpg'] });
});
it('preserves legacy binary downloads', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('image-bytes', { headers: { 'content-type': 'image/jpeg' } })));
  const response = await request({ url: 'https://example.com/2.jpg' });
  expect(response.headers.get('content-type')).toContain('image/jpeg'); expect(await response.text()).toBe('image-bytes');
});
it('rejects empty upstream results and unsupported URLs', async () => {
  const upstream = vi.fn().mockResolvedValue(Response.json({ data: null })); vi.stubGlobal('fetch', upstream);
  expect((await request({ url: 'https://www.tiktok.com/broken', mode: 'list' })).status).toBe(500);
  expect((await request({ url: 'file:///secret', mode: 'list' })).status).toBe(400);
  expect(upstream).toHaveBeenCalledTimes(1);
});
