import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureH264Video } from '../server/services/videoCompatibilityService.js';

vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { getTableConfig, SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core');
  const schema = await import('../server/db/schema');
  const sqlite = new Database(':memory:');
  const dialect = new SQLiteSyncDialect();
  for (const table of Object.values(schema)) {
    const config = getTableConfig(table as any);
    const columns = config.columns.map(c => {
      let def = '';
      if (c.default !== undefined) {
        const value = typeof c.default === 'object' ? dialect.sqlToQuery(c.default as any).sql
          : typeof c.default === 'string' ? "'" + c.default.replace(/'/g, "''") + "'" : String(c.default);
        def = ' DEFAULT ' + value;
      }
      return '"' + c.name + '" ' + c.getSQLType() + (c.primary ? ' PRIMARY KEY' : '') + def;
    });
    sqlite.exec('CREATE TABLE "' + config.name + '" (' + columns.join(',') + ')');
  }
  return { sqlite, db: drizzle(sqlite, { schema }) };
});
vi.mock('../server/config/env.js', () => ({ env: { NODE_ENV: 'test', JWT_SECRET: 'test', VIDEO_TASK_POLL_TIMEOUT_MS: 1, PORT: 9876 } }));
vi.mock('../server/middleware/auth.js', () => ({ authMiddleware: (req: any, _res: any, next: any) => { req.userId = 1; next(); } }));
vi.mock('../server/middleware/tier.js', () => ({ tierMiddleware: () => (_req: any, _res: any, next: any) => next() }));
vi.mock('../server/middleware/quota.js', () => ({ quotaMiddleware: (_req: any, _res: any, next: any) => next(), logUsage: vi.fn() }));
vi.mock('../server/services/tokenService.js', () => ({ TokenService: {
  validateToken: () => ({ valid: true, token: { id: 1, userId: 1, balance: -1, allowedModels: [], tokenKey: 'test' } }),
  deductBalance: vi.fn(), refundBalance: vi.fn(),
} }));
vi.mock('../server/services/balanceService.js', async () => {
  const { sqlite } = await import('../server/db/index.js');
  return { BalanceService: {
    checkBalance: () => ({ sufficient: true, balance: 100 }),
    deductWithSource: (_id: number, amount: number) => {
      sqlite.prepare('UPDATE users SET balance=balance-? WHERE id=1').run(amount);
      return { source: 'user', balance: 100 - amount };
    },
    deduct: () => { throw new Error('Unexpected second deduction'); },
    refundToSource: (_id: number, amount: number) => { sqlite.prepare('UPDATE users SET balance=balance+? WHERE id=1').run(amount); },
  } };
});
vi.mock('../server/services/contentService.js', async () => {
  const { db } = await import('../server/db/index.js'); const { contents } = await import('../server/db/schema');
  return { ContentService: { save: (input: any) => Number(db.insert(contents).values({ ...input, metadata: JSON.stringify(input.metadata) }).run().lastInsertRowid) } };
});
vi.mock('../server/services/videoLocalizationService.js', () => ({ downloadAndLocalizeVideo: vi.fn(async () => '/uploads/videos/haya-test.mp4'), preferredVideoDownloadPath: (p: string) => p }));

import { db, sqlite } from '../server/db/index';
import { channels, models, modelPricing, users, contents } from '../server/db/schema';
import { HAYA_VIDEO_MODELS, HAYA_MODEL_IDS } from '../shared/hayaVideo';
import { ChannelService } from '../server/services/channelService';
import { VideoRecoveryService } from '../server/services/videoRecoveryService';
import { PricingService } from '../server/services/pricingService';

let video: typeof import('../server/routes/video');
let server: Server;
let origin: string;
const nativeFetch = globalThis.fetch;
const nativeSetTimeout = globalThis.setTimeout;
const intervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => ({ unref() {} }) as any);
const balance = () => (sqlite.prepare('SELECT balance FROM users WHERE id=1').get() as any).balance;
const latest = () => db.select().from(contents).all().at(-1)!;
let upstream: (url: string, options: any) => Promise<Response>;

