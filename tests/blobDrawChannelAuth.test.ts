import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const sqlite = new Database(':memory:');
  sqlite.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT, is_active INTEGER); INSERT INTO users VALUES (1,'admin',1)");
  return { sqlite, db: {} };
});
vi.mock('../server/config/env.js', () => ({ env: { JWT_SECRET: 'channel-auth-test-only', NODE_ENV: 'test' }, getApiKeys: () => [] }));
vi.mock('../server/services/channelService.js', () => ({ ChannelService: { syncModels: vi.fn(), testChannel: vi.fn(), getChannels: vi.fn() } }));
vi.mock('../server/services/videoRoutingStatsService.js', () => ({ VideoRoutingStatsService: {} }));

import channelRoutes from '../server/routes/channels.js';
import { sqlite } from '../server/db/index.js';
import { ChannelService } from '../server/services/channelService.js';
import { BlobDrawApiError } from '../server/services/blobDrawAdapter.js';
import { api } from '../client/src/api/client.js';

const nativeFetch = globalThis.fetch;
let server: Server, baseUrl = '', token = '';
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/channels', channelRoutes);
  server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address() as { port: number };
  baseUrl = 'http://127.0.0.1:' + address.port;
});
beforeEach(() => {
  vi.clearAllMocks();
  token = jwt.sign({ userId: 1, role: 'admin' }, 'channel-auth-test-only', { expiresIn: '1h' });
  const values = new Map([['token', token]]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal('fetch', (url: string, options: RequestInit) => nativeFetch(new URL(url, baseUrl), options));
  vi.mocked(ChannelService.getChannels).mockReturnValue([] as any);
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  sqlite.close();
});
describe('channel upstream errors and administrator authentication', () => {
  it.each([401,403,429,503])('keeps the administrator signed in after an upstream %s sync error', async status => {
    vi.mocked(ChannelService.syncModels).mockRejectedValue(new BlobDrawApiError('BlobDraw 请求失败：上游拒绝访问', status));
    await expect(api.post('/admin/channels/1/sync-models')).rejects.toMatchObject({
      status: 502, data: { code: 'UPSTREAM_ERROR', upstreamStatus: status },
    });
    expect(localStorage.getItem('token')).toBe(token);
    await expect(api.get('/admin/channels')).resolves.toEqual([]);
    if (status === 401) {
      const res = await nativeFetch(baseUrl + '/api/admin/channels/1/sync-models', {
        method: 'POST', headers: { Authorization: 'Bearer ' + token },
      });
      expect((await res.json()).error).toContain('API Key');
    }
  });
  it('still requires valid local credentials and clears an expired local token', async () => {
    localStorage.setItem('token', jwt.sign({ userId: 1, role: 'admin' }, 'channel-auth-test-only', { expiresIn: -1 }));
    await expect(api.post('/admin/channels/1/sync-models')).rejects.toThrow('登录已过期');
    expect(localStorage.getItem('token')).toBeNull();
    expect(ChannelService.syncModels).not.toHaveBeenCalled();
  });
  it('keeps local configuration errors distinct from upstream errors', async () => {
    vi.mocked(ChannelService.syncModels).mockRejectedValue({ status: 400, message: '请先为渠道添加 API Key' });
    await expect(api.post('/admin/channels/1/sync-models')).rejects.toMatchObject({ status: 400 });
    expect(localStorage.getItem('token')).toBe(token);
  });
  it('reports a failed connection test without logging the administrator out', async () => {
    vi.mocked(ChannelService.testChannel).mockResolvedValue({ success: false, message: 'fail:BlobDraw API Key 校验失败', durationMs: 10 });
    await expect(api.post('/admin/channels/1/test')).resolves.toMatchObject({ success: false });
    expect(localStorage.getItem('token')).toBe(token);
  });
});
