import { quoteVideoRequest, assertExpectedVideoCost } from '../server/services/videoQuoteService.js';
import { PricingService } from '../server/services/pricingService.js';
import { HAYA_XG_SEEDANCE_20_MODEL, HAYA_XG_SEEDANCE_20_UPSTREAM_MODEL } from '../shared/hayaVideo';
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const sqlite = new Database(':memory:'); return { sqlite, db: drizzle(sqlite) };
});
vi.mock('../server/services/channelService.js', () => ({ ChannelService: { getActiveChannels: vi.fn(() => []), getChannelRaw: vi.fn() } }));
vi.mock('../server/routes/imageGen.js', () => ({ localizeGeneratedImage: vi.fn(async () => '/api/uploads/spec-test.png') }));
vi.mock('../server/services/videoLocalizationService.js', () => ({ downloadAndLocalizeVideo: vi.fn(async () => '/uploads/spec-test.mp4') }));
import { initDatabase } from '../server/db/seed.js';
import { db, sqlite } from '../server/db/index.js';
import { models, settings, users, contents, channels, modelPricing } from '../server/db/schema.js';
import { eq } from 'drizzle-orm';
import { ChannelService } from '../server/services/channelService.js';
import { defaultRoutingLimits, routingMismatches, routeRequestCost, type ModelSpecification, type RoutingInput } from '../shared/modelRouting.js';
import { saveModelSpecification, getModelSpecification, selectModelRoutes, inspectModelRoutes, getRouteHealth, noteRouteResult, resetRouteHealth, claimRouteProbe, specificationAvailability } from '../server/services/modelRoutingService.js';
import { getEnabledPublicModels } from '../server/services/modelCatalogService.js';
import { handleSpecificationGeneration, specificationRequest, resumeSpecificationTasks } from '../server/services/specificationGenerationService.js';
import { resolvePublicModelId } from '../server/services/publicModelNameService.js';
import { hmStudioQueue, HmStudioQueueFullError } from '../server/services/hmStudioQueueService.js';
import specificationRoutes from '../server/routes/modelSpecifications.js';
import express from 'express';
import { suggestedModelSpecifications, existingModelLimits } from '../server/services/modelSpecificationPresets.js';
import * as adapters from '../server/services/specificationAdapters.js';
import { findVideoSubmissionReceipt } from '../server/services/videoSubmissionReceiptService';

let userId: number;
const limits = () => ({ ...defaultRoutingLimits(), maxImages: 9 });
const request: RoutingInput = { images: 9, videos: 0, audios: 0, outputs: 1, seconds: 15, resolution: '720p', ratio: '16:9', firstFrame: false, lastFrame: false };
const channel = (id: number) => ({ id, type: 'openai', supportedModels: ['route-model'], modelMapping: {}, baseUrl: 'https://provider-' + id + '.invalid', apiKey: 'test-only-key', apiKeyId: null, priority: 0, status: 1 });
const route = (id: number, cost = 1, costUnit: 'per_call' | 'per_second' = 'per_call') => ({
  id: 'route-' + id, channelId: id, executionModel: 'route-model', upstreamModel: 'upstream-' + id,
  enabled: true, limits: limits(), cost, costUnit, resolutionCosts: {}, priority: 0,
});
const spec = (): ModelSpecification => ({ modelId: 'routing-public-test', kind: 'video', enabled: true, aliases: ['routing-alias-test'], limits: limits(), routes: [route(1), route(2, .1, 'per_second')] });
beforeAll(async () => {
  process.env.ADMIN_EMAIL = 'routing@test.com'; process.env.ADMIN_PASSWORD = 'test-only-password';
  await initDatabase();
  userId = db.select().from(users).all()[0].id;
  db.insert(models).values([
    { modelId: 'routing-public-test', displayName: '统一规格 900', provider: 'routing', capabilities: '["video"]' },
    { modelId: 'routing-alias-test', displayName: '渠道入口', provider: 'routing', capabilities: '["video"]' },
    { modelId: 'routing-image-test', displayName: '统一图片', provider: 'routing', capabilities: '["image"]' },
  ]).run();
  for (const id of [1, 2, 3]) db.insert(channels).values({ id, name: '线路 ' + id, type: 'openai', baseUrl: 'https://provider-' + id + '.invalid' }).onConflictDoNothing().run();
});
beforeEach(() => {
  if (sqlite.prepare("SELECT name FROM sqlite_master WHERE name='video_submission_receipts'").get()) sqlite.exec('DELETE FROM video_submission_receipts');
  for (const id of ['routing-public-test','routing-alias-test']) {
    db.delete(modelPricing).where(eq(modelPricing.modelPattern,id)).run();
    db.insert(modelPricing).values({modelPattern:id,billingType:'per_call',inputPrice:2,outputPrice:0,extraParams:'{}'}).run();
  }
  db.delete(settings).where(eq(settings.key, 'model_specification_routes_v1')).run();
  db.delete(settings).where(eq(settings.key, 'model_specification_health_v1')).run();
  db.update(models).set({ isActive: 1 }).where(eq(models.modelId, 'routing-public-test')).run();
  db.update(users).set({ balance: 100 }).where(eq(users.id, userId)).run();
  vi.mocked(ChannelService.getActiveChannels).mockReturnValue([channel(1), channel(2)]);
  vi.restoreAllMocks();
  db.delete(contents).run();
});
afterAll(() => sqlite.close());
afterEach(() => vi.unstubAllGlobals());

