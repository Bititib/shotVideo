import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
vi.mock('../server/services/publicImageDownload.js', () => ({ downloadPublicReferenceImage: vi.fn() }));
import { downloadPublicReferenceImage } from '../server/services/publicImageDownload.js';
import { publicReferences } from '../server/middleware/publicReferences.js';
import { saveModelSpecification } from '../server/services/modelRoutingService.js';
import { defaultRoutingLimits } from '../shared/modelRouting.js';
import { batchStore } from '../server/services/videoBatchService.js';

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
import { apiTokens, channels, contents, modelPricing, models, settings, tierModelAccess, userModelPricing, users } from '../server/db/schema.js';
import { PricingService } from '../server/services/pricingService.js';
import { TokenService } from '../server/services/tokenService.js';
import videoRouter from '../server/routes/video.js';
import apiRouter from '../server/routes/v1.js';
import batchRouter from '../server/routes/videoBatches.js';
import channelRouter from '../server/routes/channels.js';
import pricingRouter from '../server/routes/pricing.js';

const cases = [
  { id: 'SD2.0FAST803', rates: { '720p': 1.1, '1080p': 1.3, '2k': 1.5 }, images: 8, videos: 0, audios: 3, maxSeconds: 15 },
  { id: 'SD2.0FAST813', rates: { '720p': 1.3, '1080p': 1.5, '2k': 1.7 }, images: 8, videos: 1, audios: 3, maxSeconds: 15 },
  { id: 'SD2.0MINI503', rates: { '720p': 0.9 }, images: 5, videos: 0, audios: 3, maxSeconds: 15 },
  { id: 'sd2.5-301010', rates: { '720p': 7, '1080p': 12 }, images: 30, videos: 10, audios: 10, maxSeconds: 30 },
];
const nativeFetch = globalThis.fetch;
const referenceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-preflight-integration-'));
let referencePng: Buffer;
let server: Server, origin: string, userId: number, userJwt: string, tokenKey: string, tokenId: number;
async function post(path: string, body: any, api = false) {
  return nativeFetch(origin + path, { method: 'POST', headers: {
    Authorization: 'Bearer ' + (api ? tokenKey : userJwt), 'Content-Type': 'application/json',
  }, body: JSON.stringify(body) });
}
const batchInput = (model: string, resolution: string) => ({ name: 'test batch', model, resolution, aspect_ratio: '9:16', video_length: 15,
  autoRetry: true, maxRetries: 2, creatives: [{ prompt: '商品展示', count: 20, reference_images: [] }] });
beforeAll(async () => {
  vi.stubEnv('PUBLIC_REFERENCE_DIR', referenceDirectory);
  referencePng = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#123456' } }).png().toBuffer();
  vi.mocked(downloadPublicReferenceImage).mockResolvedValue(referencePng);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected external request'); }));
  await initDatabase();
  const user = db.select().from(users).where(eq(users.email, 'hm@test.local')).get()!;
  userId = user.id;
  db.update(users).set({ balance: 1000 }).where(eq(users.id, userId)).run();
  userJwt = jwt.sign({ userId, role: user.role }, 'hm-catalog-test');
  const token = TokenService.createToken({ name: 'HM test', balance: 100 });
  tokenKey = token.tokenKey; tokenId = token.id;
  const app = express(); app.use(express.json());
  app.use('/reference-assets', publicReferences());
  app.use('/api/video', videoRouter); app.use('/v1', apiRouter); app.use('/api/video-batches', batchRouter);
  app.use('/api/admin/channels', channelRouter); app.use('/api/admin/pricing', pricingRouter);
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
  vi.unstubAllEnvs(); fs.rmSync(referenceDirectory, { recursive: true, force: true });
});

