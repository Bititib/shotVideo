import { migrateZonghengModelPrefix } from '../server/services/zonghengPrefixMigration';
import { ZONGHENG_VIDEO_MODELS } from '../shared/zonghengVideo';
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
      return '"' + c.name + '" ' + c.getSQLType() + (c.primary ? ' PRIMARY KEY' : c.isUnique ? ' UNIQUE' : '') + def;
    });
    sqlite.exec('CREATE TABLE "' + config.name + '" (' + columns.join(',') + ')');
  }
  return { sqlite, db: drizzle(sqlite, { schema }) };
});
vi.mock('../server/config/env.js', () => ({ env: { NODE_ENV: 'test', JWT_SECRET: 'test', VIDEO_TASK_POLL_TIMEOUT_MS: 1, PORT: 9876 } }));
vi.mock('../server/middleware/auth.js', () => ({ authMiddleware: (req: any, _res: any, next: any) => { req.userId = 1; next(); }, optionalAuthMiddleware: (_req: any, _res: any, next: any) => next() }));
vi.mock('../server/middleware/tier.js', () => ({ tierMiddleware: () => (_req: any, _res: any, next: any) => next() }));
vi.mock('../server/middleware/quota.js', () => ({ quotaMiddleware: (_req: any, _res: any, next: any) => next(), logUsage: vi.fn() }));
vi.mock('../server/services/tokenService.js', () => ({ TokenService: {
  validateToken: () => ({ valid: true, token: { id: 1, userId: 1, balance: -1, allowedModels: [], tokenKey: 'test' } }),
  deductBalance: vi.fn(), refundBalance: vi.fn(),
} }));
vi.mock('../server/services/balanceService.js', async () => {
  const { sqlite } = await import('../server/db/index.js');
  return { BalanceService: {
    getBalance: () => (sqlite.prepare('SELECT balance FROM users WHERE id=1').get()).balance,
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
vi.mock('../server/services/videoLocalizationService.js', () => ({ downloadAndLocalizeVideo: vi.fn(async () => '/uploads/videos/zongheng-test.mp4'), preferredVideoDownloadPath: (p: string) => p }));


import { db, sqlite } from '../server/db/index';
import { channels, models, modelPricing, users, contents } from '../server/db/schema';
import { ChannelService } from '../server/services/channelService';
import { findVideoSubmissionReceipt } from '../server/services/videoSubmissionReceiptService';
import { VideoRecoveryService as ContentRecoveryService } from '../server/services/videoRecoveryService';
let video: typeof import('../server/routes/video');
let server: Server, origin: string;
const nativeFetch=globalThis.fetch, nativeSetTimeout=globalThis.setTimeout;
const intervalSpy=vi.spyOn(globalThis,'setInterval').mockImplementation(()=>({unref(){}}) as any);
const balance=()=>(sqlite.prepare('SELECT balance FROM users WHERE id=1').get() as any).balance;
const latest=()=>db.select().from(contents).all().at(-1)!;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8XcAAAAASUVORK5CYII=','base64');
let reference:string;
let upstream:(url:string,init:any)=>Promise<Response>;
beforeAll(async()=>{
  const sharp=(await import('sharp')).default;
  reference='data:image/png;base64,'+(await sharp({create:{width:300,height:300,channels:3,background:'#ffffff'}}).png().toBuffer()).toString('base64');
  video=await import('../server/routes/video');
  const v1=await import('../server/routes/v1'), image=await import('../server/routes/imageGen');
  const app=express(); app.use(express.json({limit:'5mb'}));app.use('/api/video',video.default);app.use('/api/image-gen',image.default);app.use('/v1',v1.default);
  server=await new Promise<Server>(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});origin='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  intervalSpy.mockRestore();
});
beforeEach(()=>{
  findVideoSubmissionReceipt(1); sqlite.exec('DELETE FROM video_submission_receipts');
  for(const table of ['contents','channels','models','model_pricing','users','api_tokens','api_logs','settings'])sqlite.exec('DELETE FROM '+table);
  sqlite.exec('DROP TABLE IF EXISTS billing_reservations');
  db.insert(users).values({id:1,email:'test',username:'test',passwordHash:'test',balance:100}).run();
  for(const [id,kind] of [['ZH-video-public','video'],['ZH-image-public','image'],['ZH-gpt-public','text']]){
    db.insert(models).values({modelId:id,displayName:id,provider:'zongheng',capabilities:JSON.stringify([kind])}).run();
    db.insert(modelPricing).values({modelPattern:id,billingType:kind==='text'?'per_token':'per_call',inputPrice:kind==='text'?1:2,outputPrice:2}).run();
  }
  ChannelService.createChannel({name:'纵横科技',type:'zongheng',baseUrl:'https://channel.invalid/v1/',apiKey:'test-key',
    supportedModels:['ZH-video-public','ZH-image-public','ZH-gpt-public'],
    modelMapping:{'ZH-video-public':'video-public','ZH-image-public':'image-public','ZH-gpt-public':'gpt-public'}});
  upstream=async()=>{throw Error('Unexpected upstream');};
  vi.stubGlobal('fetch',vi.fn((url,init)=>upstream(String(url),init||{})));
  vi.spyOn(globalThis,'setTimeout').mockImplementation(((fn:any,ms:number,...args:any[])=>nativeSetTimeout(fn,ms>=1000&&ms<=60000?5:ms,...args)) as any);
});
afterEach(()=>{
  for(const row of db.select().from(contents).all()){
    const meta=JSON.parse(row.metadata||'{}');
    for(const url of [row.resultUrl,...(meta.imageUrls||[])])if(typeof url==='string'&&url.includes('zongheng_')&&/\/(?:api\/)?uploads\//.test(url)){
      const file=path.resolve('data',new URL(url,'http://local.invalid').pathname.replace(/^\/(?:api\/)?/,''));
      if(file.startsWith(path.resolve('data/uploads')+path.sep)&&fs.existsSync(file))fs.unlinkSync(file);
    }
  }
  vi.restoreAllMocks();vi.unstubAllGlobals();
});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));sqlite.close();});
async function post(endpoint:string,body:any){return nativeFetch(origin+endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer test'},body:JSON.stringify(body)});}
const request={model:'ZH-video-public',prompt:'产品视频',video_length:6,resolution:'720p',aspect_ratio:'16:9'};
function installConfirmedVideos() {
  const ids = ZONGHENG_VIDEO_MODELS.map(spec => 'ZH-' + spec.id);
  for (const id of ids) {
    db.insert(models).values({modelId:id,displayName:id,provider:'zongheng',capabilities:'["video"]'}).run();
    db.insert(modelPricing).values({modelPattern:id,billingType:'per_call',inputPrice:2}).run();
  }
  const channel=db.select().from(channels).get()!;
  ChannelService.updateChannel(channel.id,{supportedModels:ids,modelMapping:Object.fromEntries(ZONGHENG_VIDEO_MODELS.map(spec=>['ZH-'+spec.id,spec.id]))});
}
describe('V6K cutover using the existing Zongheng billing and recovery paths', () => {
  it.each(ZONGHENG_VIDEO_MODELS)('retains the exact $id model and existing price through both new-protocol entry points', async spec => {
    installConfirmedVideos();
    sqlite.prepare("INSERT INTO api_tokens (id,user_id,token_key,balance) VALUES (1,1,'test',-1)").run();
    let posts = 0;
    upstream = async (url, init) => {
      expect(url).toBe('https://channel.invalid/v1/videos'); expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toMatchObject({ model: spec.id, seconds: spec.seconds[0], resolution: spec.resolution });
      posts++; return Response.json({ id: 'catalog_' + posts, status: 'completed' });
    };
    for (const endpoint of ['/api/video/generate', '/v1/videos']) {
      await (await post(endpoint, { model: 'ZH-' + spec.id, prompt: '场景' })).text();
      await vi.waitFor(() => expect(latest().status).toBe('completed'));
      expect(latest().cost).toBe(2);
    }
    expect(posts).toBe(2); expect(balance()).toBe(96);
  });
  function enableV6k() {
    const old = db.select().from(channels).get()!;
    ChannelService.updateChannel(old.id, { status: 0 });
    const id = ChannelService.createChannel({ name: '纵横 V6K', type: 'zongheng-v6k', baseUrl: 'https://www.v6k.top', apiKey: 'v6k-key',
      supportedModels: ['ZH-video-public'], modelMapping: { 'ZH-video-public': 'video-public' } });
    expect(db.select().from(channels).all().find(c => c.id === id)?.type).toBe('zongheng-v6k');
    sqlite.prepare("INSERT INTO api_tokens (id,user_id,token_key,balance) VALUES (1,1,'test',-1)").run();
    return { old, id };
  }
  it.each(['/api/video/generate', '/v1/videos'])('submits once and synchronizes queued/processing/completed with no URL at %s', async endpoint => {
    const { id } = enableV6k(); let posts = 0, queries = 0;
    const { downloadAndLocalizeVideo } = await import('../server/services/videoLocalizationService');
    vi.mocked(downloadAndLocalizeVideo).mockClear();
    upstream = async (url, init) => {
      expect(init.headers.Authorization).toBe('Bearer v6k-key');
      if (init.method === 'POST') {
        posts++; expect(url).toBe('https://www.v6k.top/v1/videos');
        expect(JSON.parse(init.body)).toMatchObject({ model: 'video-public', seconds: 6, videos: ['https://media.invalid/r.mp4'], audios: ['https://media.invalid/r.mp3'] });
        expect(JSON.parse(init.body)).not.toHaveProperty('duration');
        return Response.json({ id: 'v6k_task', status: 'queued', progress: 0 });
      }
      expect(url).toBe('https://www.v6k.top/v1/videos/v6k_task');
      return Response.json({ id: 'v6k_task', status: ++queries === 1 ? 'in_progress' : 'completed', progress: 100 });
    };
    const response = await post(endpoint, { ...request, seconds: 6, reference_videos: ['https://media.invalid/r.mp4'], audio_urls: ['https://media.invalid/r.mp3'] });
    await response.text(); await vi.waitFor(() => expect(latest().status).toBe('completed'));
    expect(balance()).toBe(98); expect(posts).toBe(1);
    expect(JSON.parse(latest().metadata!)).toMatchObject({ videoId: 'v6k_task', channelId: id, zonghengProtocol: 'v6k', zonghengBaseUrl: 'https://www.v6k.top' });
    expect(vi.mocked(downloadAndLocalizeVideo).mock.calls.some(args => args[0] === 'https://www.v6k.top/v1/videos/v6k_task/content' && args[3] === id)).toBe(true);
    await video.resumePollForTask(latest().id, latest()); expect(balance()).toBe(98); expect(posts).toBe(1);
  });
  it.each(['/api/video/generate', '/v1/videos'].flatMap(endpoint => ['completed', 'failed'].map(status => ({ endpoint, status }))))('settles an immediate $status response at $endpoint without a second request', async ({ endpoint, status }) => {
    enableV6k(); let posts = 0;
    upstream = async (_url, init) => {
      expect(init.method).toBe('POST'); posts++;
      return Response.json({ id: 'v6k_immediate', status, error: status === 'failed' ? { code: 'video_generation_failed', message: 'confirmed failure' } : undefined });
    };
    await (await post(endpoint, { ...request, seconds: 6 })).text();
    await vi.waitFor(() => expect(latest().status).toBe(status));
    expect(JSON.parse(latest().metadata!).videoId).toBe('v6k_immediate');
    expect(balance()).toBe(status === 'completed' ? 98 : 100); expect(posts).toBe(1);
    await video.resumePollForTask(latest().id, latest());
    expect(balance()).toBe(status === 'completed' ? 98 : 100); expect(posts).toBe(1);
  });
  it('retains an old order without querying the retired API, resubmitting or refunding', async () => {
    const { old } = enableV6k();
    const id = Number(db.insert(contents).values({ userId: 1, type: 'video', status: 'processing', modelId: request.model, cost: 2,
      metadata: JSON.stringify({ videoId: 'vid_old', channelId: old.id, zonghengProtocol: 'legacy' }) }).run().lastInsertRowid);
    await video.resumePollForTask(id, latest());
    expect(latest()).toMatchObject({ status: 'review', cost: 2 });
    expect(JSON.parse(latest().metadata!).videoId).toBe('vid_old'); expect(fetch).not.toHaveBeenCalled(); expect(balance()).toBe(100);
    await expect(ContentRecoveryService.inspect(id)).rejects.toMatchObject({ status: 409 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['completed', 'failed'])('continues the original task after a temporary query error and settles %s once', async status => {
    enableV6k(); let posts = 0, queries = 0;
    upstream = async (_url, init) => {
      if (init.method === 'POST') { posts++; return Response.json({ id: 'v6k_retry', status: 'queued' }); }
      if (++queries === 1) return Response.json({ error: { message: 'rate limited' } }, { status: 429, headers: { 'Retry-After': '1' } });
      return Response.json({ id: 'v6k_retry', status, error: status === 'failed' ? { message: 'confirmed failure' } : undefined });
    };
    await (await post('/v1/videos', { ...request, seconds: 6 })).text();
    await vi.waitFor(() => expect(latest().status).toBe(status));
    expect(posts).toBe(1); expect(queries).toBe(2); expect(balance()).toBe(status === 'failed' ? 100 : 98);
    await video.resumePollForTask(latest().id, latest());
    expect(balance()).toBe(status === 'failed' ? 100 : 98); expect(posts).toBe(1);
  });
  it('retries V6K result storage without creating another task or refunding a success', async () => {
    enableV6k(); let posts = 0, queries = 0;
    const { downloadAndLocalizeVideo } = await import('../server/services/videoLocalizationService');
    vi.mocked(downloadAndLocalizeVideo).mockRejectedValueOnce(new Error('temporary save failure'));
    upstream = async (_url, init) => {
      if (init.method === 'POST') { posts++; return Response.json({ id: 'save_retry', status: 'queued' }); }
      queries++; return Response.json({ id: 'save_retry', status: 'completed' });
    };
    await (await post('/api/video/generate', { ...request, seconds: 6 })).text();
    expect(latest().status).toBe('completed'); expect(balance()).toBe(98); expect(posts).toBe(1); expect(queries).toBe(2);
  });
  it('inspects a V6K task using its content endpoint instead of requiring a public URL', async () => {
    const { id: channelId } = enableV6k();
    const id = Number(db.insert(contents).values({ userId: 1, type: 'video', status: 'processing', modelId: request.model, cost: 2,
      metadata: JSON.stringify({ videoId: 'new_task', channelId, zonghengProtocol: 'v6k', zonghengBaseUrl: 'https://www.v6k.top' }) }).run().lastInsertRowid);
    upstream = async url => { expect(url).toBe('https://www.v6k.top/v1/videos/new_task'); return Response.json({ id: 'new_task', status: 'completed' }); };
    expect(await ContentRecoveryService.inspect(id)).toMatchObject({ status: 'completed', upstreamResultUrl: 'https://www.v6k.top/v1/videos/new_task/content' });
    expect(balance()).toBe(100);
  });
  it.each(['/api/video/generate', '/v1/videos'].flatMap(endpoint => [200, 400, 401, 402, 403, 404, 422, 429].map(status => ({ endpoint, status }))))('marks an explicit HTTP $status rejection failed, not review, at $endpoint', async ({ endpoint, status }) => {
    enableV6k(); let posts = 0;
    upstream = async (_url, init) => {
      expect(init.method).toBe('POST'); posts++;
      return Response.json({ error: { code: 'invalid_parameters', type: 'new_api_error', message: 'unsupported duration' },
        code: 'invalid_parameters', message: 'unsupported duration', data: null, request_id: 'trace_only' },
        { status, headers: { 'x-request-id': 'trace_only' } });
    };
    await (await post(endpoint, { ...request, seconds: 6 })).text();
    expect(latest()).toMatchObject({ status: 'failed', cost: 0 });
    const metadata = JSON.parse(latest().metadata!);
    expect(metadata.requiresReview).not.toBe(true);
    expect(metadata.error).toContain('unsupported duration');
    expect(balance()).toBe(100); expect(posts).toBe(1);
    await video.resumePollForTask(latest().id, latest());
    expect(balance()).toBe(100); expect(posts).toBe(1);
  });
  it.each(['/api/video/generate', '/v1/videos'])('does not resubmit or refund an uncertain 504 at %s', async endpoint => {
    enableV6k(); let posts = 0;
    upstream = async () => { posts++; return new Response('<html>gateway timeout</html>', { status: 504 }); };
    await (await post(endpoint, { ...request, seconds: 6 })).text();
    expect(latest().status).toBe('review'); expect(balance()).toBe(98);
    await video.resumePollForTask(latest().id, latest());
    expect(posts).toBe(1); expect(balance()).toBe(98);
  });
  it.each(['/api/video/generate', '/v1/videos'])('preserves a 503 diagnostic and exits the submitting state without generating or settling twice at %s', async endpoint => {
    enableV6k(); let posts = 0;
    upstream = async () => {
      posts++;
      return Response.json({ error: { code: 'provider_specific_503', message: '原始具体原因 v6k-key https://secret.invalid/file?signature=private' } },
        { status: 503, headers: { 'x-request-id': 'trace_503' } });
    };
    const reply = await (await post(endpoint, { ...request, seconds: 6 })).text();
    expect(reply).toContain('provider_specific_503');
    expect(reply).not.toContain('v6k-key'); expect(reply).not.toContain('V6K');
    expect(latest().status).toBe('review'); expect(balance()).toBe(98);
    const meta = JSON.parse(latest().metadata!);
    expect(meta.videoSubmissionState).toBe('unknown');
    expect(meta.error).toContain('provider_specific_503');
    expect(meta.error).toContain('原始具体原因');
    expect(meta.error).not.toContain('secret.invalid');
    expect(meta.zonghengSubmissionDiagnostics).toMatchObject({ httpStatus: 503, reason: 'http_error' });
    expect(meta.zonghengSubmissionDiagnostics.message).toContain('trace_503');
    expect(JSON.stringify(meta.zonghengSubmissionDiagnostics)).not.toContain('signature=private');
    await video.resumePollForTask(latest().id, latest());
    expect(posts).toBe(1); expect(balance()).toBe(98);
  });
});