describe('specification matching and cost routing', () => {
  it('supports fixed durations, arbitrary ranges with steps, and explicit options', () => {
    const l = limits();
    expect(routingMismatches(l, request, 'video')).toEqual([]);
    expect(routingMismatches({ ...l, duration: { mode: 'fixed', min: 30, max: 30, step: 1, values: [] } }, request, 'video')).toContain('时长不匹配');
    expect(routingMismatches({ ...l, duration: { mode: 'options', min: 4, max: 30, step: 1, values: [5, 15, 30] } }, request, 'video')).toEqual([]);
    expect(routingMismatches({ ...l, duration: { mode: 'range', min: 4, max: 30, step: 2, values: [] } }, request, 'video')).toContain('时长不匹配');
  });
  it('checks exact reference counts including dedicated frames without discarding material', () => {
    expect(routingMismatches(limits(), { ...request, videos: 1 }, 'video')).toContain('视频最多 0 个');
    expect(routingMismatches(limits(), { ...request, audios: 1 }, 'video')).toContain('音频最多 0 段');
    expect(routingMismatches({ ...limits(), firstFrame: true }, { ...request, firstFrame: true }, 'video')).toContain('图片数量需为 0–9');
    expect(routingMismatches(limits(), { ...request, images: 0 }, 'video')).toEqual([]);
  });
  it('compares the cost of this request rather than advertised unit rates', () => {
    saveModelSpecification(spec());
    expect(selectModelRoutes(spec(), request).map(t => t.channel.id)).toEqual([1, 2]);
    expect(selectModelRoutes(spec(), { ...request, seconds: 4 }).map(t => t.channel.id)).toEqual([2, 1]);
    expect(routeRequestCost({ ...route(1), resolutionCosts: { '720p': .2 } }, request)).toBe(.2);
    expect(routeRequestCost({ ...route(1), cost: null }, request)).toBeNull();
  });
  it('treats unknown cost as unknown and keeps it after known costs', () => {
    const s = spec(); s.routes[0].cost = null; saveModelSpecification(s);
    expect(selectModelRoutes(s, request).map(t => t.channel.id)).toEqual([2, 1]);
  });
  it('does not route to disabled specifications, channels, keys or model lines', () => {
    const s = spec(); s.routes[0].enabled = false; saveModelSpecification(s);
    expect(selectModelRoutes(s, request).map(t => t.channel.id)).toEqual([2]);
    vi.mocked(ChannelService.getActiveChannels).mockReturnValue([channel(1)]);
    expect(selectModelRoutes(s, request)).toEqual([]);
    vi.mocked(ChannelService.getActiveChannels).mockReturnValue([channel(2)]);
    db.update(models).set({ isActive: 0 }).where(eq(models.modelId, s.modelId)).run();
    expect(selectModelRoutes(s, request)).toEqual([]);
  });
  it('hides aliases from public discovery and preserves separate specifications', () => {
    saveModelSpecification(spec());
    const ids = getEnabledPublicModels('video').map(m => m.modelId);
    expect(resolvePublicModelId('routing-alias-test')).toBe('routing-public-test');
    expect(resolvePublicModelId('渠道入口')).toBe('routing-public-test');
    expect(ids).toContain('routing-public-test'); expect(ids).not.toContain('routing-alias-test');
    expect(() => saveModelSpecification({ ...spec(), modelId: 'routing-alias-test', aliases: [] })).toThrow('模型已被其他规格关联');
  });
  it('keeps a healthy 4–30s channel eligible for a 15s request', () => {
    const s = spec(); s.routes[0].limits.duration = { mode: 'fixed', min: 30, max: 30, step: 1, values: [] };
    saveModelSpecification(s);
    expect(selectModelRoutes(s, request).map(t => t.channel.id)).toEqual([2]);
    s.routes[0].limits.duration = { mode: 'range', min: 4, max: 30, step: 1, values: [] }; saveModelSpecification(s);
    expect(selectModelRoutes(s, request).map(t => t.channel.id)).toEqual([1, 2]);
  });
  it('reports reasons for simulation without exposing upstream credentials', () => {
    const item = inspectModelRoutes(spec(), { ...request, seconds: 31 })[0];
    expect(item.reasons).toContain('时长不匹配');
    expect(JSON.stringify({ route: item.route, reasons: item.reasons, health: item.health })).not.toContain('test-only-key');
  });
  it('records failures without cooldown or probe locks, while preserving manual disable', () => {
    const s = spec(); saveModelSpecification(s);
    noteRouteResult('1:0:upstream-1', false, 'busy');
    expect(selectModelRoutes(s, request).map(t => t.channel.id)).toEqual([1, 2]);
    expect(getRouteHealth()['1:0:upstream-1']).toMatchObject({ state: 'healthy', retryAt: 0, failures: 1, lastError: 'busy' });
    expect(claimRouteProbe('1:0:upstream-1')).toBe(true); expect(claimRouteProbe('1:0:upstream-1')).toBe(true);
    resetRouteHealth('1:0:upstream-1'); s.routes[0].enabled = false; saveModelSpecification(s);
    expect(selectModelRoutes(s, request).map(t => t.channel.id)).toEqual([2]);
  });
  it('records invalid-key errors without auto-locking the route', () => {
    noteRouteResult('1:0:upstream-1', false, 'key expired', true);
    expect(claimRouteProbe('1:0:upstream-1')).toBe(true);
    resetRouteHealth('1:0:upstream-1'); expect(claimRouteProbe('1:0:upstream-1')).toBe(true);
  });
  it('rejects invalid configuration and never infers unlimited capabilities', () => {
    expect(() => saveModelSpecification({ ...spec(), limits: { ...limits(), maxImages: -1 } })).toThrow();
    expect(() => saveModelSpecification({ ...spec(), routes: [{ ...route(1), cost: -1 }] })).toThrow();
    expect(() => saveModelSpecification({ ...spec(), routes: [{ ...route(1), limits: { ...limits(), duration: { mode: 'options', min: 4, max: 30, step: 1, values: [] } } }] })).toThrow();
  });
});
describe('safe submission failure classification', () => {
  it('fails over explicit unaccepted capacity/auth failures but retains uncertain submissions', () => {
    expect(adapters.submissionFailure(429, '{"error":"rate limit"}').retrySafe).toBe(true);
    expect(adapters.submissionFailure(503, 'service unavailable').retrySafe).toBe(true);
    expect(adapters.submissionFailure(503, 'service unavailable', undefined, true)).toMatchObject({ retrySafe: false, uncertain: true });
    expect(adapters.submissionFailure(401, 'invalid API key').blocked).toBe(true);
    expect(adapters.submissionFailure(408, 'request timeout').uncertain).toBe(true);
    expect(adapters.submissionFailure(504, 'gateway timeout').uncertain).toBe(true);
    expect(adapters.submissionFailure(500, 'internal server error').retrySafe).toBe(false);
    expect(adapters.submissionFailure(503, '{"task_id":"already-created"}').retrySafe).toBe(false);
    expect(adapters.submissionFailure(400, 'invalid aspect ratio').retrySafe).toBe(false);
    expect(adapters.submissionFailure(403, 'content policy violation').blocked).toBe(false);
  });
  it('normalizes legacy reference fields, rejects conflicting aliases and preserves all references', () => {
    const r = specificationRequest({ prompt: 'test', reference_video: 'https://v.invalid/v.mp4', audio_urls: ['https://a.invalid/a.mp3'] }, 'video', '');
    expect(r.input.videos).toBe(1); expect(r.input.audios).toBe(1);
    expect(() => specificationRequest({ prompt: 'test', images: ['a'], reference_images: ['b'] }, 'video', '')).toThrow();
    expect(() => specificationRequest({ prompt: 'test', n: 0 }, 'image', '')).toThrow();
  });
});
function response() {
  const r: any = { headersSent: false, writableEnded: false, destroyed: false, events: [] as any[], statusCode: 200 };
  r.status = vi.fn((code: number) => { r.statusCode = code; return r; });
  r.json = vi.fn((value: any) => { r.body = value; return r; });
  r.setHeader = vi.fn(); r.flushHeaders = vi.fn(() => { r.headersSent = true; });
  r.write = vi.fn((text: string) => { try { r.events.push(JSON.parse(text.slice(6))); } catch {} return true; });
  r.end = vi.fn(() => { r.writableEnded = true; }); return r;
}
describe('managed image execution and single reservation', () => {
  it('persists response-header IDs for each generated image through the existing task metadata flow', async () => {
    const imageLimits = { ...limits(), resolutions: ['4K'], maxOutputs: 4 };
    const s: ModelSpecification = { ...spec(), modelId: 'routing-image-test', kind: 'image', aliases: [], limits: imageLimits,
      routes: [{ ...route(1), executionModel: 'gpt-image-2', upstreamModel: 'gpt-image-2', costUnit: 'per_call', limits: imageLimits }] };
    saveModelSpecification(s);
    vi.mocked(ChannelService.getActiveChannels).mockReturnValue([{ ...channel(1), supportedModels: ['gpt-image-2'] }]);
    sqlite.prepare('INSERT INTO model_pricing(model_pattern,billing_type,input_price,output_price,extra_params) VALUES(?,?,?,?,?)').run(s.modelId, 'per_call', 2, 0, '{}');
    const upstream = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ url: 'https://result.invalid/1.png' }] }, { headers: { 'x-request-id': 'req-image-1' } }))
      .mockResolvedValueOnce(Response.json({ data: [{ url: 'https://result.invalid/2.png' }] }, { headers: { 'x-request-id': 'req-image-2' } }));
    vi.stubGlobal('fetch', upstream);
    const res = response();
    await handleSpecificationGeneration({ body: { model: s.modelId, prompt: 'test', resolution: '4K', n: 2 }, protocol: 'https', get: () => 'app.invalid', userId } as any, res, 'image');
    const row = db.select().from(contents).all().at(-1)!;
    expect(row.status).toBe('completed');
    const meta = JSON.parse(row.metadata);
    expect(meta.upstreamTaskIds).toEqual(['req-image-1', 'req-image-2']);
    expect(meta.imageJobs.map((job: any) => ({ taskId: job.taskId, status: job.status }))).toEqual([
      { taskId: 'req-image-1', status: 'completed' }, { taskId: 'req-image-2', status: 'completed' },
    ]);
    expect(meta.upstreamTaskId).toBeTruthy(); expect(upstream).toHaveBeenCalledTimes(2);
    expect(row.cost).toBe(4); expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(96);
  });
  it('switches after a confirmed rejection, records the actual route and charges once', async () => {
    const s: ModelSpecification = { ...spec(), modelId: 'routing-image-test', kind: 'image', aliases: [],
      limits: { ...limits(), resolutions: ['2K'], maxOutputs: 4 }, routes: spec().routes.map(r => ({ ...r, cost: r.channelId, costUnit: 'per_call', limits: { ...limits(), resolutions: ['2K'], maxOutputs: 4 } })) };
    saveModelSpecification(s);
    sqlite.prepare("INSERT INTO model_pricing(model_pattern,billing_type,input_price,output_price,extra_params) VALUES(?,?,?,?,?)").run(s.modelId, 'per_call', 2, 0, '{}');
    const generate = vi.spyOn(adapters, 'generateSpecificationImage')
      .mockRejectedValueOnce(new adapters.SpecificationUpstreamError('rate limited', true))
      .mockResolvedValueOnce({ imageUrl: 'data:image/png;base64,eA==', reportedImageUrl: 'https://result.invalid/image.png', taskId: 'img-1', raw: {} });
    const res = response();
    await handleSpecificationGeneration({ body: { model: s.modelId, prompt: 'test', resolution: '2K' }, protocol: 'https', get: () => 'app.invalid', userId } as any, res, 'image');
    expect(generate).toHaveBeenCalledTimes(2);
    const row = db.select().from(contents).all().at(-1)!;
    expect(row.status).toBe('completed'); expect(row.modelId).toBe(s.modelId); expect(row.cost).toBe(2);
    const meta = JSON.parse(row.metadata);
    expect(meta.channelId).toBe(2); expect(meta.routingAttempts).toHaveLength(1);
    expect(sqlite.prepare('SELECT state FROM billing_reservations WHERE id=?').get(meta.billingReservationId)).toMatchObject({ state: 'settled' });
    expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(98);
  });
  it('does not fail over an uncertain image submission and leaves the reservation for review', async () => {
    const s: ModelSpecification = { ...spec(), modelId: 'routing-image-test', kind: 'image', aliases: [], limits: { ...limits(), resolutions: ['2K'] },
      routes: spec().routes.map(r => ({ ...r, costUnit: 'per_image', limits: { ...limits(), resolutions: ['2K'] } })) }; saveModelSpecification(s);
    const generate = vi.spyOn(adapters, 'generateSpecificationImage').mockRejectedValueOnce(new adapters.SpecificationUpstreamError('timeout', false, true));
    await handleSpecificationGeneration({ body: { model: s.modelId, prompt: 'test', resolution: '2K' }, protocol: 'https', get: () => 'app.invalid', userId } as any, response(), 'image');
    expect(generate).toHaveBeenCalledTimes(1);
    const row = db.select().from(contents).all().at(-1)!, meta = JSON.parse(row.metadata);
    expect(meta.requiresReview).toBe(true);
    expect(sqlite.prepare('SELECT state FROM billing_reservations WHERE id=?').get(meta.billingReservationId)).toMatchObject({ state: 'review' });
  });
});