describe('HM new catalog integration (in-memory database, no upstream generation)', () => {
  it('registers nova disabled without exposing the upstream ID and rejects orders before charging', async () => {
    const nova = db.select().from(models).where(eq(models.modelId, 'sd2.5-301010')).get()!;
    expect(nova).toMatchObject({ provider: 'hmstudio', displayName: 'sd2.5-301010', isActive: 0 });
    expect(db.select().from(models).where(eq(models.modelId, '30-10-10')).get()).toBeUndefined();
    const list = await (await nativeFetch(origin + '/api/video/models')).json() as any[];
    expect(list.some(m => m.id === 'sd2.5-301010')).toBe(false);
    const beforeUser = db.select().from(users).where(eq(users.id, userId)).get()!.balance;
    const beforeToken = db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get()!.balance;
    for (const api of [false, true]) {
      const response = await post(api ? '/v1/videos' : '/api/video/generate', {
        model: 'sd2.5-301010', prompt: 'test', resolution: '720p', seconds: 30, video_length: 30,
      }, api);
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(beforeUser);
    expect(db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get()!.balance).toBe(beforeToken);
    // Simulate explicit administrator activation only in this isolated test database.
    db.update(models).set({ isActive: 1 }).where(eq(models.modelId, 'sd2.5-301010')).run();
  });
  it('registers all models without removing old HM mappings and exposes exact resolution prices', async () => {
    const channel = db.select().from(channels).where(eq(channels.type, 'hmstudio')).get()!;
    const mapping = JSON.parse(channel.modelMapping!);
    expect(mapping['seedance_v2.5']).toBe('MINIMAX-H3-2.5采样');
    const list = await (await nativeFetch(origin + '/api/video/models')).json() as any[];
    const apiList = await (await nativeFetch(origin + '/v1/models', { headers: { Authorization: 'Bearer ' + tokenKey } })).json() as any;
    expect(apiList.data.map((m: any) => m.id)).toContain('sd2.5-301010');
    expect(apiList.data.map((m: any) => m.id)).not.toContain('30-10-10');
    for (const { id, rates, maxSeconds } of cases) {
      expect(mapping[id]).toBe(id === 'sd2.5-301010' ? '30-10-10' : id);
      expect(JSON.parse(channel.supportedModels!)).toContain(id);
      expect(db.select().from(models).where(eq(models.modelId, id)).get()?.provider).toBe('hmstudio');
      expect(list.find(m => m.id === id)).toMatchObject({ available: true, billingType: 'per_call', rates,
        modelStatus: { state: 'unknown', reason: 'insufficient_data' },
        allowedSeconds: Array.from({ length: maxSeconds - 3 }, (_, i) => i + 4) });
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
  it.each(cases)('rejects invalid $id inputs before web/API deductions', async ({ id, images, videos, audios, maxSeconds }) => {
    const beforeUser = db.select().from(users).where(eq(users.id, userId)).get()!.balance;
    const beforeToken = db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get()!.balance;
    const beforeContents = db.select().from(contents).all().length;
    for (const api of [false, true]) {
      const base = { model: id, prompt: '商品展示', resolution: '720p', seconds: 15, video_length: 15 };
      const invalid = [
        { seconds: maxSeconds + 1, video_length: maxSeconds + 1 }, { resolution: '480p' },
        { [api ? 'image_urls' : 'reference_images']: Array(images + 1).fill('https://example.test/image.jpg') },
        { [api ? 'video_urls' : 'reference_videos']: Array(videos + 1).fill('https://example.test/video.mp4') },
        { audio_urls: Array(audios + 1).fill('https://example.test/audio.mp3') },
      ];
      for (const patch of invalid) {
        expect((await post(api ? '/v1/videos' : '/api/video/generate', { ...base, ...patch }, api)).status).toBe(400);
      }
    }
    expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(beforeUser);
    expect(db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get()!.balance).toBe(beforeToken);
    expect(db.select().from(contents).all().length).toBe(beforeContents);
    const invalidBatch = batchInput(id, '720p');
    invalidBatch.video_length = maxSeconds + 1;
    const response = await post('/api/video-batches', { ...invalidBatch, requestKey: crypto.randomUUID(), expectedUnitCost: 0.9 });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(`4-${maxSeconds}`);
    expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(beforeUser);
  });
  it('submits enabled nova through real web/API entry points with resolution-specific reservations', async () => {
    const previousFetch = globalThis.fetch;
    const sent: FormData[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, options: any) => {
      if (String(url).startsWith(origin + '/')) return nativeFetch(url, options);
      sent.push(options.body as FormData);
      return Response.json({ error: '测试：渠道明确拒绝' }, { status: 400 });
    }));
    try {
      for (const api of [false, true]) for (const [resolution, seconds, price] of [['720p', 4, 7], ['1080p', 30, 12]] as const) {
        const beforeUser = db.select().from(users).where(eq(users.id, userId)).get()!.balance;
        const beforeToken = db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get()!.balance;
        const count = sent.length;
        const response = await post(api ? '/v1/videos' : '/api/video/generate', {
          model: 'sd2.5-301010', prompt: '[ref_30] [ref_video_10] [ref_audio_10]',
          seconds, video_length: seconds, resolution,
          reference_images: Array(30).fill('https://example.test/image.jpg'),
          reference_videos: Array(10).fill('https://example.test/video.mp4'), audio_urls: Array(10).fill('https://example.test/audio.mp3'),
          channel: 'lumen',
        }, api);
        expect(response.status).toBe(api ? 202 : 200);
        await response.text();
        await vi.waitFor(() => {
          expect(sent).toHaveLength(count + 1);
          const row = db.select().from(contents).all().at(-1)!;
          expect(row).toMatchObject({ modelId: 'sd2.5-301010', status: 'failed', cost: 0 });
          expect(JSON.parse(row.metadata!)).toMatchObject({ billingStatus: 'refunded', refundAmount: price });
        });
        expect(sent.at(-1)!.get('model')).toBe('30-10-10');
        expect(sent.at(-1)!.get('channel')).toBe('nova');
        expect(JSON.parse(String(sent.at(-1)!.get('materials')))).toHaveLength(50);
        const submittedImages = JSON.parse(String(sent.at(-1)!.get('materials'))).filter((v: any) => v.type === 'image');
        expect(submittedImages.every((v: any) => v.url.startsWith(origin + '/reference-assets/'))).toBe(true);
        const record = db.select().from(contents).all().at(-1)!;
        expect(JSON.parse(record.metadata!).reference_images).toEqual(submittedImages.map((v: any) => v.url));
        const publicResponse = await nativeFetch(submittedImages[0].url);
        expect(publicResponse.status).toBe(200);
        expect(Buffer.from(await publicResponse.arrayBuffer())).toEqual(referencePng);
        expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(beforeUser);
        expect(db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get()!.balance).toBe(beforeToken);
      }
    } finally { vi.stubGlobal('fetch', previousFetch); }
  });
  it.each(['图片下载失败（HTTP 404）', '图片下载超时', '<html>not an image</html>'])('blocks web/API and entire batch before any charge or generation: %s', async failure => {
    const beforeUser = db.select().from(users).where(eq(users.id, userId)).get()!.balance;
    const beforeToken = db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get()!.balance;
    const beforeContents = db.select().from(contents).all().length;
    const reservations = sqlite.prepare('SELECT count(*) AS n FROM billing_reservations').get();
    const batches = sqlite.prepare('SELECT count(*) AS n FROM video_batches').get();
    const fetchCalls = vi.mocked(fetch).mock.calls.length;
    vi.mocked(downloadPublicReferenceImage).mockImplementation(async () => {
      expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(beforeUser);
      expect(db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get()!.balance).toBe(beforeToken);
      expect(db.select().from(contents).all()).toHaveLength(beforeContents);
      if (failure.startsWith('<')) return Buffer.from(failure);
      throw new Error(failure);
    });
    try {
      for (const api of [false, true]) {
        const response = await post(api ? '/v1/videos' : '/api/video/generate', { model: 'sd2.5-301010', prompt: '商品', seconds: 4, video_length: 4, resolution: '720p', reference_images: ['https://f.juicey.dev/f/bad.png?signature=hidden'] }, api);
        expect(response.status).toBe(400);
        const text = await response.text(); expect(text).toContain('参考图 1'); expect(text).not.toContain('hidden');
      }
      const input = batchInput('sd2.5-301010', '720p');
      input.creatives = [{ prompt: 'valid no image', count: 2, reference_images: [] }, { prompt: 'bad image', count: 20, reference_images: ['https://f.juicey.dev/f/bad.png'] }];
      const response = await post('/api/video-batches', { ...input, requestKey: crypto.randomUUID(), expectedUnitCost: 7 });
      expect(response.status).toBe(400); expect(await response.text()).toContain('创意 2');
      expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(beforeUser);
      expect(db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get()!.balance).toBe(beforeToken);
      expect(db.select().from(contents).all()).toHaveLength(beforeContents);
      expect(sqlite.prepare('SELECT count(*) AS n FROM billing_reservations').get()).toEqual(reservations);
      expect(sqlite.prepare('SELECT count(*) AS n FROM video_batches').get()).toEqual(batches);
      expect(vi.mocked(fetch).mock.calls.slice(fetchCalls).every(([url]) => String(url).startsWith(origin + '/'))).toBe(true);
    } finally { vi.mocked(downloadPublicReferenceImage).mockResolvedValue(referencePng); }
  });
  it('persists batch preflight images and a later dispatch does not re-download the expired source', async () => {
    const input = batchInput('sd2.5-301010', '720p');
    input.creatives[0].reference_images = ['https://f.juicey.dev/f/temporary.png'];
    const before = db.select().from(users).where(eq(users.id, userId)).get()!.balance;
    const calls = vi.mocked(downloadPublicReferenceImage).mock.calls.length;
    const response = await post('/api/video-batches', { ...input, requestKey: crypto.randomUUID(), expectedUnitCost: 7 });
    expect(response.status).toBe(200);
    const batch = await response.json() as any;
    const payload = JSON.parse((sqlite.prepare('SELECT payload FROM video_batches WHERE id=?').get(batch.id) as any).payload);
    const images = payload.creatives[0].reference_images;
    expect(images[0]).toMatch(/\/reference-assets\/.*\.png$/);
    expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(before - 140);
    vi.mocked(downloadPublicReferenceImage).mockRejectedValue(new Error('expired'));
    try {
      const item = batchStore.claim(batch.items[0].id)!;
      const context = batchStore.context(item.id, item.attempts, userId);
      expect(context.body.reference_images).toEqual(images);
      const check = await post('/api/video/validate', context.body);
      expect(check.status).toBe(200);
      expect((await check.json() as any).reference_images).toEqual(images);
      expect(vi.mocked(downloadPublicReferenceImage).mock.calls.length).toBe(calls + 1);
      batchStore.fail(item.id, 'test cleanup', true, true);
      await post(`/api/video-batches/${batch.id}/cancel-pending`, {});
    } finally { vi.mocked(downloadPublicReferenceImage).mockResolvedValue(referencePng); }
  });
  it('preflights manually retried HM batches before new charges, then persists images and charges once', async () => {
    const input = batchInput('sd2.5-301010', '720p'); input.autoRetry = false;
    input.creatives = [{ prompt: 'legacy batch', count: 2, reference_images: ['https://f.juicey.dev/f/legacy.png'] }];
    const before = db.select().from(users).where(eq(users.id, userId)).get()!.balance;
    const id = batchStore.create(userId, crypto.randomUUID(), input, 7, origin);
    for (const item of batchStore.detail(id, userId).items) {
      batchStore.claim(item.id); batchStore.fail(item.id, 'explicit rejection', true, true);
    }
    expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(before);
    vi.mocked(downloadPublicReferenceImage).mockRejectedValue(new Error('图片下载失败（HTTP 404）'));
    try {
      const response = await post(`/api/video-batches/${id}/retry-failed`, { requestKey: crypto.randomUUID() });
      expect(response.status).toBe(400); expect(await response.text()).toContain('HTTP 404');
      expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(before);
      expect(batchStore.detail(id, userId).items.every(i => i.billing_state === 'refunded')).toBe(true);
      vi.mocked(downloadPublicReferenceImage).mockResolvedValue(referencePng);
      const requestKey = crypto.randomUUID();
      const responses = await Promise.all([post(`/api/video-batches/${id}/retry-failed`, { requestKey }), post(`/api/video-batches/${id}/retry-failed`, { requestKey })]);
      expect(responses.map(r => r.status)).toEqual([200, 200]);
      expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(before - 14);
      const payload = JSON.parse((sqlite.prepare('SELECT payload FROM video_batches WHERE id=?').get(id) as any).payload);
      expect(payload.creatives[0].reference_images[0]).toMatch(/\/reference-assets\/.*\.png$/);
      // An already applied command stays idempotent even if downloads later fail.
      vi.mocked(downloadPublicReferenceImage).mockRejectedValue(new Error('expired'));
      expect((await post(`/api/video-batches/${id}/retry-failed`, { requestKey })).status).toBe(200);
      expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(before - 14);
      await post(`/api/video-batches/${id}/cancel-pending`, {});
    } finally { vi.mocked(downloadPublicReferenceImage).mockResolvedValue(referencePng); }
  });
  it('blocks HM specification web/API/batch paths before charging and sends durable images after success', async () => {
    const channel = db.select().from(channels).where(eq(channels.type, 'hmstudio')).get()!;
    const modelId = 'hm-reference-spec-test';
    const old = db.select().from(settings).where(eq(settings.key, 'model_specification_routes_v1')).get();
    db.insert(models).values({ modelId, displayName: modelId, provider: 'routing', capabilities: '["video"]', isActive: 1 }).run();
    db.insert(modelPricing).values({ modelPattern: modelId, billingType: 'per_call', inputPrice: 7 }).run();
    const limits = { ...defaultRoutingLimits(), maxImages: 30 };
    saveModelSpecification({ modelId, kind: 'video', enabled: true, aliases: [], limits, routes: [{ id: 'hm-ref', channelId: channel.id,
      executionModel: 'sd2.5-301010', upstreamModel: '30-10-10', enabled: true, limits, cost: 4, costUnit: 'per_call', resolutionCosts: {}, priority: 0 }] });
    const before = db.select().from(users).where(eq(users.id, userId)).get()!.balance;
    const tokenBefore = db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get()!.balance;
    const count = db.select().from(contents).all().length;
    vi.mocked(downloadPublicReferenceImage).mockRejectedValue(new Error('图片下载失败（HTTP 404）'));
    try {
      for (const api of [false, true]) {
        const response = await post(api ? '/v1/videos' : '/api/video/generate', { model: modelId, prompt: '商品', seconds: 4, video_length: 4, resolution: '720p', reference_images: ['https://external.example/missing.png'] }, api);
        expect(response.status).toBe(400); expect(await response.text()).toContain('HTTP 404');
      }
      const input = batchInput(modelId, '720p'); input.creatives[0].reference_images = ['https://external.example/missing.png'];
      const response = await post('/api/video-batches', { ...input, requestKey: crypto.randomUUID(), expectedUnitCost: 7 });
      expect(response.status).toBe(400); expect(await response.text()).toContain('HTTP 404');
      expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(before);
      expect(db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get()!.balance).toBe(tokenBefore);
      expect(db.select().from(contents).all()).toHaveLength(count);
      vi.mocked(downloadPublicReferenceImage).mockResolvedValue(referencePng);
      const previousFetch = globalThis.fetch;
      const sent: FormData[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: any, options: any) => {
        if (String(url).startsWith(origin + '/')) return nativeFetch(url, options);
        sent.push(options.body as FormData);
        return Response.json({ error: '测试明确拒绝' }, { status: 400 });
      }));
      try {
        for (const api of [false, true]) {
          const response = await post(api ? '/v1/videos' : '/api/video/generate', { model: modelId, prompt: '商品', seconds: 4, video_length: 4, resolution: '720p', reference_images: ['https://external.example/valid.png'] }, api);
          expect(response.status).toBeLessThan(300); await response.text();
          await vi.waitFor(() => expect(db.select().from(contents).all().at(-1)!.status).toBe('failed'));
          const refs = JSON.parse(String(sent.at(-1)!.get('materials')));
          expect(refs[0].url).toMatch(/\/reference-assets\/.*\.png$/);
          expect(JSON.parse(db.select().from(contents).all().at(-1)!.metadata!).reference_images).toEqual([refs[0].url]);
        }
        expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(before);
        expect(db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get()!.balance).toBe(tokenBefore);
      } finally { vi.stubGlobal('fetch', previousFetch); }
    } finally {
      vi.mocked(downloadPublicReferenceImage).mockResolvedValue(referencePng);
      if (old) db.update(settings).set({ value: old.value }).where(eq(settings.key, old.key)).run();
      else db.delete(settings).where(eq(settings.key, 'model_specification_routes_v1')).run();
    }
  });
  it('preserves administrator price overrides across startup', async () => {
    db.update(modelPricing).set({ inputPrice: 2, extraParams: JSON.stringify({ category: 'video', '720p': 2, '1080p': 3, '2k': 4 }) })
      .where(eq(modelPricing.modelPattern, 'SD2.0FAST803')).run();
    db.update(modelPricing).set({ inputPrice: 9, extraParams: JSON.stringify({ category: 'video', '720p': 9, '1080p': 14 }) })
      .where(eq(modelPricing.modelPattern, 'sd2.5-301010')).run();
    await initDatabase();
    expect(PricingService.quote('SD2.0FAST803', { resolution: '2k' }, false).cost).toBe(4);
    expect(PricingService.quote('sd2.5-301010', { resolution: '1080p', seconds: 30 }, false).cost).toBe(14);
    expect(db.select().from(models).where(eq(models.modelId, 'sd2.5-301010')).get()?.isActive).toBe(1);
    db.update(models).set({ isActive: 0 }).where(eq(models.modelId, 'sd2.5-301010')).run();
    await initDatabase();
    expect(db.select().from(models).where(eq(models.modelId, 'sd2.5-301010')).get()?.isActive).toBe(0);
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

describe('HM administrator sync → pricing → real quote workflow', () => {
  let channelId: number;
  let responseBody: any;
  let previousFetch: typeof fetch;
  beforeEach(() => {
    sqlite.exec('SAVEPOINT hm_catalog_sync');
    channelId = db.select().from(channels).where(eq(channels.type, 'hmstudio')).get()!.id;
    responseBody = { data: [{ id: '30-10-10', price: 4 }, { id: 'SD2.0FAST803' },
      { id: 'SD2.0MINI503' }, { id: 'MINIMAX-H3-2.5采样' }, { id: 'sd2.5-301010' }] };
    previousFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: any, options: any) => {
      if (String(url).startsWith(origin + '/')) return nativeFetch(url, options);
      expect(String(url)).toMatch(/\/v1\/models$/);
      return Response.json(responseBody);
    }));
  });
  afterEach(() => {
    vi.stubGlobal('fetch', previousFetch);
    sqlite.exec('ROLLBACK TO hm_catalog_sync; RELEASE hm_catalog_sync');
  });
  const sync = () => post(`/api/admin/channels/${channelId}/sync-models`, {});
  const readPrice = async (id: string) => (await (await nativeFetch(
    origin + '/api/admin/pricing?modelId=' + encodeURIComponent(id),
    { headers: { Authorization: 'Bearer ' + userJwt } },
  )).json() as any[])[0];
  it('normalizes upstream IDs on the actual sync endpoint and saves both prices through the admin endpoint', async () => {
    db.delete(modelPricing).where(eq(modelPricing.modelPattern, 'sd2.5-301010')).run();
    db.delete(models).where(eq(models.modelId, 'sd2.5-301010')).run();
    const result = await sync();
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ count: 4, added: 1,
      models: ['sd2.5-301010', 'SD2.0FAST803', 'SD2.0MINI503', 'seedance_v2.5'] });
    expect(db.select().from(models).where(eq(models.modelId, '30-10-10')).get()).toBeUndefined();
    const nova = db.select().from(models).where(eq(models.modelId, 'sd2.5-301010')).get()!;
    expect(nova).toMatchObject({ isActive: 0, capabilities: '["video"]' });
    const channel = db.select().from(channels).where(eq(channels.id, channelId)).get()!;
    expect(JSON.parse(channel.modelMapping!)).toMatchObject({ 'sd2.5-301010': '30-10-10', 'seedance_v2.5': 'MINIMAX-H3-2.5采样' });
    const price = await readPrice('sd2.5-301010');
    expect(price).toMatchObject({ inputPrice: 7, category: 'video', extraParams: { '720p': 7, '1080p': 12 } });
    const saved = await nativeFetch(origin + '/api/admin/pricing/' + price.id, {
      method: 'PUT', headers: { Authorization: 'Bearer ' + userJwt, 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelPattern: 'sd2.5-301010', billingType: 'per_call', inputPrice: 8,
        outputPrice: 0, extraParams: { category: 'video', '720p': 8, '1080p': 13 } }),
    });
    expect(saved.status).toBe(200);
    db.update(models).set({ isActive: 1 }).where(eq(models.id, nova.id)).run();
    for (const [resolution, cost] of [['720p', 8], ['1080p', 13]] as const) {
      const quote = await post('/api/video/validate', { model: 'sd2.5-301010', prompt: '测试', resolution, video_length: 30 });
      expect(quote.status).toBe(200);
      expect(await quote.json()).toMatchObject({ unitCost: cost });
    }
    expect((await sync()).status).toBe(200);
    expect(await readPrice('sd2.5-301010')).toMatchObject({ inputPrice: 8, extraParams: { '720p': 8, '1080p': 13 }, modelActive: true });
    // A model imported through sync must reach the same nova adapter and reservation path.
    const sent: FormData[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, options: any) => {
      if (String(url).startsWith(origin + '/')) return nativeFetch(url, options);
      sent.push(options.body);
      return Response.json({ error: '测试：渠道明确拒绝' }, { status: 400 });
    }));
    const balanceBefore = db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get()!.balance;
    const submitted = await post('/v1/videos', { model: 'sd2.5-301010', prompt: '同步后生成测试', resolution: '1080p', seconds: 30 }, true);
    expect(submitted.status).toBe(202);
    await submitted.text();
    await vi.waitFor(() => {
      const row = db.select().from(contents).all().at(-1)!;
      expect(row.status).toBe('failed');
      expect(JSON.parse(row.metadata!)).toMatchObject({ billingStatus: 'refunded', refundAmount: 13 });
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].get('model')).toBe('30-10-10');
    expect(sent[0].get('channel')).toBe('nova');
    expect(db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get()!.balance).toBe(balanceBefore);
  });
  it('retains both legacy and canonical administrator prices, permissions and history on conflicts', async () => {
    const old = db.insert(models).values({ modelId: '30-10-10', displayName: '旧名称', provider: 'hmstudio', isActive: 1 }).returning().get();
    db.insert(modelPricing).values({ modelPattern: '30-10-10', inputPrice: 20, extraParams: '{"1080p":25}' }).run();
    const permission = db.insert(tierModelAccess).values({ tierId: 1, modelId: old.id }).returning().get();
    const userPrice = db.insert(userModelPricing).values({ userId, modelId: old.id,
      billingType: 'per_call', inputPrice: 18, outputPrice: 0, updatedBy: userId }).returning().get();
    const history = db.insert(contents).values({ userId, type: 'video', modelId: '30-10-10',
      status: 'completed', cost: 20, resultUrl: '/old-video.mp4' }).returning().get();
    const canonicalBefore = await readPrice('sd2.5-301010');
    const result = await (await sync()).json() as any;
    expect(result.warnings.join(' ')).toContain('两份价格均未覆盖');
    expect(result.models).not.toContain('30-10-10');
    expect(db.select().from(models).where(eq(models.id, old.id)).get()).toEqual(old);
    expect(await readPrice('30-10-10')).toMatchObject({ inputPrice: 20, extraParams: { '1080p': 25 } });
    expect(await readPrice('sd2.5-301010')).toEqual(canonicalBefore);
    expect(db.select().from(tierModelAccess).where(eq(tierModelAccess.id, permission.id)).get()).toEqual(permission);
    expect(db.select().from(userModelPricing).where(eq(userModelPricing.id, userPrice.id)).get()).toEqual(userPrice);
    expect(db.select().from(contents).where(eq(contents.id, history.id)).get()).toEqual(history);
  });
  it('copies a legacy retail rule only when the canonical rule is absent and preserves its fallback', async () => {
    db.insert(models).values({ modelId: '30-10-10', displayName: '旧名称', provider: 'hmstudio', isActive: 0 }).run();
    db.insert(modelPricing).values({ modelPattern: '30-10-10', inputPrice: 9, extraParams: '{"category":"video"}' }).run();
    db.delete(modelPricing).where(eq(modelPricing.modelPattern, 'sd2.5-301010')).run();
    expect((await sync()).status).toBe(200);
    expect(await readPrice('sd2.5-301010')).toMatchObject({ inputPrice: 9, extraParams: { category: 'video' } });
    expect(PricingService.quote('sd2.5-301010', { resolution: '1080p' }, false).cost).toBe(9);
    expect(await readPrice('30-10-10')).toMatchObject({ inputPrice: 9 });
  });
  it.each([null, {}, { data: [null] }, { data: [{ id: 'new-model' }, {}] }])('rejects malformed catalogs without replacing existing bindings: %j', async body => {
    responseBody = body;
    const before = db.select().from(channels).where(eq(channels.id, channelId)).get();
    expect((await sync()).status).toBe(502);
    expect(db.select().from(channels).where(eq(channels.id, channelId)).get()).toEqual(before);
    expect(db.select().from(models).where(eq(models.modelId, 'new-model')).get()).toBeUndefined();
  });
  it('rolls back the entire sync on a known public ID owned by another provider', async () => {
    responseBody = { data: ['new-hm-model', '30-10-10'] };
    db.update(models).set({ provider: 'another-provider' }).where(eq(models.modelId, 'sd2.5-301010')).run();
    const before = db.select().from(channels).where(eq(channels.id, channelId)).get();
    expect((await sync()).status).toBe(409);
    expect(db.select().from(models).where(eq(models.modelId, 'new-hm-model')).get()).toBeUndefined();
    expect(db.select().from(channels).where(eq(channels.id, channelId)).get()).toEqual(before);
  });
  it('does not apply HM aliases or retail pricing to another provider', async () => {
    const other = db.insert(channels).values({ name: 'Other', type: 'openai', baseUrl: 'https://example.test', apiKey: 'test', supportedModels: '[]' }).returning().get();
    responseBody = { data: ['30-10-10'] };
    const response = await post(`/api/admin/channels/${other.id}/sync-models`, {});
    expect(await response.json()).toMatchObject({ models: ['30-10-10'] });
    expect(db.select().from(models).where(eq(models.modelId, '30-10-10')).get()?.provider).toBe('openai');
    expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern, '30-10-10')).get()).toBeUndefined();
  });
});
