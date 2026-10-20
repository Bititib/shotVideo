import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const sqlite = new Database(':memory:'); return { sqlite, db: drizzle(sqlite) };
});
vi.mock('../server/services/videoLocalizationService.js', () => ({ downloadAndLocalizeVideo: vi.fn(async () => '/uploads/blobdraw-result.mp4') }));
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../server/db/index.js';
import { initDatabase } from '../server/db/seed.js';
import { channels, models, settings, users, contents, modelPricing } from '../server/db/schema.js';
import { ChannelService } from '../server/services/channelService.js';
import { getModelSpecification, saveModelSpecification, selectModelRoutes } from '../server/services/modelRoutingService.js';
import { handleSpecificationGeneration } from '../server/services/specificationGenerationService.js';
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService.js';
const upstreamModel = { id: 42, name: 'Test video', type: 'video', config: {
  video_modes: ['文生视频', '图生视频'], video_resolutions: ['720p'], video_aspect_ratios: ['16:9', '9:16'],
  video_duration_mode: 'options', video_duration_options: [5,10], video_reference_image_count: 3,
  video_reference_video_count: 0, video_reference_audio_count: 0, video_portrait_enabled: true,
} };
const ok = (data: unknown, status = 200) => Response.json({ code: 0, data }, { status });
let id = 0, userId = 0, modelId = '';
beforeAll(async () => {
  process.env.ADMIN_EMAIL = 'blobdraw-test@example.com'; process.env.ADMIN_PASSWORD = 'test-password-only';
  vi.stubGlobal('fetch', vi.fn(async () => ok([])));
  await initDatabase();
  userId = db.select().from(users).all()[0].id;
});
beforeEach(() => {
  if (sqlite.prepare("SELECT name FROM sqlite_master WHERE name='video_submission_receipts'").get()) sqlite.exec('DELETE FROM video_submission_receipts');
  db.delete(contents).run(); db.delete(channels).run(); db.delete(settings).where(eq(settings.key, 'model_specification_routes_v1')).run();
  db.delete(settings).where(eq(settings.key, 'model_specification_health_v1')).run();
  sqlite.prepare("DELETE FROM models WHERE provider='blobdraw'").run();
  sqlite.prepare("DELETE FROM model_pricing WHERE model_pattern LIKE 'blobdraw-%'").run();
  db.update(users).set({ balance: 100 }).where(eq(users.id, userId)).run();
  vi.stubGlobal('fetch', vi.fn(async () => ok([upstreamModel, { id: 42, type: 'image' }])));
  id = ChannelService.createChannel({ name: 'Test BlobDraw', type: 'blobdraw', baseUrl: 'https://www.iblob.cc', apiKey: 'test-secret-key' });
  modelId = 'blobdraw-' + id + '-42';
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => sqlite.close());
function response() {
  const res: any = { headersSent: false, writableEnded: false, destroyed: false, events: [] };
  res.status = vi.fn(code => { res.statusCode = code; return res; }); res.json = vi.fn(body => { res.body = body; return res; });
  res.setHeader = vi.fn(); res.flushHeaders = vi.fn(() => { res.headersSent = true; });
  res.write = vi.fn(text => { if (text.startsWith('data: ')) { try { res.events.push(JSON.parse(text.slice(6))); } catch {} } });
  res.end = vi.fn(() => { res.writableEnded = true; }); return res;
}
async function enable() {
  await ChannelService.syncModels(id);
  db.update(models).set({ isActive: 1 }).where(eq(models.modelId, modelId)).run();
  db.insert(modelPricing).values({ modelPattern: modelId, billingType: 'per_call', inputPrice: 2, outputPrice: 0 }).run();
}
describe('BlobDraw channel and managed generation integration', () => {
  it('tests and synchronizes the documented API, isolates IDs, and imports video capabilities', async () => {
    expect(await ChannelService.testChannel(id)).toMatchObject({ success: true });
    expect(await ChannelService.syncModels(id)).toEqual({ count: 1, added: 1, models: [modelId] });
    expect(ChannelService.getChannelRaw(id)?.baseUrl).toBe('https://www.iblob.cc/api/v1');
    const row = db.select().from(models).where(eq(models.modelId, modelId)).get()!;
    expect(row).toMatchObject({ capabilities: '["video"]', isActive: 0, displayName: 'Test video' });
    const spec = getModelSpecification(modelId)!;
    expect(spec.routes[0]).toMatchObject({ upstreamModel: '42', cost: null, costUnit: 'unknown' });
    expect(spec.limits.duration).toMatchObject({ mode: 'options', values: [5,10] });
    expect(selectModelRoutes(spec, { images: 0, videos: 0, audios: 0, outputs: 1, seconds: 5, resolution: '720p', ratio: '9:16', firstFrame: false, lastFrame: false })).toEqual([]);
    db.update(models).set({ isActive: 1 }).where(eq(models.modelId, modelId)).run();
    expect(ChannelService.findChannelForModel(modelId)?.id).toBe(id);
    expect(fetch).toHaveBeenCalledWith('https://www.iblob.cc/api/v1/models', expect.objectContaining({ headers: { 'X-API-Key': 'test-secret-key' } }));
  });
  it('preserves administrator overrides and enabled/disabled states on resynchronization', async () => {
    await enable();
    const spec = getModelSpecification(modelId)!;
    spec.enabled = false; spec.routes[0].enabled = false; spec.routes[0].cost = 0.3; spec.routes[0].costUnit = 'per_call';
    saveModelSpecification(spec);
    await ChannelService.syncModels(id);
    expect(getModelSpecification(modelId)).toMatchObject({ enabled: false, routes: [{ enabled: false, cost: 0.3 }] });
    expect(db.select().from(models).where(eq(models.modelId, modelId)).get()?.isActive).toBe(1);
  });
  it('keeps the previous catalog on authentication or malformed model configuration failures', async () => {
    await ChannelService.syncModels(id);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 401, message: 'invalid key' }, { status: 401 })));
    await expect(ChannelService.syncModels(id)).rejects.toThrow('invalid key');
    vi.stubGlobal('fetch', vi.fn(async () => ok([{ ...upstreamModel, config: {} }])));
    await expect(ChannelService.syncModels(id)).rejects.toThrow('配置不完整');
    expect(JSON.parse(ChannelService.getChannelRaw(id)!.supportedModels)).toEqual([modelId]);
    expect(getModelSpecification(modelId)).toBeDefined();
  });
  it('submits through the existing app workflow, saves task/idempotency metadata and localizes the result', async () => {
    await enable(); let posted: any;
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      if (String(url).endsWith('/models')) return ok([upstreamModel]);
      if (String(url).endsWith('/generations')) { posted = JSON.parse(options.body); return ok({ id: 900 }, 202); }
      return ok({ id: 900, status: 'completed', progress: 100, output: { url: '/storage/video.mp4' } });
    }));
    const res = response();
    expect(await handleSpecificationGeneration({ userId, headers: {}, body: { model: modelId, prompt: 'camera move', video_length: 5, aspect_ratio: '9:16', face_mode: 'native' }, protocol: 'https', get: () => 'app.example' } as any, res, 'video')).toBe(true);
    expect(db.select().from(contents).all().length, JSON.stringify(res.body)).toBeGreaterThan(0);
    const row = db.select().from(contents).all().at(-1)!;
    expect(row).toMatchObject({ status: 'completed', resultUrl: '/uploads/blobdraw-result.mp4', cost: 2 });
    const meta = JSON.parse(row.metadata);
    expect(meta).toMatchObject({ upstreamTaskId: '900', channelId: id, blobdrawPayload: { model_id: 42, face_mode: 'native' } });
    expect(meta.blobdrawIdempotencyKey).toBe(posted.idempotency_key);
    expect(downloadAndLocalizeVideo).toHaveBeenCalledWith('https://www.iblob.cc/storage/video.mp4', '900', modelId, id, null);
    expect(db.select().from(users).where(eq(users.id, userId)).get()?.balance).toBe(98);
  });
  it('keeps an uncertain submission for review with its exact payload instead of refunding and recreating', async () => {
    await enable();
    const fetcher = vi.fn(async url => { if (String(url).endsWith('/models')) return ok([upstreamModel]); throw new Error('timeout'); });
    vi.stubGlobal('fetch', fetcher);
    const res = response();
    await handleSpecificationGeneration({ userId, headers: {}, body: { model: modelId, prompt: 'camera move', video_length: 5, aspect_ratio: '9:16' }, protocol: 'https', get: () => 'app.example' } as any, res, 'video');
    expect(db.select().from(contents).all().length, JSON.stringify(res.body)).toBeGreaterThan(0);
    const row = db.select().from(contents).all().at(-1)!;
    expect(JSON.parse(row.metadata)).toMatchObject({ requiresReview: true, billingStatus: 'review', blobdrawPayload: { model_id: 42, type: 'video' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(db.select().from(users).where(eq(users.id, userId)).get()?.balance).toBe(98);
  });
});




describe('bb-2.5-301010 catalog identity', () => {
  const bb = { ...upstreamModel, name: 'bb-2.5-301010', config: {
    video_modes: ['文生视频','图生视频','多模态'], video_resolutions: ['720p'],
    video_aspect_ratios: ['16:9','9:16','1:1','4:3','3:4','21:9'],
    video_duration_mode: 'options', video_duration_options: Array.from({ length: 27 }, (_, i) => i + 4),
    video_reference_image_count: 30, video_reference_video_count: 10, video_reference_audio_count: 10,
  } };
  it('registers the exact requested public model and maintains channel-specific platform mappings', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok([bb])));
    expect(await ChannelService.syncModels(id)).toMatchObject({ models: ['bb-2.5-301010'] });
    expect(JSON.parse(ChannelService.getChannelRaw(id)!.modelMapping)).toEqual({ 'bb-2.5-301010': '42' });
    const spec = getModelSpecification('bb-2.5-301010')!;
    expect(spec.limits).toMatchObject({ maxImages: 30, maxVideos: 10, maxAudios: 10, ratios: ['16:9','9:16','1:1','4:3','3:4','21:9'], duration: { min: 4, max: 30 } });
    const second = ChannelService.createChannel({ name: 'Second BlobDraw', type: 'blobdraw', baseUrl: 'https://www.iblob.cc', apiKey: 'second-test-key' });
    vi.stubGlobal('fetch', vi.fn(async () => ok([{ ...bb, id: 77 }])));
    await ChannelService.syncModels(second);
    expect(JSON.parse(ChannelService.getChannelRaw(second)!.modelMapping)).toEqual({ 'bb-2.5-301010': '77' });
    expect(getModelSpecification('bb-2.5-301010')!.routes.map(r => [r.channelId, r.upstreamModel])).toEqual([[id,'42'],[second,'77']]);
    expect(db.select().from(models).where(eq(models.modelId, 'bb-2.5-301010')).get()?.isActive).toBe(0);
  });
  it('rejects ambiguous matching models without changing the channel configuration', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok([bb, { ...bb, id: 77 }])));
    await expect(ChannelService.syncModels(id)).rejects.toThrow('名称重复');
    expect(JSON.parse(ChannelService.getChannelRaw(id)!.supportedModels)).toEqual([]);
  });

  it('refreshes a changed platform ID while preserving model settings and route costs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok([bb])));
    await ChannelService.syncModels(id);
    const spec = getModelSpecification('bb-2.5-301010')!;
    spec.enabled = false; spec.routes[0].enabled = false;
    spec.routes[0].cost = 0.3; spec.routes[0].costUnit = 'per_call';
    saveModelSpecification(spec);
    vi.stubGlobal('fetch', vi.fn(async () => ok([{ ...bb, id: 78 }])));
    await ChannelService.syncModels(id);
    expect(getModelSpecification('bb-2.5-301010')).toMatchObject({
      enabled: false, routes: [{ upstreamModel: '78', enabled: false, cost: 0.3, costUnit: 'per_call' }],
    });
    expect(JSON.parse(ChannelService.getChannelRaw(id)!.modelMapping)).toEqual({ 'bb-2.5-301010': '78' });
    const updated = getModelSpecification('bb-2.5-301010')!;
    updated.routes[0].upstreamModel = 'custom-override'; saveModelSpecification(updated);
    await ChannelService.syncModels(id);
    expect(getModelSpecification('bb-2.5-301010')!.routes[0].upstreamModel).toBe('custom-override');
  });
});