describe('managed video execution', () => {
  it('continues a long-running V6K unknown task in the next recovery cycle without requiring manual review', async () => {
    const l = { ...limits(), resolutions: ['480p'] }, c = { ...channel(1), type: 'zongheng-v6k', baseUrl: 'https://www.v6k.top' };
    vi.mocked(ChannelService.getActiveChannels).mockReturnValue([c]);
    vi.mocked(ChannelService.getChannelRaw).mockReturnValue(c as any);
    const s = { ...spec(), aliases: [], limits: l, routes: [{ ...route(1), upstreamModel: 'TTseadanco2.5-480', limits: l }] };
    saveModelSpecification(s);
    const nativeTimer = globalThis.setTimeout;
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms: number, ...args: any[]) => nativeTimer(fn, ms >= 1000 && ms <= 300000 ? 5 : ms, ...args)) as any);
    let clock = Date.now(), posts = 0, queries = 0;
    const time = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
      if (init.method === 'POST') { posts++; return Response.json({ id: 'long_original', status: 'unknown' }); }
      if (++queries === 1) { clock += 2 * 60 * 60_000 + 1; return Response.json({ id: 'long_original', status: 'unknown' }); }
      return Response.json({ id: 'long_original', status: 'completed' });
    }));
    try {
      await handleSpecificationGeneration({ body: { model: s.modelId, prompt: 'test', seconds: 6, resolution: '480p' }, headers: {}, protocol: 'https', get: () => 'app.invalid', userId } as any, response(), 'video');
      const row = db.select().from(contents).all().at(-1)!;
      expect(row.status).toBe('processing'); expect(JSON.parse(row.metadata).requiresReview).not.toBe(true);
      resumeSpecificationTasks(); expect(queries).toBe(1);
      clock += 120_000; resumeSpecificationTasks(); resumeSpecificationTasks();
      await vi.waitFor(() => expect(db.select().from(contents).all().at(-1)!.status).toBe('completed'));
      expect(posts).toBe(1); expect(queries).toBe(2);
      expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(98);
    } finally { time.mockRestore(); timer.mockRestore(); }
  });
  it.each(['completed', 'failed', 'rejected', 'uncertain-no-id'])('handles V6K unknown receipts in actual specification execution without failover or duplicate money movement: %s', async outcome => {
    const l = { ...limits(), resolutions: ['480p'] };
    const c = { ...channel(1), type: 'zongheng-v6k', baseUrl: 'https://www.v6k.top', timeout: 120_000 };
    vi.mocked(ChannelService.getActiveChannels).mockReturnValue([c, channel(2)]);
    vi.mocked(ChannelService.getChannelRaw).mockReturnValue(c as any);
    const s = { ...spec(), aliases: [], limits: l, routes: [{ ...route(1), upstreamModel: 'TTseadanco2.5-480', limits: l }, { ...route(2), limits: l }] };
    saveModelSpecification(s);
    const nativeTimer = globalThis.setTimeout;
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms: number, ...args: any[]) => nativeTimer(fn, ms >= 1000 && ms <= 300000 ? 5 : ms, ...args)) as any);
    let posts = 0, queries = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      const row = db.select().from(contents).all().at(-1)!;
      const meta = JSON.parse(row.metadata);
      if (init.method === 'POST') {
        posts++; expect(url).toBe('https://www.v6k.top/v1/videos');
        expect(meta.zonghengOrderId).toBe(init.headers['Idempotency-Key']);
        expect(meta.videoSubmissionState).toBe('submitting');
        if (outcome === 'rejected') return Response.json({ error: { code: 'invalid_parameters', message: 'confirmed refused' } }, { status: 400 });
        if (outcome === 'uncertain-no-id') return new Response('gateway timeout', { status: 504 });
        return Response.json({ id: 'spec_original', status: 'unknown' }, { status: 503 });
      }
      expect(url).toBe('https://www.v6k.top/v1/videos/spec_original');
      expect(findVideoSubmissionReceipt(row.id)).toMatchObject({ upstreamTaskId: 'spec_original', channelId: 1 });
      expect(meta).toMatchObject({ videoId: 'spec_original', videoSubmissionState: 'accepted' });
      expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(98);
      if (++queries === 1) return Response.json({ error: { message: 'query later' } }, { status: 429, headers: { 'Retry-After': '75' } });
      if (queries === 2) throw new TypeError('temporary disconnect');
      if (queries === 3) return new Response('invalid body', { headers: { 'Retry-After': '90' } });
      if (queries === 4) return Response.json({ id: 'spec_original', status: 'unknown' });
      expect(meta).toMatchObject({ upstreamStatus: 'unknown', progressKnown: false });
      return Response.json({ id: 'spec_original', status: outcome, error: outcome === 'failed' ? { message: 'confirmed failed' } : undefined });
    }));
    await handleSpecificationGeneration({ body: { model: s.modelId, prompt: 'test', seconds: 6, resolution: '480p' }, headers: {}, protocol: 'https', get: () => 'app.invalid', userId } as any, response(), 'video');
    await vi.waitFor(() => {
      const row = db.select().from(contents).all().at(-1)!;
      if (outcome === 'uncertain-no-id') expect(JSON.parse(row.metadata).requiresReview).toBe(true);
      else expect(row.status).toBe(outcome === 'rejected' ? 'failed' : outcome);
    });
    const row = db.select().from(contents).all().at(-1)!, meta = JSON.parse(row.metadata);
    expect(posts).toBe(1);
    expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(['failed','rejected'].includes(outcome) ? 100 : 98);
    expect(sqlite.prepare('SELECT state FROM billing_reservations WHERE id=?').get(meta.billingReservationId)).toMatchObject({ state: outcome === 'completed' ? 'settled' : outcome === 'uncertain-no-id' ? 'review' : 'refunded' });
    if (outcome === 'completed' || outcome === 'failed') expect(timer.mock.calls.map(call => call[1])).toEqual(expect.arrayContaining([75_000,40_000,90_000,20_000]));
    resumeSpecificationTasks(); resumeSpecificationTasks();
    expect(posts).toBe(1); expect(queries).toBe(outcome === 'rejected' || outcome === 'uncertain-no-id' ? 0 : 5);
    timer.mockRestore();
  });
  it.each(['completed', 'rejected', 'unknown', 'request-id-only'])('uses the Haya model protocol in real specification execution: %s', async outcome => {
    const id = HAYA_XG_SEEDANCE_20_MODEL;
    db.insert(models).values({ modelId: id, displayName: id, provider: 'haya', capabilities: '["video"]', isActive: 1 })
      .onConflictDoUpdate({ target: models.modelId, set: { isActive: 1 } }).run();
    const l = existingModelLimits(id, 'video')!;
    const c = { ...channel(1), type: 'haya', baseUrl: 'https://hayaai.fun', supportedModels: [id] };
    vi.mocked(ChannelService.getActiveChannels).mockReturnValue([c]);
    vi.mocked(ChannelService.getChannelRaw).mockReturnValue(c as any);
    const s = { ...spec(), aliases: [], limits: l, routes: [{ ...route(1), executionModel: id, upstreamModel: HAYA_XG_SEEDANCE_20_UPSTREAM_MODEL, limits: l }] };
    saveModelSpecification(s);
    let submissions = 0;
    const fetcher = vi.fn(async (_url: string, init: any) => {
      if (init.method === 'POST') {
        submissions++;
        expect(JSON.parse(init.body)).toMatchObject({ model: HAYA_XG_SEEDANCE_20_UPSTREAM_MODEL, seconds: '15', content: [
          ...Array.from({ length: 3 }, (_, i) => ({ type: 'video_url', video_url: { url: `https://media.example/v${i}.mp4?signature=a%2Fb` } })),
          { type: 'audio_url', audio_url: { url: 'https://media.example/a.mp3' } }] });
        if (outcome === 'unknown') throw new Error('network timeout');
        if (outcome === 'rejected') return Response.json({ error: { code: 'invalid_input', message: '参考素材无效' } }, { status: 400 });
        if (outcome === 'request-id-only') return Response.json({ request_id: 'task_not_a_generation_id' });
        return Response.json({ id: 'task_xg_spec' });
      }
      const row = db.select().from(contents).all().at(-1)!;
      expect(JSON.parse(row.metadata).videoId).toBe('task_xg_spec');
      return Response.json({ status: 'completed', metadata: { url: 'https://media.example/done.mp4' } });
    });
    vi.stubGlobal('fetch', fetcher);
    await handleSpecificationGeneration({ body: { model: s.modelId, prompt: 'test', video_length: 15,
      reference_videos: Array.from({ length: 3 }, (_, i) => `https://media.example/v${i}.mp4?signature=a%2Fb`), audio_urls: ['https://media.example/a.mp3'] },
      headers: {}, protocol: 'https', get: () => 'app.invalid', userId } as any, response(), 'video');
    const expected = outcome === 'rejected' ? 'failed' : outcome === 'completed' ? 'completed' : 'processing';
    await vi.waitFor(() => expect(db.select().from(contents).all().at(-1)!.status).toBe(expected));
    if (expected === 'processing') expect(JSON.parse(db.select().from(contents).all().at(-1)!.metadata)).toMatchObject({ requiresReview: true, reviewKind: 'submission' });
    resumeSpecificationTasks(); resumeSpecificationTasks();
    expect(submissions).toBe(1);
    expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(outcome === 'rejected' ? 100 : 98);
    if (outcome === 'rejected') expect(JSON.parse(db.select().from(contents).all().at(-1)!.metadata).error).toContain('invalid_input');
  });
  const req = () => ({ body: { model: 'routing-public-test', prompt: 'test', video_length: 15 }, headers: {}, protocol: 'https', get: () => 'app.invalid', userId } as any);
  const setup = () => { saveModelSpecification(spec()); sqlite.prepare("INSERT INTO model_pricing(model_pattern,billing_type,input_price,output_price,extra_params) SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM model_pricing WHERE model_pattern=?)").run('routing-public-test', 'per_call', 2, 0, '{}', 'routing-public-test'); };
  it.each(['accepted', 'rejected', 'processing'])('recovers HUSS review via original receipt %s without another submission', async state => {
    setup();
    const submit = vi.spyOn(adapters, 'submitSpecificationVideo').mockImplementation(async (_target, _request, beforeSubmit) => {
      beforeSubmit({ hussIdempotencyKey: 'original-request-key' });
      throw new adapters.SpecificationUpstreamError('response lost', false, true);
    });
    await handleSpecificationGeneration(req(), response(), 'video');
    const row = db.select().from(contents).all().at(-1)!;
    db.update(contents).set({ status: 'review' }).where(eq(contents.id, row.id)).run();
    vi.mocked(ChannelService.getChannelRaw).mockReturnValue({ ...channel(1), type: 'huss', baseUrl: 'https://www.huss.top' } as any);
    const fetcher = vi.fn(async () => Response.json({ status: state, ...(state === 'accepted' ? { task_id: 'original-task' } : {}), error: state === 'rejected' ? { code: 'ASSET_FAILED', message: 'reference download failed' } : undefined }));
    vi.stubGlobal('fetch', fetcher);
    const poll = vi.spyOn(adapters, 'pollSpecificationVideo').mockResolvedValue({ status: 'failed', progress: 100, resultUrl: '', error: 'original task failed' } as any);
    resumeSpecificationTasks(); resumeSpecificationTasks();
    await vi.waitFor(() => {
      const current = db.select().from(contents).where(eq(contents.id, row.id)).get()!;
      if (state === 'processing') expect(JSON.parse(current.metadata).progressText).toContain('HUSS 原提交仍在处理');
      else expect(current.status).toBe('failed');
    });
    resumeSpecificationTasks();
    expect(fetcher).toHaveBeenCalledTimes(1);
    if (state === 'processing') expect(JSON.parse(db.select().from(contents).where(eq(contents.id, row.id)).get()!.metadata).requiresReview).toBe(false);
    expect(fetcher.mock.calls[0][0]).toBe('https://www.huss.top/v1/videos/submissions');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(state === 'accepted' ? 1 : 0);
    expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(state === 'processing' ? 98 : 100);
  });
  it('fails over a definite rejection and pins polling and billing to the accepted route', async () => {
    setup();
    const submit = vi.spyOn(adapters, 'submitSpecificationVideo').mockRejectedValueOnce(new adapters.SpecificationUpstreamError('capacity', true)).mockResolvedValueOnce('accepted-2');
    const poll = vi.spyOn(adapters, 'pollSpecificationVideo').mockResolvedValue({ status: 'completed', progress: 100, resultUrl: 'https://result.invalid/video.mp4', error: '' } as any);
    const request = req(); request.body.prompt = '镜头'.repeat(10000) + '结尾';
    await handleSpecificationGeneration(request, response(), 'video');
    expect(submit).toHaveBeenCalledTimes(2); expect(poll).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), 'accepted-2');
    expect(submit.mock.calls.every(call => call[1].prompt === request.body.prompt)).toBe(true);
    const row = db.select().from(contents).all().at(-1)!, meta = JSON.parse(row.metadata);
    expect(row.inputText).toBe(request.body.prompt);
    expect(row.status).toBe('completed'); expect(meta.channelId).toBe(2); expect(meta.videoId).toBe('accepted-2');
    expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(98);
  });
  it('does not resubmit accepted jobs when the provider reports a terminal failure', async () => {
    setup(); const submit = vi.spyOn(adapters, 'submitSpecificationVideo').mockResolvedValue('accepted-1');
    vi.spyOn(adapters, 'pollSpecificationVideo').mockResolvedValue({ status: 'failed', progress: 0, resultUrl: '', error: 'provider generation failed' } as any);
    await handleSpecificationGeneration(req(), response(), 'video');
    expect(submit).toHaveBeenCalledTimes(1); expect(db.select().from(contents).all().at(-1)!.status).toBe('failed');
    expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(100);
  });
  it('keeps uncertain submissions for review without creating a second task', async () => {
    setup(); const submit = vi.spyOn(adapters, 'submitSpecificationVideo').mockRejectedValue(new adapters.SpecificationUpstreamError('gateway timeout', false, true));
    await handleSpecificationGeneration(req(), response(), 'video');
    expect(submit).toHaveBeenCalledTimes(1); const row = db.select().from(contents).all().at(-1)!;
    expect(JSON.parse(row.metadata).requiresReview).toBe(true); expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(98);
  });
  it('rechecks administrator switches immediately before the next submission', async () => {
    setup(); const submit = vi.spyOn(adapters, 'submitSpecificationVideo').mockImplementation(async () => { const s = spec(); s.routes[1].enabled = false; saveModelSpecification(s); throw new adapters.SpecificationUpstreamError('capacity', true); });
    await handleSpecificationGeneration(req(), response(), 'video'); expect(submit).toHaveBeenCalledTimes(1);
    expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(100);
  });
});

