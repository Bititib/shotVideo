import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, default: { ...actual, readdirSync: (directory: any, ...args: any[]) =>
    String(directory).replace(/\\/g, '/').endsWith('/data/video_cache') ? [] : (actual.readdirSync as any)(directory, ...args) } };
});
vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const schema = await import('../server/db/schema.js');
  const sqlite = new Database(':memory:');
  return { sqlite, db: drizzle(sqlite, { schema }) };
});
vi.mock('../server/config/env.js', () => ({
  env: { NODE_ENV: 'test', PORT: 0, JWT_SECRET: 'hm-catalog-test', ADMIN_EMAIL: 'hm@test.local', ADMIN_PASSWORD: 'test-password',
    GEMINI_API_KEY: '', HM_STUDIO_API_KEY: 'test-only-key', WX_HAIDIYUE_API_KEY: '', MINGFEI_API_KEY: '',
    NEWTOKEN_API_KEY: '', NEWTOKEN_BASE_URL: 'https://newtoken.club', SNUMOM_API_KEY: '', SNUMOM_BASE_URL: 'https://snumom.com' },
  getApiKeys: () => [],
}));
vi.mock('../server/services/videoBatchService.js', async importOriginal => ({
  ...await importOriginal<typeof import('../server/services/videoBatchService.js')>(), tickVideoBatches: vi.fn(),
}));

import { initDatabase } from '../server/db/seed.js';
import { db, sqlite } from '../server/db/index.js';
import { env } from '../server/config/env.js';
import { apiTokens, channels, contents, modelPricing, models, users } from '../server/db/schema.js';
import { PricingService } from '../server/services/pricingService.js';
import { TokenService } from '../server/services/tokenService.js';
import videoRouter from '../server/routes/video.js';
import apiRouter from '../server/routes/v1.js';
import batchRouter from '../server/routes/videoBatches.js';

const cases = [
  { id: 'SD2.0FAST803', rates: { '720p': 1.1, '1080p': 1.3, '2k': 1.5 }, images: 8, videos: 0 },
  { id: 'SD2.0FAST813', rates: { '720p': 1.3, '1080p': 1.5, '2k': 1.7 }, images: 8, videos: 1 },
  { id: 'SD2.0MINI503', rates: { '720p': 0.9 }, images: 5, videos: 0 },
];
const nativeFetch = globalThis.fetch;
let server: Server, origin: string, userId: number, userJwt: string, tokenKey: string, tokenId: number;
async function post(path: string, body: any, api = false) {
  return nativeFetch(origin + path, { method: 'POST', headers: {
    Authorization: 'Bearer ' + (api ? tokenKey : userJwt), 'Content-Type': 'application/json',
  }, body: JSON.stringify(body) });
}
const batchInput = (model: string, resolution: string) => ({ model, resolution, aspect_ratio: '9:16', video_length: 15,
  autoRetry: true, maxRetries: 2, creatives: [{ prompt: '商品展示', count: 20, reference_images: [] }] });
beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected external request'); }));
  await initDatabase();
  const user = db.select().from(users).where(eq(users.email, 'hm@test.local')).get()!;
  userId = user.id;
  db.update(users).set({ balance: 1000 }).where(eq(users.id, userId)).run();
  userJwt = jwt.sign({ userId, role: user.role }, 'hm-catalog-test');
  const token = TokenService.createToken({ name: 'HM test', balance: 100 });
  tokenKey = token.tokenKey; tokenId = token.id;
  const app = express(); app.use(express.json());
  app.use('/api/video', videoRouter); app.use('/v1', apiRouter); app.use('/api/video-batches', batchRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.on('listening', resolve));
  env.PORT = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${env.PORT}`;
  vi.stubGlobal('fetch', vi.fn(async (url: any, options: any) => {
    if (String(url).startsWith(origin + '/')) return nativeFetch(url, options);
    throw new Error('Unexpected external request');
  }));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  sqlite.close();
});

describe('HM new catalog integration (in-memory database, no upstream generation)', () => {
  it('registers all models without removing old HM mappings and exposes exact resolution prices', async () => {
    const channel = db.select().from(channels).where(eq(channels.type, 'hmstudio')).get()!;
    const mapping = JSON.parse(channel.modelMapping!);
    expect(mapping['seedance_v2.5']).toBe('MINIMAX-H3-2.5采样');
    const list = await (await nativeFetch(origin + '/api/video/models')).json() as any[];
    for (const { id, rates } of cases) {
      expect(mapping[id]).toBe(id);
      expect(JSON.parse(channel.supportedModels!)).toContain(id);
      expect(db.select().from(models).where(eq(models.modelId, id)).get()?.provider).toBe('hmstudio');
      expect(list.find(m => m.id === id)).toMatchObject({ available: true, billingType: 'per_call', rates,
        modelStatus: { state: 'unknown', reason: 'insufficient_data' },
        allowedSeconds: Array.from({ length: 12 }, (_, i) => i + 4) });
    }
  });
  it.each(cases)('quotes $id per video, normalizes resolution, and reserves/refunds a batch once', async ({ id, rates }) => {
    const initialBalance = db.select().from(users).where(eq(users.id, userId)).get()!.balance;
    for (const [resolution, price] of Object.entries(rates)) {
      expect(PricingService.quote(id, { resolution, seconds: 15, count: 1 }, false).cost).toBe(price);
      const check = await post('/api/video/validate', { model: id, prompt: '商品展示', resolution: resolution.toUpperCase(), video_length: 15 });
      expect(check.status).toBe(200);
      expect(await check.json()).toMatchObject({ unitCost: price, resolution });
      const input = batchInput(id, resolution);
      const beforeQuote = db.select().from(users).where(eq(users.id, userId)).get()!.balance;
      const quote = await post('/api/video-batches/quote', input);
      expect(quote.status).toBe(200);
      expect(await quote.json()).toEqual({ unitCost: price, total: 20, totalCost: price * 20 });
      expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(beforeQuote);
      const submitBody = { ...input, requestKey: crypto.randomUUID(), expectedUnitCost: price };
      const submitted = await post('/api/video-batches', submitBody);
      expect(submitted.status).toBe(200);
      const batch = await submitted.json() as any;
      expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBeCloseTo(initialBalance - price * 20);
      expect((await post('/api/video-batches', submitBody)).status).toBe(200);
      expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBeCloseTo(initialBalance - price * 20);
      expect((await post(`/api/video-batches/${batch.id}/cancel-pending`, {})).status).toBe(200);
      expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBeCloseTo(initialBalance);
    }
  });
  it.each(cases)('rejects invalid $id inputs before web/API deductions', async ({ id, images, videos }) => {
    const beforeUser = db.select().from(users).where(eq(users.id, userId)).get()!.balance;
    const beforeToken = db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get()!.balance;
    const beforeContents = db.select().from(contents).all().length;
    for (const api of [false, true]) {
      const base = { model: id, prompt: '商品展示', resolution: '720p', seconds: 15, video_length: 15 };
      const invalid = [
        { seconds: 16, video_length: 16 }, { resolution: '480p' },
        { [api ? 'image_urls' : 'reference_images']: Array(images + 1).fill('https://example.test/image.jpg') },
        { [api ? 'video_urls' : 'reference_videos']: Array(videos + 1).fill('https://example.test/video.mp4') },
        { audio_urls: Array(4).fill('https://example.test/audio.mp3') },
      ];
      for (const patch of invalid) {
        expect((await post(api ? '/v1/videos' : '/api/video/generate', { ...base, ...patch }, api)).status).toBe(400);
      }
    }
    expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(beforeUser);
    expect(db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get()!.balance).toBe(beforeToken);
    expect(db.select().from(contents).all().length).toBe(beforeContents);
    const invalidBatch = batchInput(id, '720p');
    invalidBatch.video_length = 16;
    const response = await post('/api/video-batches', { ...invalidBatch, requestKey: crypto.randomUUID(), expectedUnitCost: 0.9 });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('4-15');
    expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(beforeUser);
  });
  it('preserves administrator price overrides across startup', async () => {
    db.update(modelPricing).set({ inputPrice: 2, extraParams: JSON.stringify({ category: 'video', '720p': 2, '1080p': 3, '2k': 4 }) })
      .where(eq(modelPricing.modelPattern, 'SD2.0FAST803')).run();
    await initDatabase();
    expect(PricingService.quote('SD2.0FAST803', { resolution: '2k' }, false).cost).toBe(4);
  });
  it('exposes observed model status changes independently of legacy percentage statistics', async () => {
    const modelId = 'SD2.0FAST813';
    const readStatus = async () => {
      const list = await (await nativeFetch(origin + '/api/video/models')).json() as any[];
      return list.find(m => m.id === modelId).modelStatus;
    };
    expect(await readStatus()).toMatchObject({ state: 'unknown' });
    for (let i = 0; i < 3; i++) db.insert(contents).values({ userId, type: 'video', modelId, status: 'failed' }).run();
    expect(await readStatus()).toMatchObject({ state: 'unavailable', reason: 'consecutive_failures' });
    for (let i = 0; i < 20; i++) db.insert(contents).values({ userId, type: 'video', modelId, status: 'completed', resultUrl: '/video.mp4' }).run();
    expect(await readStatus()).toMatchObject({ state: 'healthy', reason: 'recent_successes' });
  });
});
