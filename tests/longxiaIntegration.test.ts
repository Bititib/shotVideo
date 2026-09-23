import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, default: { ...actual, readdirSync: (directory: any, ...args: any[]) =>
    String(directory).replace(/\\/g, '/').endsWith('/data/video_cache') ? [] : (actual.readdirSync as any)(directory, ...args) } };
});
// Exercise real routing/registration/pricing against a private in-memory database.
vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const schema = await import('../server/db/schema.js');
  const sqlite = new Database(':memory:');
  return { sqlite, db: drizzle(sqlite, { schema }) };
});
vi.mock('../server/config/env.js', () => ({
  env: { NODE_ENV: 'test', JWT_SECRET: 'longxia-test', ADMIN_EMAIL: 'longxia@test.local', ADMIN_PASSWORD: 'test-password',
    GEMINI_API_KEY: '', HM_STUDIO_API_KEY: '', WX_HAIDIYUE_API_KEY: '', MINGFEI_API_KEY: '',
    NEWTOKEN_API_KEY: '', NEWTOKEN_BASE_URL: 'https://newtoken.club', SNUMOM_API_KEY: '', SNUMOM_BASE_URL: 'https://snumom.com' },
  getApiKeys: () => [],
}));
vi.mock('../server/routes/video.js', async importOriginal => ({
  ...await importOriginal<typeof import('../server/routes/video.js')>(), resumePollForTask: vi.fn(),
}));

import { initDatabase } from '../server/db/seed.js';
import { db, sqlite } from '../server/db/index.js';
import { apiTokens, contents, models, users } from '../server/db/schema.js';
import { ChannelService } from '../server/services/channelService.js';
import { PricingService } from '../server/services/pricingService.js';
import { TokenService } from '../server/services/tokenService.js';
import { VideoRecoveryService } from '../server/services/videoRecoveryService.js';
import { LONGXIA_MODELS, longxiaResolution } from '../server/services/longxiaVideoAdapter.js';
import videoRouter from '../server/routes/video.js';
import apiRouter from '../server/routes/v1.js';

let server: http.Server, origin: string, tokenKey: string, tokenId: number, channelId: number;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  await initDatabase();
  channelId = ChannelService.createChannel({ name: 'LongXia test', type: 'longxia', baseUrl: 'https://api8.longxiaai.store/v1/', apiKey: 'test-upstream-key' });
  const token = TokenService.createToken({ name: 'LongXia test', balance: 100 });
  tokenKey = token.tokenKey; tokenId = token.id;
  const app = express();
  app.use(express.json()); app.use('/v1', apiRouter); app.use('/api/video', videoRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.on('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); sqlite.close(); });

describe('LongXia application integration', () => {
  it('registers both models, binds the channel and exposes fixed-resolution prices and durations', async () => {
    const response = await realFetch(origin + '/api/video/models');
    expect(response.status).toBe(200);
    const list = await response.json() as any[];
    for (const [index, model] of LONGXIA_MODELS.entries()) {
      expect(db.select().from(models).where(eq(models.modelId, model)).get()?.provider).toBe('longxia');
      expect(ChannelService.findChannelForModel(model)?.id).toBe(channelId);
      expect(list.find(item => item.id === model)).toMatchObject({
        billingType: 'per_second', rates: { [longxiaResolution(model)]: index === 0 ? 0.4 : 0.58 },
        allowedSeconds: Array.from({ length: 22 }, (_, i) => i + 4),
      });
      expect(PricingService.quote(model, { seconds: 25 }, false).cost).toBe(index === 0 ? 10 : 14.5);
    }
  });
  it.each(LONGXIA_MODELS)('submits %s using the provider contract and charges by duration', async model => {
    const upstream = vi.fn(async () => new Response(JSON.stringify({ task_id: 'longxia-upstream', status: 'queued' }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', upstream);
    const before = db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get()!.balance;
    const response = await realFetch(origin + '/v1/videos', {
      method: 'POST', headers: { Authorization: 'Bearer ' + tokenKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: '日出', seconds: 25, ratio: '16:9', video_urls: ['https://example.com/ref.mp4'], audio_urls: ['https://example.com/ref.mp3'] }),
    });
    const result = await response.json() as any;
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result.status).toBe('queued');
    expect(upstream).toHaveBeenCalledOnce();
    const [url, options] = upstream.mock.calls[0] as any;
    expect(url).toBe('https://api8.longxiaai.store/v1/videos');
    expect(JSON.parse(options.body)).toEqual({ model, prompt: '日出\n参考素材：@video1 @audio1', duration: 25, size: '16:9', assets: [
      { category: 'video', url: 'https://example.com/ref.mp4' }, { category: 'audio', url: 'https://example.com/ref.mp3' },
    ] });
    const expectedCost = model === LONGXIA_MODELS[0] ? 10 : 14.5;
    const after = db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get()!.balance;
    expect(before - after).toBe(expectedCost);
    const record = db.select().from(contents).where(eq(contents.id, Number(result.id.slice(5)))).get()!;
    expect(JSON.parse(record.metadata).videoId).toBe('longxia-upstream');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'completed', data: [{ url: 'https://media.longxiaai.store/result.mp4' }] }))));
    expect(await VideoRecoveryService.inspect(record.id)).toMatchObject({ status: 'completed', upstreamResultUrl: 'https://media.longxiaai.store/result.mp4' });
  });
  it('rejects invalid duration before contacting upstream or deducting balance', async () => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const before = db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get()!.balance;
    const response = await realFetch(origin + '/v1/videos', {
      method: 'POST', headers: { Authorization: 'Bearer ' + tokenKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: LONGXIA_MODELS[0], prompt: '日出', seconds: 26 }),
    });
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    expect(db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get()!.balance).toBe(before);
  });
  it('uses the LongXia payload on the web route and refunds a failed submission', async () => {
    const user = db.select().from(users).where(eq(users.email, 'longxia@test.local')).get()!;
    db.update(users).set({ balance: 100 }).where(eq(users.id, user.id)).run();
    const upstream = vi.fn(async () => new Response('capacity unavailable', { status: 503 }));
    vi.stubGlobal('fetch', upstream);
    const response = await realFetch(origin + '/api/video/generate', {
      method: 'POST', headers: { Authorization: 'Bearer ' + jwt.sign({ userId: user.id, role: user.role }, 'longxia-test'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: LONGXIA_MODELS[1], prompt: '日出', video_length: 25, reference_videos: ['https://example.com/ref.mp4'] }),
    });
    const events = await response.text();
    expect(response.status, events).toBe(200);
    expect(events).toContain('"cost":14.5');
    expect(events).toContain('LongXia 提交失败 (503)');
    expect(upstream).toHaveBeenCalledOnce();
    expect(JSON.parse((upstream.mock.calls[0] as any)[1].body)).toMatchObject({ duration: 25, size: '16:9', assets: [{ category: 'video', url: 'https://example.com/ref.mp4' }] });
    expect(db.select().from(users).where(eq(users.id, user.id)).get()!.balance).toBe(100);
  });
});