describe('accepted image task recovery', () => {
  it('polls the original disabled channel and settles exactly once without any new submission', async () => {
    const s: ModelSpecification = { ...spec(), modelId: 'routing-image-test', kind: 'image', aliases: [], limits: { ...limits(), resolutions: ['2K'] }, routes: spec().routes.map(r => ({ ...r, costUnit: 'per_image', limits: { ...limits(), resolutions: ['2K'] } })) };
    saveModelSpecification(s);
    const generate = vi.spyOn(adapters, 'generateSpecificationImage').mockImplementation(async (_target, _request, starting, submitted) => { starting(); submitted('accepted-image'); throw new adapters.SpecificationUpstreamError('poll timeout', false, true); });
    await handleSpecificationGeneration({ body: { model: s.modelId, prompt: 'test' }, protocol: 'https', get: () => 'app.invalid', userId } as any, response(), 'image');
    const row = db.select().from(contents).all().at(-1)!, meta = JSON.parse(row.metadata);
    expect(meta.imageJobs[0]).toMatchObject({ taskId: 'accepted-image', channelId: 2 });
    vi.mocked(ChannelService.getActiveChannels).mockReturnValue([]);
    vi.mocked(ChannelService.getChannelRaw).mockReturnValue(channel(2) as any);
    const poll = vi.spyOn(adapters, 'pollSpecificationImage').mockResolvedValue({ status: 'completed', imageUrl: 'https://result.invalid/accepted.png', error: '' });
    resumeSpecificationTasks();
    await vi.waitFor(() => expect(db.select().from(contents).where(eq(contents.id, row.id)).get()!.status).toBe('completed'));
    const balance = db.select().from(users).where(eq(users.id, userId)).get()!.balance;
    resumeSpecificationTasks();
    expect(poll).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), 'accepted-image');
    expect(generate).toHaveBeenCalledTimes(1); expect(balance).toBe(98);
    expect(db.select().from(users).where(eq(users.id, userId)).get()!.balance).toBe(balance);
  });
  it('keeps an administrator-refunded task at zero cost when its accepted result arrives later', async () => {
    const s: ModelSpecification = { ...spec(), modelId: 'routing-image-test', kind: 'image', aliases: [], limits: { ...limits(), resolutions: ['2K'] }, routes: spec().routes.map(r => ({ ...r, costUnit: 'per_image', limits: { ...limits(), resolutions: ['2K'] } })) }; saveModelSpecification(s);
    vi.spyOn(adapters, 'generateSpecificationImage').mockImplementation(async (_t, _r, starting, submitted) => { starting(); submitted('accepted-refunded'); throw new adapters.SpecificationUpstreamError('pending', false, true); });
    await handleSpecificationGeneration({ body: { model: s.modelId, prompt: 'test' }, protocol: 'https', get: () => 'app.invalid', userId } as any, response(), 'image');
    const row = db.select().from(contents).all().at(-1)!, meta = JSON.parse(row.metadata);
    sqlite.prepare("UPDATE billing_reservations SET state='refunded',actual=0 WHERE id=?").run(meta.billingReservationId);
    db.update(users).set({ balance: 100 }).where(eq(users.id,userId)).run();
    vi.mocked(ChannelService.getChannelRaw).mockReturnValue(channel(2) as any);
    vi.spyOn(adapters, 'pollSpecificationImage').mockResolvedValue({ status: 'completed', imageUrl: 'https://result.invalid/image.png', error: '' });
    resumeSpecificationTasks();
    await vi.waitFor(() => expect(db.select().from(contents).where(eq(contents.id,row.id)).get()!.status).toBe('completed'));
    expect(db.select().from(contents).where(eq(contents.id,row.id)).get()!.cost).toBe(0);
    expect(db.select().from(users).where(eq(users.id,userId)).get()!.balance).toBe(100);
  });
});