beforeAll(async () => {
  video = await import('../server/routes/video');
  const v1 = await import('../server/routes/v1');
  const app = express(); app.use(express.json()); app.use('/api/video', video.default); app.use('/v1', v1.default);
  server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  intervalSpy.mockRestore();
});
beforeEach(() => {
  for (const table of ['contents', 'channels', 'models', 'model_pricing', 'users', 'api_logs']) sqlite.exec('DELETE FROM ' + table);
  db.insert(users).values({ id: 1, email: 'test', username: 'test', passwordHash: 'test', balance: 100 }).run();
  for (const spec of HAYA_VIDEO_MODELS) {
    db.insert(models).values({ modelId: spec.id, displayName: spec.id, provider: 'haya', capabilities: '["video"]' }).run();
    db.insert(modelPricing).values({ modelPattern: spec.id, billingType: spec.billingType, inputPrice: spec.price }).run();
  }
  ChannelService.createChannel({ name: 'Haya test', type: 'haya', baseUrl: 'https://hayaai.fun/v1', apiKey: 'test-key' });
  upstream = async () => { throw new Error('Unexpected upstream request'); };
  vi.stubGlobal('fetch', vi.fn((url: string, options: any) => upstream(String(url), options)));
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms: number, ...args: any[]) => nativeSetTimeout(fn, ms >= 12_000 && ms <= 60_000 ? 5 : ms, ...args)) as any);
});
afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); sqlite.close(); });

