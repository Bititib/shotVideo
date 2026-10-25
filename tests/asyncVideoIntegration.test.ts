import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/services/videoLocalizationService.js', () => ({ downloadAndLocalizeVideo: vi.fn(async () => '/uploads/async-video-result.mp4') }));
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../server/db/index.js';
import { channels, contents, models, modelPricing, settings, users } from '../server/db/schema.js';
import { ChannelService } from '../server/services/channelService.js';
import { getModelSpecification, saveModelSpecification, selectModelRoutes } from '../server/services/modelRoutingService.js';
import { handleSpecificationGeneration, resumeSpecificationTasks } from '../server/services/specificationGenerationService.js';
import { pollSpecificationVideo, submitSpecificationVideo } from '../server/services/specificationAdapters.js';
import { VideoRecoveryService } from '../server/services/videoRecoveryService.js';
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService.js';
import { fetchAsyncVideoModels } from '../server/services/asyncVideoAdapter.js';
import { ensureVxLeSeedanceModel } from '../server/services/asyncVideoCatalogService.js';
import { VX_LE_SEEDANCE_MODEL, LEGACY_VX_LE_SEEDANCE_MODEL, asyncVideoPublicModelId } from '../shared/asyncVideo.js';
import * as referenceValidation from '../server/services/imageReferenceValidationService.js';

const key = 'private-async-video-key';
let channelId: number, modelId: string;
const input = { images: 0, videos: 0, audios: 0, outputs: 1, seconds: 10, resolution: 'default', ratio: '9:16', firstFrame: false, lastFrame: false };
const discovery = () => Response.json({ object: 'list', data: [{ id: 17, name: 'seedance-video', ratio: '9:16,16:9,1:1', seconds: '5,10,15' }] });
const response = () => {
  const res: any = { headersSent: false, writableEnded: false, destroyed: false };
  res.status = vi.fn(code => { res.statusCode = code; return res; }); res.json = vi.fn(body => { res.body = body; return res; });
  res.setHeader = vi.fn(); res.flushHeaders = vi.fn(() => { res.headersSent = true; }); res.write = vi.fn();
  res.end = vi.fn(() => { res.writableEnded = true; }); return res;
};
const request = (body: Record<string, unknown> = {}) => ({ userId: 1, headers: {}, protocol: 'https', get: () => 'app.example',
  body: { model: modelId, prompt: '海浪拍打礁石', seconds: 10, aspect_ratio: '9:16', ...body } } as any);