describe('administrator configuration and drafts', () => {
  async function withServer(run: (base: string) => Promise<void>) {
    const app = express(); app.use(express.json()); app.use('/specs', specificationRoutes);
    app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status || 500).json({ error: error.message }));
    const server = app.listen(0,'127.0.0.1');
    await new Promise<void>(resolve => server.once('listening',resolve));
    const address = server.address() as any;
    try { await run('http://127.0.0.1:' + address.port + '/specs'); }
    finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }
  it('rolls back a new model and display name when the route configuration is invalid', async () => {
    await withServer(async base => {
      const data = { ...spec(), modelId: 'invalid-new-spec', displayName: '待检查规格', aliases: [], routes: [{ ...route(1), cost: -1 }] };
      const response = await fetch(base + '/' + data.modelId, { method: 'PUT', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(data) });
      expect(response.status).toBe(400);
      expect(db.select().from(models).where(eq(models.modelId,data.modelId)).get()).toBeUndefined();
      expect(getModelSpecification(data.modelId)).toBeUndefined();
    });
  });
  it('simulates the same route as execution and never includes upstream credentials', async () => {
    saveModelSpecification(spec());
    await withServer(async base => {
      const response = await fetch(base + '/routing-public-test/simulate', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ video_length:15,resolution:'720p' }) });
      const result = await response.json() as any;
      expect(result.selectedRouteId).toBe(selectModelRoutes(spec(),{ ...request,images:0 })[0].route.id);
      expect(JSON.stringify(result)).not.toContain('test-only-key');
    });
  });
  it('preserves video sale IDs, names and duration rules in read-only drafts', () => {
    expect(existingModelLimits('unknown-provider-model','video')).toBeNull();
    expect(existingModelLimits('sd2.5','video')!.duration.mode).toBe('fixed');
    expect(existingModelLimits('gpt-image-2-mingfei','image')!.maxImages).toBe(16);
    for (const id of ['sd2.5','xd-seedance-2.5-720p']) db.insert(models).values({ modelId:id,displayName:id,provider:'test',capabilities:'["video"]' }).onConflictDoNothing().run();
    db.update(channels).set({ supportedModels:JSON.stringify(['sd2.5','xd-seedance-2.5-720p']), modelMapping:'{}' }).where(eq(channels.id,3)).run();
    const draft = suggestedModelSpecifications().find(s => s.modelId === 'sd2.5')!;
    expect(draft.aliases).toEqual([]);
    expect(draft.displayName).toBe(db.select().from(models).where(eq(models.modelId,'sd2.5')).get()!.displayName);
    expect(draft.routes.every(r => r.executionModel === 'sd2.5' && r.costUnit === 'unknown' && r.cost === null)).toBe(true);
    expect(draft.limits.duration).toMatchObject({ mode:'fixed', min:30, max:30 });
    const separate = suggestedModelSpecifications().find(s => s.modelId === 'xd-seedance-2.5-720p')!;
    expect(separate.aliases).toEqual([]);
    expect(separate.limits.duration).toMatchObject({mode:'range',min:4,max:30});
    expect(getModelSpecification('sd2.5')).toBeUndefined();
  });
});