async function post(endpoint: string, body: any) {
  return nativeFetch(origin + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' }, body: JSON.stringify(body) });
}
const body = { model: HAYA_MODEL_IDS[0], prompt: '电影感产品展示', video_length: 6, resolution: '720p', aspect_ratio: '16:9' };

describe('Haya in both application entry points (isolated in-memory database)', () => {
  it('prefers H.264 in the content API and falls back to valid HEVC on conversion failure without charging', async () => {
    const root = path.resolve('data/uploads');
    fs.mkdirSync(root, { recursive: true });
    const directory = fs.mkdtempSync(path.join(root, 'h264-api-test-'));
    try {
      const source = path.join(directory, 'historical.mp4');
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=64x64:r=5:d=0.4',
        '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-threads', '1', '-x265-params',
        'pools=1:frame-threads=1:log-level=error', source], { stdio: 'pipe' });
      fs.copyFileSync(source, path.join(directory, 'historical.original.mp4'));
      db.insert(contents).values({ userId: 1, type: 'video', status: 'completed',
        resultUrl: `/uploads/${path.basename(directory)}/historical.mp4`, modelId: HAYA_MODEL_IDS[0], cost: 1 }).run();
      const endpoint = `${origin}/v1/videos/task_${latest().id}/content`;
      const task = await (await nativeFetch(`${origin}/v1/videos/task_${latest().id}`, { headers: { Authorization: 'Bearer test' } })).json() as any;
      expect(task.url).toBe(endpoint);
      expect(task.result_url).toBe(endpoint);
      const anonymous = await nativeFetch(endpoint);
      expect(anonymous.status).toBe(200);
      await anonymous.arrayBuffer();
      const oldSigned = await nativeFetch(endpoint + '?expires=1&signature=expired');
      expect(oldSigned.status).toBe(200);
      await oldSigned.arrayBuffer();
      const head = await nativeFetch(endpoint, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-type')).toBe('video/mp4');
      expect((await nativeFetch(`${origin}/v1/videos/task_${latest().id}`)).status).toBe(401);
      const response = await nativeFetch(endpoint, { headers: { Authorization: 'Bearer test', Range: 'bytes=0-127' } });
      expect(response.status).toBe(206);
      expect(response.headers.get('content-type')).toBe('video/mp4');
      const compatible = await ensureH264Video(source);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(fs.readFileSync(compatible).subarray(0, 128));
      expect(compatible).not.toContain('.original.');
      fs.unlinkSync(compatible);
      fs.mkdirSync(compatible); // fail conversion publishing, leaving source intact
      const fallback = await nativeFetch(endpoint, { headers: { Authorization: 'Bearer test' } });
      expect(fallback.status).toBe(200);
      expect(Buffer.from(await fallback.arrayBuffer())).toEqual(fs.readFileSync(source));
      // Probe failure must be handled by the API, not fall back to the original.
      fs.writeFileSync(source, 'broken source');
      expect((await nativeFetch(endpoint, { headers: { Authorization: 'Bearer test' } })).status).toBe(502);
      expect(balance()).toBe(100);
      expect(fetch).not.toHaveBeenCalled();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it('does not expose failed/pending tasks or non-video assets through public content URLs', async () => {
    for (const input of [{ type: 'video', status: 'processing' }, { type: 'video', status: 'failed' }, { type: 'image', status: 'completed' }]) {
      db.insert(contents).values({ userId: 1, ...input, resultUrl: '/uploads/private.mp4' }).run();
      const response = await nativeFetch(`${origin}/v1/videos/task_${latest().id}/content`);
      expect(response.status).toBe(404);
    }
    expect((await nativeFetch(`${origin}/v1/videos/task_1junk/content`)).status).toBe(404);
  });
  it('discovers only TTS models actually advertised upstream and preserves them on authentication failure', async () => {
    const { env } = await import('../server/config/env');
    const previousKey = env.GEMINI_API_KEY;
    env.GEMINI_API_KEY = 'test-only';
    try {
      upstream = async () => Response.json({ data: [{ id: 'gemini-upstream-only-tts' }] });
      const { syncModelsFromAPI } = await import('../server/db/seed');
      await syncModelsFromAPI();
      const listedTts = () => db.select().from(models).all().filter(m => m.modelId.includes('tts')).map(m => m.modelId);
      expect(listedTts()).toEqual(['gemini-upstream-only-tts']);
      upstream = async () => new Response('', { status: 401 });
      await syncModelsFromAPI();
      expect(listedTts()).toEqual(['gemini-upstream-only-tts']);
    } finally { env.GEMINI_API_KEY = previousKey; }
  });
  it('classifies synchronized TTS models and repairs old text classification without enabling disabled models', async () => {
    const channel = ChannelService.createChannel({ name: 'AIStudio2API test', type: 'gemini', baseUrl: 'https://tts.invalid', apiKey: 'test-key' });
    db.insert(models).values({ modelId: 'gemini-3.8-flash-tts', displayName: 'Custom name', provider: 'google', capabilities: '["text"]', isActive: 0 }).run();
    upstream = async () => Response.json({ data: [{ id: 'gemini-3.8-flash-tts' }, { id: 'new-tts' }] });
    await ChannelService.syncModels(channel);
    const rows = db.select().from(models).all();
    expect(rows.find(m => m.modelId === 'gemini-3.8-flash-tts')).toMatchObject({ capabilities: '["tts"]', isActive: 0, displayName: 'Custom name' });
    expect(rows.find(m => m.modelId === 'new-tts')?.capabilities).toBe('["tts"]');
  });
  it('seeds all seven models even when unrelated upstream discovery is unavailable', async () => {
    sqlite.exec('DELETE FROM models');
    const { syncModelsFromAPI } = await import('../server/db/seed');
    await syncModelsFromAPI();
    expect(db.select().from(models).all().filter(m => m.provider === 'haya').map(m => m.modelId)).toEqual(HAYA_MODEL_IDS);
    expect(db.select().from(models).all().filter(m => m.modelId.includes('tts'))).toEqual([]);
    await syncModelsFromAPI();
    expect(db.select().from(models).all().filter(m => m.provider === 'haya')).toHaveLength(7);
  });
  it('lists the exact resolution, duration and price for every model', async () => {
    const listed = await (await nativeFetch(origin + '/api/video/models')).json() as any[];
    expect(listed).toHaveLength(7);
    for (const spec of HAYA_VIDEO_MODELS) {
      expect(listed.find(m => m.id === spec.id)).toMatchObject({ rates: { [spec.resolution]: spec.price }, billingType: spec.billingType,
        allowedSeconds: Array.from({ length: 27 }, (_, i) => i + 4) });
    }
  });
  it('registers channel defaults, quotes markup, and discovers only the requested live models', async () => {
    expect(ChannelService.findChannelForModel(HAYA_MODEL_IDS[0])?.type).toBe('haya');
    expect(PricingService.quote(HAYA_MODEL_IDS[3], { seconds: 30 }, false).cost).toBe(15);
    expect(PricingService.quote(HAYA_MODEL_IDS[4], { seconds: 30 }, false).cost).toBe(13);
    upstream = async () => Response.json({ data: [{ id: HAYA_MODEL_IDS[0] }, { id: 'text-model' }] });
    const result = await ChannelService.syncModels(db.select().from(channels).get()!.id);
    expect(result.models).toEqual([HAYA_MODEL_IDS[0]]);
    expect(ChannelService.findChannelForModel(HAYA_MODEL_IDS[1])).toBeNull();
    const listed = await (await nativeFetch(origin + '/api/video/models')).json() as any[];
    expect(listed[0]).toMatchObject({ id: HAYA_MODEL_IDS[0], rates: { '720p': 6.5 }, billingType: 'per_call' });
  });
  it('rejects Y video references and wrong resolution before charging or submitting', async () => {
    const response = await post('/api/video/generate', { ...body, model: 'y-seedance-2.5-720p', reference_videos: ['https://example.com/v.mp4'] });
    expect(response.status).toBe(400); expect(balance()).toBe(100); expect(fetch).not.toHaveBeenCalled();
    const api = await post('/v1/videos', { model: HAYA_MODEL_IDS[1], prompt: body.prompt, resolution: '1080p' });
    expect(api.status).toBe(400); expect(fetch).not.toHaveBeenCalled();
  });
  it('completes SSE generation, survives a query 503, localizes and charges once', async () => {
    let queries = 0; let submissions = 0;
    upstream = async (url, init) => {
      if (init.method === 'POST') { submissions++; expect(JSON.parse(init.body).model).toBe(body.model); return Response.json({ id: 'task_sse' }); }
      expect(url).toBe('https://hayaai.fun/v1/videos/task_sse');
      if (++queries === 1) return new Response('busy', { status: 503 });
      return Response.json({ status: 'completed', progress: 100, metadata: { url: 'https://media.example/done.mp4?signature=a&expires=3' } });
    };
    const result = await (await post('/api/video/generate', body)).text();
    expect(result).toContain('"type":"complete"'); expect(submissions).toBe(1); expect(queries).toBe(2);
    expect(latest().status).toBe('completed'); expect(balance()).toBe(93.5);
  });
  it.each(['/api/video/generate', '/v1/videos'])('retains unknown submissions at %s and does not refund or resubmit', async endpoint => {
    upstream = async () => { throw new Error('network timeout'); };
    await (await post(endpoint, body)).text();
    expect(latest().status).toBe('review'); expect(balance()).toBe(93.5); expect(fetch).toHaveBeenCalledTimes(1);
    video.resumeAllPendingVideoTasks(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['/api/video/generate', '/v1/videos'])('refunds confirmed rejection at %s', async endpoint => {
    upstream = async () => new Response('余额不足', { status: 402 });
    await (await post(endpoint, body)).text();
    expect(latest().status).toBe('failed'); expect(balance()).toBe(100); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('creates external API tasks, polls beyond the old timeout and settles once', async () => {
    let queries = 0;
    upstream = async (_url, init) => {
      if (init.method === 'POST') return Response.json({ task_id: 'task_api', request_id: 'wrong-id' });
      return Response.json(++queries === 1 ? { status: 'in_progress', progress: 10 } : { status: 'completed', metadata: { url: 'https://media.example/done.mp4' } });
    };
    const response = await post('/v1/videos', { model: HAYA_MODEL_IDS[3], prompt: body.prompt, seconds: 10 });
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(latest().status).toBe('completed'));
    expect(balance()).toBe(95); expect(queries).toBe(2); expect(JSON.parse(latest().metadata).videoId).toBe('task_api');
  });
  it('recovers a reviewed but reserved task without charging a second time', async () => {
    const channelId = db.select().from(channels).get()!.id;
    db.insert(contents).values({ userId: 1, type: 'video', status: 'review', modelId: HAYA_MODEL_IDS[0], cost: 6.5,
      metadata: JSON.stringify({ channelId, videoId: 'task_reserved', hayaSubmissionStarted: 'today', hayaNeedsReview: true }) }).run();
    upstream = async () => Response.json({ status: 'completed', metadata: { url: 'https://media.example/result.mp4' } });
    const recovered = await VideoRecoveryService.recover(latest().id);
    expect(recovered).toMatchObject({ status: 'completed', chargedAmount: 0 }); expect(balance()).toBe(100);
  });
  it('moves interrupted creation without a task ID to review on restart, without POST or refund', () => {
    const channelId = db.select().from(channels).get()!.id;
    db.insert(contents).values({ userId: 1, type: 'video', status: 'processing', modelId: HAYA_MODEL_IDS[0], cost: 6.5,
      metadata: JSON.stringify({ channelId, hayaSubmissionStarted: 'before restart' }) }).run();
    video.resumeAllPendingVideoTasks();
    expect(latest().status).toBe('review'); expect(balance()).toBe(100); expect(fetch).not.toHaveBeenCalled();
  });
});