beforeEach(async () => {
  if (sqlite.prepare("SELECT name FROM sqlite_master WHERE name='video_submission_receipts'").get()) sqlite.exec('DELETE FROM video_submission_receipts');
  vi.clearAllMocks();
  db.delete(contents).run(); db.delete(settings).run(); db.delete(models).run(); db.delete(channels).run(); db.delete(modelPricing).run(); db.delete(users).run();
  db.insert(users).values({ id: 1, email: 'async@test.invalid', username: 'test', passwordHash: 'test', balance: 100 }).run();
  vi.stubGlobal('fetch', vi.fn(async () => discovery()));
  channelId = ChannelService.createChannel({ name: '异步视频测试', type: 'async-video', baseUrl: 'http://provider.invalid:8080/v1/', apiKey: key });
  modelId = (await ChannelService.syncModels(channelId)).models[0];
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => sqlite.close());
function enable() {
  db.update(models).set({ isActive: 1 }).where(eq(models.modelId, modelId)).run();
  db.insert(modelPricing).values({ modelPattern: modelId, billingType: 'per_call', inputPrice: 2, outputPrice: 0 }).run();
}

describe('documented async video channel', () => {
  it('discovers by name, retains advertised constraints and imports disabled models without assumed prices', async () => {
    expect(await ChannelService.testChannel(channelId)).toMatchObject({ success: true, message: expect.stringContaining('seedance-video') });
    expect(ChannelService.getChannelRaw(channelId)).toMatchObject({ baseUrl: 'http://provider.invalid:8080', maxRetries: 0 });
    expect(JSON.parse(ChannelService.getChannelRaw(channelId)!.modelMapping)[modelId]).toBe('seedance-video');
    expect(db.select().from(models).where(eq(models.modelId, modelId)).get()).toMatchObject({ isActive: 0, capabilities: '["video"]' });
    expect(getModelSpecification(modelId)).toMatchObject({ limits: { duration: { values: [5,10,15] }, ratios: ['9:16','16:9','1:1'], resolutions: ['default'], maxVideos: 0, maxAudios: 0 } });
    expect(db.select().from(modelPricing).all()).toEqual([]);
  });
  it.each([{ ratio: 'auto', seconds: '15' }, { ratio: '16:9', seconds: '5-15' }])('reports actual catalog names and invalid fields without changing bindings: %j', async advertised => {
    enable();
    const before = ChannelService.getChannelRaw(channelId)!;
    const spec = getModelSpecification(modelId);
    const upstream = vi.fn(async () => Response.json({ data: [
      { name: 'another-model', ...advertised }, { name: '2.0B', ratio: '9:16', seconds: '15' },
    ] }));
    vi.stubGlobal('fetch', upstream);
    const result = await ChannelService.testChannel(channelId);
    expect(result.success).toBe(false);
    expect(result.message).toContain('模型目录解析');
    expect(result.message).toContain('another-model');
    expect(result.message).toContain('2.0B');
    expect(result.message).toContain('ratio=' + JSON.stringify(advertised.ratio));
    expect(result.message).toContain('seconds=' + JSON.stringify(advertised.seconds));
    expect(ChannelService.getChannelRaw(channelId)).toMatchObject({ supportedModels: before.supportedModels,
      modelMapping: before.modelMapping, status: before.status, lastTestResult: result.message });
    expect(getModelSpecification(modelId)).toEqual(spec);
    expect(db.select().from(modelPricing).all()[0].inputPrice).toBe(2);
    expect(db.select().from(users).all()[0].balance).toBe(100);
    expect(db.select().from(contents).all()).toEqual([]);
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream.mock.calls[0][0]).toBe('http://provider.invalid:8080/v1/models');
  });
  it('reports a configured name absent from the live directory instead of treating connectivity as model availability', async () => {
    ChannelService.updateChannel(channelId, { modelMapping: { [modelId]: '2.0B' } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [
      { id: 17, name: 'actual-api-name', ratio: '9:16', seconds: '15' },
    ] })));
    const result = await ChannelService.testChannel(channelId);
    expect(result).toMatchObject({ success: false });
    expect(result.message).toContain('当前映射未在目录中列出=["2.0B"]');
    expect(result.message).toContain('actual-api-name');
    expect(JSON.parse(ChannelService.getChannelRaw(channelId)!.modelMapping)[modelId]).toBe('2.0B');
    expect(db.select().from(contents).all()).toEqual([]);
  });
  it('redacts the credential and omits unrelated provider fields in invalid catalog diagnostics', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [
      { name: '2.0B', ratio: key, seconds: '15', api_key: key, prompt: 'private-reference-text' },
    ] })));
    const result = await ChannelService.testChannel(channelId);
    expect(result.success).toBe(false);
    expect(result.message).toContain('2.0B');
    expect(result.message).toContain('密钥已隐藏');
    expect(result.message).not.toContain(key);
    expect(result.message).not.toContain('private-reference-text');
  });
  it('preserves administrator prices, custom limits and switches across resync', async () => {
    enable();
    const spec = getModelSpecification(modelId)!;
    spec.enabled = false; spec.limits.maxImages = 3; spec.routes[0].enabled = false;
    spec.routes[0].upstreamModel = 'custom-name'; saveModelSpecification(spec);
    await ChannelService.syncModels(channelId);
    expect(getModelSpecification(modelId)).toMatchObject({ enabled: false, limits: { maxImages: 3 }, routes: [{ enabled: false, upstreamModel: 'custom-name' }] });
    expect(db.select().from(modelPricing).all()[0].inputPrice).toBe(2);
  });
  it('validates discovery before changing saved configuration and removes unavailable models from routing', async () => {
    const before = ChannelService.getChannelRaw(channelId);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: 17, name: 'seedance-video', seconds: 'bad' }] })));
    await expect(ChannelService.syncModels(channelId)).rejects.toThrow('时长');
    expect(ChannelService.getChannelRaw(channelId)?.supportedModels).toBe(before?.supportedModels);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [] })));
    await ChannelService.syncModels(channelId); enable();
    expect(selectModelRoutes(getModelSpecification(modelId)!, input)).toEqual([]);
  });
  it('submits JSON references with the name and accepts numeric task IDs from HTTP 202', async () => {
    enable();
    const upstream = vi.fn(async () => Response.json({ task_id: 12345, status: 'pending', data: [] }, { status: 202 }));
    vi.stubGlobal('fetch', upstream);
    const starting = vi.fn();
    expect(await submitSpecificationVideo(selectModelRoutes(getModelSpecification(modelId)!, input)[0], {
      prompt: '海浪拍打礁石', input, images: ['https://images.example/ref.png'], videos: [], audios: [], firstFrame: '', lastFrame: '', body: {}, publicBaseUrl: 'https://app.example',
    }, starting)).toBe('12345');
    const [url, init] = upstream.mock.calls[0] as any;
    expect(url).toBe('http://provider.invalid:8080/v1/videos/generations');
    expect(JSON.parse(init.body)).toEqual({ model: 'seedance-video', prompt: '海浪拍打礁石', seconds: 10, aspect_ratio: '9:16', reference_images: ['https://images.example/ref.png'] });
    expect(init.headers.Authorization).toBe('Bearer ' + key); expect(starting).toHaveBeenCalledOnce();
  });
  it.each(['pending', 'processing', 'failed'])('normalizes %s without resolving a download URL', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status, error_message: status === 'failed' ? '生成失败' : '' })));
    expect(await pollSpecificationVideo(ChannelService.getChannelRaw(channelId), '12345')).toMatchObject({ status, resultUrl: '' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('resolves completed JSON to CDN media using authenticated GET even when the signed token is stale', async () => {
    const upstream = vi.fn(async (url: any) => Response.json(String(url).endsWith('/url')
      ? { task_id: 12345, url: 'https://cdn.example/video.mp4' }
      : { task_id: 12345, status: 'completed', download_url: 'http://evil.invalid/expired?token=old' }));
    vi.stubGlobal('fetch', upstream);
    expect(await pollSpecificationVideo(ChannelService.getChannelRaw(channelId), '12345')).toMatchObject({ status: 'completed', resultUrl: 'https://cdn.example/video.mp4' });
    expect(upstream.mock.calls.map(call => call[0])).toEqual(['http://provider.invalid:8080/v1/tasks/12345', 'http://provider.invalid:8080/v1/tasks/12345/url']);
    expect((upstream.mock.calls as any[]).every(call => call[1].headers.Authorization === 'Bearer ' + key)).toBe(true);
  });
  it.each(['completed', 'failed'])('settles website billing on confirmed %s', async status => {
    enable();
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => Response.json(init?.method === 'POST' ? { task_id: 12345 }
      : String(url).endsWith('/url') ? { url: 'https://cdn.example/video.mp4' } : { status, error: '生成失败' })));
    const res = response(); await handleSpecificationGeneration(request(), res, 'video');
    const record = db.select().from(contents).all().at(-1)!;
    expect(record, JSON.stringify(res.body)).toMatchObject({ status, cost: status === 'completed' ? 2 : 0 });
    expect(db.select().from(users).all()[0].balance).toBe(status === 'completed' ? 98 : 100);
    if (status === 'completed') expect(downloadAndLocalizeVideo).toHaveBeenCalledWith('https://cdn.example/video.mp4', '12345', modelId, channelId, null);
  });
  it.each([{ seconds: 6 }, { video_urls: ['https://cdn.example/ref.mp4'] }, { audio_urls: ['https://cdn.example/ref.mp3'] }])('rejects unsupported inputs before submission or billing: %j', async body => {
    enable(); const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const res = response(); await handleSpecificationGeneration(request(body), res, 'video');
    expect(res.statusCode).toBe(400); expect(upstream).not.toHaveBeenCalled();
    expect(db.select().from(users).all()[0].balance).toBe(100); expect(db.select().from(contents).all()).toEqual([]);
  });
  it('keeps a lost submission response for review without submitting twice', async () => {
    enable(); vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection lost'); }));
    await handleSpecificationGeneration(request(), response(), 'video');
    const record = db.select().from(contents).all().at(-1)!;
    expect(record.status).toBe('processing'); expect(JSON.parse(record.metadata)).toMatchObject({ requiresReview: true, billingStatus: 'review' });
    expect(fetch).toHaveBeenCalledOnce(); expect(db.select().from(users).all()[0].balance).toBe(98);
  });
  it('recovers the original accepted task using GET only, including the CDN resolver', async () => {
    const id = Number(db.insert(contents).values({ userId: 1, type: 'video', modelId, title: 'test', status: 'processing',
      metadata: JSON.stringify({ managedSpecification: true, channelId, videoId: '12345', actualModel: modelId, routingHealthKey: 'test', requestedModel: modelId }),
    }).run().lastInsertRowid);
    vi.stubGlobal('fetch', vi.fn(async (url: any) => Response.json(String(url).endsWith('/url') ? { url: 'https://cdn.example/video.mp4' } : { status: 'completed' })));
    expect(await VideoRecoveryService.inspect(id)).toMatchObject({ status: 'completed', upstreamResultUrl: 'https://cdn.example/video.mp4' });
    vi.mocked(fetch).mockClear(); resumeSpecificationTasks();
    await vi.waitFor(() => expect(db.select().from(contents).where(eq(contents.id, id)).get()?.status).toBe('completed'));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.every(call => !call[1]?.method || call[1].method === 'GET')).toBe(true);
  });
  it('does not include API credentials in query errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(key, { status: 401 })));
    await expect(fetchAsyncVideoModels(ChannelService.getChannelRaw(channelId)!)).rejects.toThrow('HTTP 401');
    await expect(fetchAsyncVideoModels(ChannelService.getChannelRaw(channelId)!)).rejects.not.toThrow(key);
  });

  function registerVxModel() {
    const channel = ChannelService.getChannelRaw(channelId)!;
    ensureVxLeSeedanceModel(channel);
    modelId = asyncVideoPublicModelId(channelId, VX_LE_SEEDANCE_MODEL);
    return channel;
  }
  it('pre-registers the confirmed 9-image, 15-second model without credentials or removing other bindings', () => {
    const previousModel = modelId;
    ChannelService.updateChannel(channelId, { apiKey: '' });
    vi.mocked(fetch).mockClear(); const channel = registerVxModel();
    ensureVxLeSeedanceModel(channel);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(ChannelService.getChannelRaw(channelId)!.supportedModels)).toEqual([previousModel, modelId]);
    expect(JSON.parse(ChannelService.getChannelRaw(channelId)!.modelMapping)[modelId]).toBe('2.0B');
    expect(db.select().from(models).where(eq(models.modelId, modelId)).all()).toHaveLength(1);
    const spec = getModelSpecification(modelId)!;
    expect(spec.limits).toMatchObject({ maxImages: 9, maxVideos: 0, maxAudios: 0, duration: { mode: 'fixed', min: 15, max: 15 } });
    expect(spec.routes[0].limits).toEqual(spec.limits);
    expect(db.select().from(models).where(eq(models.modelId, modelId)).get()?.isActive).toBe(0);
  });
  it('keeps confirmed constraints over broad upstream discovery and preserves route costs and manual switches', async () => {
    registerVxModel();
    const spec = getModelSpecification(modelId)!;
    spec.enabled = false; spec.routes[0].enabled = false; spec.routes[0].costUnit = 'per_call'; spec.routes[0].cost = 1.5;
    saveModelSpecification(spec);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: 9, name: VX_LE_SEEDANCE_MODEL, ratio: '9:16,16:9', seconds: '5,10,15' }] })));
    await ChannelService.syncModels(channelId);
    expect(getModelSpecification(modelId)).toMatchObject({ enabled: false, limits: { maxImages: 9, maxVideos: 0, maxAudios: 0, duration: { mode: 'fixed', min: 15, max: 15 } },
      routes: [{ enabled: false, cost: 1.5, costUnit: 'per_call', limits: { maxImages: 9, duration: { mode: 'fixed', min: 15, max: 15 } } }] });
  });
  it('corrects legacy bindings to 2.0B without replacing model IDs, prices or manual switches', async () => {
    const channel = ChannelService.getChannelRaw(channelId)!;
    const legacyId = asyncVideoPublicModelId(channelId, LEGACY_VX_LE_SEEDANCE_MODEL);
    db.insert(models).values({ provider: 'async-video', modelId: legacyId,
      displayName: channel.name + ' · ' + LEGACY_VX_LE_SEEDANCE_MODEL, capabilities: '["video"]', isActive: 1 }).run();
    const legacyRowId = db.select().from(models).where(eq(models.modelId, legacyId)).get()!.id;
    db.insert(modelPricing).values({ modelPattern: legacyId, billingType: 'per_call', inputPrice: 3, outputPrice: 0 }).run();
    const template = getModelSpecification(modelId)!;
    saveModelSpecification({ ...template, modelId: legacyId, enabled: false,
      routes: [{ ...template.routes[0], id: 'legacy-vx', executionModel: legacyId, upstreamModel: LEGACY_VX_LE_SEEDANCE_MODEL,
        enabled: false, cost: 1.5, costUnit: 'per_call' }] });
    ChannelService.updateChannel(channelId, { status: 0, supportedModels: [modelId, legacyId],
      modelMapping: { [modelId]: 'seedance-video', [legacyId]: LEGACY_VX_LE_SEEDANCE_MODEL } });

    expect(ensureVxLeSeedanceModel(channel)).toMatchObject({ added: 0, models: [legacyId] });
    expect(JSON.parse(ChannelService.getChannelRaw(channelId)!.supportedModels)).toEqual([modelId, legacyId]);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ name: '2.0B', ratio: '9:16,16:9', seconds: '5,10,15' }] })));
    expect(await ChannelService.syncModels(channelId)).toMatchObject({ added: 0, models: [legacyId] });
    expect(ChannelService.getChannelRaw(channelId)?.status).toBe(0);
    expect(JSON.parse(ChannelService.getChannelRaw(channelId)!.modelMapping)[legacyId]).toBe('2.0B');
    expect(db.select().from(models).where(eq(models.modelId, legacyId)).get()).toMatchObject({
      id: legacyRowId, displayName: channel.name + ' · 2.0B', isActive: 1 });
    expect(db.select().from(models).where(eq(models.modelId, asyncVideoPublicModelId(channelId, '2.0B'))).get()).toBeUndefined();
    expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern, legacyId)).get()?.inputPrice).toBe(3);
    expect(getModelSpecification(legacyId)).toMatchObject({ enabled: false,
      limits: { maxImages: 9, maxVideos: 0, maxAudios: 0 },
      routes: [{ id: 'legacy-vx', executionModel: legacyId, upstreamModel: '2.0B', enabled: false, cost: 1.5, costUnit: 'per_call',
        limits: { maxImages: 9, maxVideos: 0, maxAudios: 0 } }] });
  });
  it('forwards all nine image references and defaults an omitted duration to 15 seconds', async () => {
    registerVxModel(); enable();
    const images = Array.from({ length: 9 }, (_, i) => 'https://images.example/ref-' + i + '.png');
    const validate = vi.spyOn(referenceValidation, 'validateAndNormalizeImageReferences').mockResolvedValue(images);
    const upstream = vi.fn(async (url: any, init: any) => Response.json(init?.method === 'POST' ? { task_id: 12345 }
      : String(url).endsWith('/url') ? { url: 'https://cdn.example/video.mp4' } : { status: 'completed' }));
    vi.stubGlobal('fetch', upstream);
    try {
      const res = response(); await handleSpecificationGeneration(request({ seconds: undefined, reference_images: images }), res, 'video');
      expect(db.select().from(contents).all().at(-1), JSON.stringify(res.body)).toMatchObject({ status: 'completed', cost: 2 });
      const payload = JSON.parse((upstream.mock.calls[0] as any)[1].body);
      expect(payload).toEqual({ model: '2.0B', prompt: '海浪拍打礁石', seconds: 15, aspect_ratio: '9:16', reference_images: images });
      expect(payload.reference_images).toHaveLength(9);
    } finally { validate.mockRestore(); }
  });
  it.each([{ seconds: 10 }, { seconds: 30 }, { seconds: 15, reference_images: Array(10).fill('https://images.example/ref.png') },
    { seconds: 15, video_urls: ['https://cdn.example/ref.mp4'] }, { seconds: 15, audio_urls: ['https://cdn.example/ref.mp3'] }])('rejects invalid Vx model inputs before billing: %j', async body => {
    registerVxModel(); enable(); const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const res = response(); await handleSpecificationGeneration(request(body), res, 'video');
    expect(res.statusCode).toBe(400); expect(upstream).not.toHaveBeenCalled();
    expect(db.select().from(users).all()[0].balance).toBe(100); expect(db.select().from(contents).all()).toEqual([]);
  });
  it('rechecks confirmed image and duration limits even if administrator routing limits are loosened', async () => {
    registerVxModel(); enable();
    const target = selectModelRoutes(getModelSpecification(modelId)!, { ...input, seconds: 15 })[0];
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const starting = vi.fn();
    const req = { prompt: 'test', input, images: [], videos: [], audios: [], firstFrame: '', lastFrame: '', body: {}, publicBaseUrl: 'https://app.example' };
    await expect(submitSpecificationVideo(target, req, starting)).rejects.toThrow('15 秒');
    await expect(submitSpecificationVideo(target, { ...req, input: { ...input, seconds: 15 }, images: Array(10).fill('https://images.example/ref.png') }, starting)).rejects.toThrow('9 张');
    expect(upstream).not.toHaveBeenCalled(); expect(starting).not.toHaveBeenCalled();
  });
});