describe('managed adapter protocol boundaries', () => {
  const target = (type: string, model: string, baseUrl = 'https://provider.invalid') => ({route:{...route(1),executionModel:model,upstreamModel:model},channel:{...channel(1),type,baseUrl},healthKey:'1:0:'+model,cost:1});
  const input = (body: any = {}) => specificationRequest({prompt:'完整提示词',video_length:15,resolution:'720p',...body},'video','https://app.invalid');
  const json = (body: any,status=200) => new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
  it('forwards every reference through the four-month provider JSON protocol', async () => {
    const send=vi.fn().mockResolvedValue(json({task_id:'sy-accepted'}));vi.stubGlobal('fetch',send);
    const request=input({reference_images:['https://assets.invalid/a.png','https://assets.invalid/b.png'],audio_urls:['https://assets.invalid/a.mp3']});
    expect(await adapters.submitSpecificationVideo(target('openai','seedance-2.5-720p','https://llm.chre3.com'),request,vi.fn())).toBe('sy-accepted');
    const payload=JSON.parse(send.mock.calls[0][1].body);
    expect(payload.image_refs).toEqual(request.images);expect(payload.audio_refs).toEqual(request.audios);expect(payload.duration).toBe(15);
  });
  it('uses HM JSON without truncating a valid long prompt or references', async () => {
    const send=vi.fn().mockResolvedValue(json({id:'hm-accepted'}));vi.stubGlobal('fetch',send);
    const prompt = '分镜'.repeat(3900) + '\n必须保留的结尾';
    await adapters.submitSpecificationVideo(target('hmstudio','seedance_v2.5'),input({prompt,reference_images:['https://assets.invalid/a.png','https://assets.invalid/b.png']}),vi.fn());
    const payload=JSON.parse(send.mock.calls[0][1].body);
    expect(new Headers(send.mock.calls[0][1].headers).get('content-type')).toBe('application/json');
    expect(payload.prompt).toBe(prompt);
    expect(payload.model).toBe('MINIMAX-H3-2.5采样');expect(payload.function_mode).toBe('omni_reference');
    expect(payload.materials.map((m:any)=>m.url)).toEqual(['https://assets.invalid/a.png','https://assets.invalid/b.png']);
  });
  it('accepts an upstream task ID for a prompt above 8000 without truncating', async () => {
    const send=vi.fn().mockResolvedValue(json({task_id:'hm-long-accepted'},202)), started=vi.fn(); vi.stubGlobal('fetch',send);
    await expect(adapters.submitSpecificationVideo(target('hmstudio','seedance_v2.5'),input({prompt:'字'.repeat(12000)}),started)).resolves.toBe('hm-long-accepted');
    expect(JSON.parse(send.mock.calls[0][1].body).prompt).toBe('字'.repeat(12000));
    expect(send).toHaveBeenCalledOnce(); expect(started).toHaveBeenCalledOnce();
  });
  it('does not mark HM as sent when local audio preparation fails', async () => {
    const send = vi.fn(), started = vi.fn(); vi.stubGlobal('fetch', send);
    await expect(adapters.submitSpecificationVideo(target('hmstudio','sd2.5-301010'), input({audio_urls:['data:audio/mpeg;base64,YmFk']}), started))
      .rejects.toMatchObject({ outcome: 'rejected', message: expect.stringContaining('未发送上游') });
    expect(send).not.toHaveBeenCalled(); expect(started).not.toHaveBeenCalled();
  });
  it('maps nova sales routes and preserves 30 images, 10 videos and 10 audios', async () => {
    const send = vi.fn().mockResolvedValue(json({ task_id: 'nova-accepted' }, 202)); vi.stubGlobal('fetch', send);
    const request = input({ video_length: 30, resolution: '1080p',
      reference_images: Array(30).fill('https://assets.invalid/a.png'),
      reference_videos: Array(10).fill('https://assets.invalid/a.mp4'), audio_urls: Array(10).fill('https://assets.invalid/a.mp3') });
    expect(await adapters.submitSpecificationVideo(target('hmstudio', 'sd2.5-301010'), request, vi.fn())).toBe('nova-accepted');
    const payload = JSON.parse(send.mock.calls[0][1].body);
    expect(payload.model).toBe('30-10-10');
    expect(payload.channel).toBe('nova');
    expect(payload.video_resolution).toBe('1080p');
    expect(payload.duration).toBe(30);
    expect(payload.materials).toHaveLength(50);
    expect(existingModelLimits('sd2.5-301010', 'video')).toMatchObject({ maxImages: 30, maxVideos: 10, maxAudios: 10,
      resolutions: ['720p', '1080p'], duration: { min: 4, max: 30 } });
    send.mockClear();
    for (const patch of [{ video_length: 31 }, { resolution: '2k' }, { reference_images: Array(31).fill('https://assets.invalid/a.png') }]) {
      await expect(adapters.submitSpecificationVideo(target('hmstudio', 'sd2.5-301010'), input(patch), vi.fn())).rejects.toMatchObject({ retrySafe: true });
    }
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects unsupported reference/frame combinations before sending a request', async () => {
    const send=vi.fn();vi.stubGlobal('fetch',send);
    await expect(adapters.submitSpecificationVideo(target('hmstudio','seedance_v2.5'),input({reference_images:['https://assets.invalid/a.png'],first_frame:'https://assets.invalid/frame.png'}),vi.fn())).rejects.toMatchObject({retrySafe:true});
    expect(send).not.toHaveBeenCalled();
  });
  it('recovers accepted images with a GET to the original provider only', async () => {
    const send=vi.fn().mockResolvedValue(json({status:'succeeded'}));vi.stubGlobal('fetch',send);
    const result=await adapters.pollSpecificationImage({...channel(1),baseUrl:'https://llm.chre3.com'},'accepted image');
    expect(send.mock.calls[0][0]).toBe('https://llm.chre3.com/v1/images/generations/accepted%20image');
    expect(send.mock.calls[0][1].method).toBeUndefined();expect(result.status).toBe('completed');
  });
  it('does not treat a timed-out POST as an unaccepted request', async () => {
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(Object.assign(new Error('timeout'),{name:'TimeoutError'})));
    await expect(adapters.submitSpecificationVideo(target('openai','seedance-custom'),input(),vi.fn())).rejects.toMatchObject({uncertain:true,retrySafe:false});
  });
});


describe('existing queue integration', () => {
  it('switches from an unaccepted full HM queue without submitting or charging twice', async () => {
    saveModelSpecification(spec());
    vi.mocked(ChannelService.getActiveChannels).mockReturnValue([{...channel(1),type:'hmstudio'},channel(2)]);
    vi.spyOn(hmStudioQueue,'enqueue').mockImplementationOnce(() => { throw new HmStudioQueueFullError('队列已满'); });
    const submit=vi.spyOn(adapters,'submitSpecificationVideo').mockResolvedValue('accepted-backup');
    vi.spyOn(adapters,'pollSpecificationVideo').mockResolvedValue({status:'completed',progress:100,resultUrl:'https://result.invalid/video.mp4',error:''} as any);
    await handleSpecificationGeneration({body:{model:'routing-public-test',prompt:'test',video_length:15},headers:{},protocol:'https',get:()=> 'app.invalid',userId} as any,response(),'video');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0].channel.id).toBe(2);
    expect(db.select().from(contents).all().at(-1)!.status).toBe('completed');
    expect(db.select().from(users).where(eq(users.id,userId)).get()!.balance).toBe(98);
  });
});

describe('image entries by output resolution', () => {
  const sourceIds = ['gpt-image-2','gpt-image-2-siyuetian','gpt-image-2-mingfei'];
  function drafts() {
    for (const id of sourceIds) {
      db.insert(models).values({modelId:id,displayName:id,capabilities:'["image"]',provider:'test'}).onConflictDoNothing().run();
      db.update(models).set({isActive:1}).where(eq(models.modelId,id)).run();
    }
    sourceIds.forEach((id,i) => db.update(channels).set({supportedModels:JSON.stringify([id]),modelMapping:JSON.stringify({[id]:'gpt-image-2'})}).where(eq(channels.id,i+1)).run());
    return suggestedModelSpecifications().filter(s => s.imageFamily === 'gpt-image-2');
  }
  function save(draft: ReturnType<typeof drafts>[number]) {
    db.insert(models).values({modelId:draft.modelId,displayName:draft.displayName,provider:'routing',capabilities:'["image"]'}).onConflictDoNothing().run();
    return saveModelSpecification(draft);
  }
  it('creates one entry per resolution and combines 10/16-reference providers beneath it', () => {
    const items=drafts();
    expect(items.map(s=>s.modelId)).toEqual(['gpt-image-2-1k','gpt-image-2-2k','gpt-image-2-4k']);
    expect(items.map(s=>s.displayName)).toEqual(['GPT Image 2 · 1K','GPT Image 2 · 2K','GPT Image 2 · 4K']);
    for(const item of items) { expect(item.limits.resolutions).toHaveLength(1);expect(item.limits.maxImages).toBe(16);expect(item.aliases).toEqual(sourceIds); }
    expect([...new Set(items[0].routes.map(r=>r.executionModel))]).toEqual(sourceIds);
    expect([...new Set(items[1].routes.map(r=>r.executionModel))]).toEqual(sourceIds.slice(1));
    expect(getModelSpecification(items[0].modelId)).toBeUndefined();
  });
  it('keeps sibling resolutions available as drafts after the first specification is saved', () => {
    const items=drafts();save(items[0]);
    expect(drafts().map(s=>s.modelId)).toEqual(['gpt-image-2-2k','gpt-image-2-4k']);
    save(items[1]);save(items[2]);
    const publicIds=getEnabledPublicModels('image').map(m=>m.modelId);
    expect(publicIds).toEqual(expect.arrayContaining(items.map(s=>s.modelId)));
    for(const id of sourceIds)expect(publicIds).not.toContain(id);
  });
  it('resolves legacy names by resolution while keeping explicit specification IDs fixed', () => {
    drafts().forEach(save);
    expect(resolvePublicModelId('gpt-image-2',{resolution:'2k'})).toBe('gpt-image-2-2k');
    expect(resolvePublicModelId('gpt-image-2-siyuetian',{output_resolution:'4K'})).toBe('gpt-image-2-4k');
    expect(resolvePublicModelId('gpt-image-2-mingfei')).toBe('gpt-image-2-2k');
    expect(resolvePublicModelId('gpt-image-2',{quality:'low'})).toBe('gpt-image-2-1k');
    expect(resolvePublicModelId('gpt-image-2')).toBe('gpt-image-2-4k');
    expect(resolvePublicModelId('gpt-image-2-2k',{resolution:'4K'})).toBe('gpt-image-2-2k');
  });
  it('does not substitute a different resolution when the requested legacy specification is unavailable', () => {
    save(drafts()[0]);
    expect(()=>resolvePublicModelId('gpt-image-2',{resolution:'2K'})).toThrow('2K 规格尚未配置');
  });
  it('chooses the cheapest compatible channel within a resolution and filters reference counts', () => {
    const item=drafts()[1];item.routes.forEach(r=>{r.cost=r.executionModel.endsWith('mingfei')?.2:.05;});save(item);
    vi.mocked(ChannelService.getActiveChannels).mockReturnValue(sourceIds.map((id,i)=>({...channel(i+1),supportedModels:[id]})));
    const input={...request,images:9,resolution:'2K',ratio:'1:1'};
    expect(selectModelRoutes(item,input).map(t=>t.route.executionModel)).toEqual(sourceIds.slice(1));
    expect(selectModelRoutes(item,{...input,images:12}).map(t=>t.route.executionModel)).toEqual(['gpt-image-2-mingfei']);
    db.update(models).set({isActive:0}).where(eq(models.modelId,'gpt-image-2-mingfei')).run();
    expect(selectModelRoutes(item,{...input,images:12})).toEqual([]);
  });
  it('rejects changing an existing specification resolution and rejects multiple resolutions on one entry', () => {
    const item=drafts()[0];save(item);
    expect(()=>saveModelSpecification({...item,limits:{...item.limits,resolutions:['2K']}})).toThrow('输出分辨率不能修改');
    expect(()=>saveModelSpecification({...item,limits:{...item.limits,resolutions:['1K','2K']}})).toThrow('固定一个输出分辨率');
    expect(()=>specificationRequest({prompt:'test',resolution:'1K',output_resolution:'4K'},'image','')).toThrow('不一致');
  });
  it('rejects cross-family alias collisions while allowing sibling resolution aliases', () => {
    const items=drafts();save(items[0]);save(items[1]);
    db.insert(models).values({modelId:'another-image-family-4k',displayName:'another',provider:'routing',capabilities:'["image"]'}).onConflictDoNothing().run();
    expect(()=>saveModelSpecification({...items[2],modelId:'another-image-family-4k',imageFamily:'another'})).toThrow('模型已被其他规格关联');
  });
  it('rejects a mismatched explicit resolution before charging or contacting any provider', async () => {
    const item=drafts()[1];save(item);const generate=vi.spyOn(adapters,'generateSpecificationImage');
    const res=response();
    await handleSpecificationGeneration({body:{model:item.modelId,prompt:'test',resolution:'4K'},protocol:'https',get:()=> 'app.invalid',userId} as any,res,'image');
    expect(res.statusCode).toBe(400);expect(generate).not.toHaveBeenCalled();
    expect(db.select().from(users).where(eq(users.id,userId)).get()!.balance).toBe(100);
  });
  it('forwards the selected resolution through a legacy request and bills its public specification', async () => {
    const item=drafts()[1];save(item);item.routes.forEach(r=>{r.cost=.1;});saveModelSpecification(item);
    vi.mocked(ChannelService.getActiveChannels).mockReturnValue(sourceIds.map((id,i)=>({...channel(i+1),supportedModels:[id]})));
    sqlite.prepare("INSERT INTO model_pricing(model_pattern,billing_type,input_price,output_price,extra_params) VALUES(?,?,?,?,?)").run(item.modelId,'per_call',.3,0,'{}');
    const generate=vi.spyOn(adapters,'generateSpecificationImage').mockResolvedValue({imageUrl:'data:image/png;base64,eA==',reportedImageUrl:'https://result.invalid/image.png',taskId:'result-2k',raw:{}});
    await handleSpecificationGeneration({body:{model:'gpt-image-2',prompt:'test',resolution:'2K'},protocol:'https',get:()=> 'app.invalid',userId} as any,response(),'image');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0].route.executionModel).toBe('gpt-image-2-siyuetian');
    expect(generate.mock.calls[0][1].input.resolution).toBe('2K');
    expect(db.select().from(contents).all().at(-1)).toMatchObject({modelId:item.modelId,status:'completed',cost:.3});
    expect(db.select().from(users).where(eq(users.id,userId)).get()!.balance).toBe(99.7);
  });
});

describe('video sale boundaries and exact customer quotes', () => {
  it('rejects aliases with different billing units or prices', () => {
    db.update(modelPricing).set({billingType:'per_second',inputPrice:.1}).where(eq(modelPricing.modelPattern,'routing-alias-test')).run();
    expect(()=>saveModelSpecification(spec())).toThrow('用户计费单位不同');
    db.update(modelPricing).set({billingType:'per_call',inputPrice:3}).where(eq(modelPricing.modelPattern,'routing-alias-test')).run();
    expect(()=>saveModelSpecification(spec())).toThrow('用户售价不同');
    db.update(modelPricing).set({inputPrice:2,extraParams:JSON.stringify({'720p':4})}).where(eq(modelPricing.modelPattern,'routing-alias-test')).run();
    expect(()=>saveModelSpecification(spec())).toThrow('用户售价不同');
  });
  it('restores the original API ID and discovery entry if a saved alias price becomes incompatible', () => {
    saveModelSpecification(spec());
    expect(resolvePublicModelId('渠道入口')).toBe('routing-public-test');
    db.update(modelPricing).set({billingType:'per_second',inputPrice:.1}).where(eq(modelPricing.modelPattern,'routing-alias-test')).run();
    expect(resolvePublicModelId('routing-alias-test')).toBe('routing-alias-test');
    expect(resolvePublicModelId('渠道入口')).toBe('routing-alias-test');
    expect(getEnabledPublicModels('video').map(m=>m.modelId)).toEqual(expect.arrayContaining(['routing-public-test','routing-alias-test']));
    expect(quoteVideoRequest({model:'渠道入口',resolution:'720p',video_length:15})).toMatchObject({model:'routing-alias-test',cost:1.5,billingType:'per_second'});
  });
  it('preserves customer pricing when route costs change and calculates seconds versus calls', () => {
    const s=spec(); saveModelSpecification(s);
    expect(quoteVideoRequest({model:s.modelId,resolution:'720p',video_length:15}).cost).toBe(2);
    s.routes[0].cost=99; saveModelSpecification(s);
    expect(quoteVideoRequest({model:s.modelId,resolution:'720p',video_length:15}).cost).toBe(2);
    db.update(modelPricing).set({billingType:'per_second',inputPrice:.05,extraParams:JSON.stringify({'720p':.1})}).where(eq(modelPricing.modelPattern,s.modelId)).run();
    expect(quoteVideoRequest({model:s.modelId,resolution:'720p',video_length:15})).toMatchObject({rate:.1,cost:1.5,billingType:'per_second'});
    expect(quoteVideoRequest({model:s.modelId,resolution:'720p',video_length:5}).cost).toBe(.5);
    expect(db.select().from(contents).all()).toHaveLength(0);
    expect(db.select().from(users).where(eq(users.id,userId)).get()!.balance).toBe(100);
  });
  it('keeps an unconfirmed unit out of accurate cost comparison and refuses an assumed amount', () => {
    const s=spec(); s.routes[0]={...s.routes[0],costUnit:'unknown',cost:null}; saveModelSpecification(s);
    expect(routeRequestCost({...route(1),costUnit:'unknown'},request)).toBeNull();
    expect(selectModelRoutes(s,request).map(t=>t.channel.id)).toEqual([2,1]);
    s.routes[0].cost=1;
    expect(()=>saveModelSpecification(s)).toThrow('请先确认上游成本单位');
  });
  it('rejects an obsolete displayed total before creating or charging a managed video task', async () => {
    saveModelSpecification(spec());
    const submit=vi.spyOn(adapters,'submitSpecificationVideo');
    const res=response();
    await handleSpecificationGeneration({body:{model:'routing-public-test',prompt:'test',video_length:15,expectedCost:1.5},headers:{},protocol:'https',get:()=> 'app.invalid',userId} as any,res,'video');
    expect(submit).not.toHaveBeenCalled();
    expect(db.select().from(contents).all()).toHaveLength(0);
    expect(db.select().from(users).where(eq(users.id,userId)).get()!.balance).toBe(100);
    expect(res.statusCode).toBe(409);
    expect(()=>assertExpectedVideoCost({},2)).not.toThrow();
    expect(()=>assertExpectedVideoCost({expectedCost:2},2)).not.toThrow();
    expect(()=>assertExpectedVideoCost({expectedCost:'2'},2)).toThrow('预计消费金额无效');
  });
  it('does not quote disabled models, invalid durations or unsupported resolutions', () => {
    saveModelSpecification(spec());
    expect(()=>quoteVideoRequest({model:'routing-public-test',resolution:'720p',video_length:31})).toThrow('所选时长');
    expect(()=>quoteVideoRequest({model:'routing-public-test',resolution:'1080p',video_length:15})).toThrow('所选分辨率');
    expect(()=>quoteVideoRequest({model:'routing-public-test',resolution:'720p',video_length:NaN})).toThrow('有效的视频时长');
    db.update(models).set({isActive:0}).where(eq(models.modelId,'routing-public-test')).run();
    expect(()=>quoteVideoRequest({model:'routing-public-test',resolution:'720p',video_length:15})).toThrow('未开放');
  });
});

it('refuses to merge fixed-duration and variable-duration video services even at the same sale price',()=>{
  for(const id of ['sd2.5','xd-seedance-2.5-720p']) {
    db.insert(models).values({modelId:id,displayName:id,provider:'test',capabilities:'["video"]'}).onConflictDoNothing().run();
    db.delete(modelPricing).where(eq(modelPricing.modelPattern,id)).run();
    db.insert(modelPricing).values({modelPattern:id,billingType:'per_call',inputPrice:2,extraParams:'{}'}).run();
  }
  expect(()=>saveModelSpecification({modelId:'sd2.5',kind:'video',enabled:true,aliases:['xd-seedance-2.5-720p'],limits:existingModelLimits('sd2.5','video')!,routes:[]})).toThrow('时长规则不同');
});

it('uses separate duration-cost associations for the same channel without assuming one price for all durations',()=>{
  const s=spec();s.routes=[5,10].map((seconds,index)=>({...route(1),id:'duration-'+seconds,cost:index===0?.3:.5,
    limits:{...limits(),duration:{mode:'fixed' as const,min:seconds,max:seconds,step:1,values:[]}}}));
  saveModelSpecification(s);
  expect(selectModelRoutes(s,{...request,seconds:5}).map(r=>[r.route.id,r.cost])).toEqual([['duration-5',.3]]);
  expect(selectModelRoutes(s,{...request,seconds:10}).map(r=>[r.route.id,r.cost])).toEqual([['duration-10',.5]]);
  expect(selectModelRoutes(s,{...request,seconds:15})).toEqual([]);
});


describe('automatic failures never suspend routing', () => {
  it('allows immediate repeated submissions and never overrides operator switches', () => {
    const s = { ...spec(), routes: [route(1)] }; saveModelSpecification(s);
    noteRouteResult('1:0:upstream-1', false, '上游提交失败 (402)：insufficient credits', true);
    expect(getRouteHealth()['1:0:upstream-1']).toMatchObject({ state:'healthy', retryAt:0, probeUntil:0 });
    expect(specificationAvailability(s)).toEqual({ available:true });
    expect(claimRouteProbe('1:0:upstream-1')).toBe(true);
    expect(claimRouteProbe('1:0:upstream-1')).toBe(true);
    noteRouteResult('1:0:upstream-1', false, 'insufficient credits', true);
    expect(specificationAvailability(s)).toEqual({ available:true });
    noteRouteResult('1:0:upstream-1', true);
    expect(specificationAvailability(s)).toEqual({ available:true });
    s.routes[0].enabled = false;
    expect(specificationAvailability(s)).toEqual({ available:false, unavailableReason:'configuration' });
  });
  it.each(['blocked', 'cooldown'])('releases all historical %s states immediately', state => {
    const old = new Date(Date.now() - 120_000).toISOString();
    db.insert(settings).values({ key:'model_specification_health_v1', value:JSON.stringify({
      '1:0:upstream-1':{ state, lastError:'insufficient credits', updatedAt:old, failures:1, retryAt:Date.now()+60000, probeUntil:Date.now()+600000 },
      '2:0:upstream-2':{ state:'blocked', lastError:'invalid API key', updatedAt:old, failures:1, retryAt:0 },
    }) }).run();
    const health = getRouteHealth();
    expect(health['1:0:upstream-1']).toMatchObject({ state:'healthy', retryAt:0, probeUntil:0 });
    expect(claimRouteProbe('1:0:upstream-1')).toBe(true);
    expect(claimRouteProbe('2:0:upstream-2')).toBe(true);
    expect(health['2:0:upstream-2']).toMatchObject({ state:'healthy', retryAt:0, probeUntil:0, lastError:'invalid API key' });
    const stored = JSON.parse(db.select().from(settings).where(eq(settings.key,'model_specification_health_v1')).get()!.value);
    expect(stored['1:0:upstream-1'].state).toBe('healthy');
  });
  it.each(['上游提交失败 (401)：insufficient credits', 'invalid API key', 'permission denied', 'key expired', 'gateway timeout (504)', 'upstream busy'])('retains diagnostics without locking: %s', message => {
    noteRouteResult('1:0:upstream-1', false, message, true);
    expect(getRouteHealth()['1:0:upstream-1']).toMatchObject({ state:'healthy', retryAt:0, lastError:message });
    expect(claimRouteProbe('1:0:upstream-1')).toBe(true);
  });
  it('never reenables an operator-disabled route when old requests finish', () => {
    const s = spec(); s.routes[0].enabled = false; saveModelSpecification(s);
    noteRouteResult('1:0:upstream-1', false, 'invalid API key', true);
    noteRouteResult('1:0:upstream-1', false, 'insufficient credits', true);
    expect(selectModelRoutes(getModelSpecification(s.modelId)!, request).map(t => t.channel.id)).toEqual([2]);
    noteRouteResult('1:0:upstream-1', true);
    expect(selectModelRoutes(getModelSpecification(s.modelId)!, request).map(t => t.channel.id)).toEqual([2]);
  });
  it('keeps credit-exhausted routes selectable alongside backups', () => {
    const s = spec(); saveModelSpecification(s);
    noteRouteResult('1:0:upstream-1', false, 'insufficient credits', true);
    expect(specificationAvailability(s)).toEqual({ available:true });
    expect(selectModelRoutes(s, request).map(t => t.channel.id)).toEqual([1, 2]);
  });
});

describe('V6K sales-route protocol adapter', () => {
  const target = () => ({ route: { ...route(1), upstreamModel: 'TTsedanco2.5-480' }, channel: { ...channel(1), type: 'zongheng-v6k', baseUrl: 'https://www.v6k.top' }, cost: 2, healthKey: 'v6k-test' });
  const input = () => specificationRequest({ prompt: '场景', seconds: 30, resolution: '480p', ratio: '16:9' }, 'video', 'https://our.invalid');
  it('keeps an immediate terminal response and uses the new query path', async () => {
    const fetcher = vi.fn(async (_url: any, init: any) => init.method === 'POST'
      ? Response.json({ id: 'spec_v6k', status: 'completed' }) : Response.json({ id: 'spec_v6k', status: 'completed' }));
    vi.stubGlobal('fetch', fetcher);
    const starting = vi.fn();
    expect(await adapters.submitSpecificationVideo(target() as any, input(), starting)).toBe('spec_v6k');
    expect(starting).toHaveBeenLastCalledWith(expect.objectContaining({ zonghengProtocol: 'v6k', videoId: 'spec_v6k', zonghengInitialTask: { id: 'spec_v6k', status: 'completed' } }));
    expect(await adapters.pollSpecificationVideo(target().channel, 'spec_v6k')).toMatchObject({ status: 'completed', resultUrl: 'https://www.v6k.top/v1/videos/spec_v6k/content' });
    expect(fetcher.mock.calls[1][0]).toBe('https://www.v6k.top/v1/videos/spec_v6k');
  });
  it('does not classify a local persistence failure after acceptance as safe to resubmit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'accepted', status: 'queued' })));
    const starting = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('database unavailable'); });
    await expect(adapters.submitSpecificationVideo(target() as any, input(), starting)).rejects.toMatchObject({ retrySafe: false, uncertain: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
