import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/services/videoLocalizationService.js', () => ({ downloadAndLocalizeVideo: vi.fn(async () => '/uploads/megaby-result.mp4') }));
vi.mock('../server/services/videoDurationProbe.js', () => ({ probeVideoDurationSeconds: vi.fn(async () => 5), probeAudioDurationSeconds: vi.fn(async () => 5) }));
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../server/db/index.js';
import { channels, contents, models, modelPricing, settings, users } from '../server/db/schema.js';
import { ChannelService } from '../server/services/channelService.js';
import { getModelSpecification, saveModelSpecification, selectModelRoutes } from '../server/services/modelRoutingService.js';
import { handleSpecificationGeneration, resumeSpecificationTasks } from '../server/services/specificationGenerationService.js';
import { submitSpecificationVideo, pollSpecificationVideo } from '../server/services/specificationAdapters.js';
import { VideoRecoveryService } from '../server/services/videoRecoveryService.js';
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService.js';
import { probeVideoDurationSeconds, probeAudioDurationSeconds } from '../server/services/videoDurationProbe.js';
import { ensureMegabyModels } from '../server/services/megabyCatalogService.js';
import { MEGABY_BASE_URL, MEGABY_VIDEO_MODELS, megabyPublicModelId } from '../shared/megabyVideo.js';
import * as referenceValidation from '../server/services/imageReferenceValidationService.js';

const key = 'private-megaby-integration-key';
let channelId: number;
const modelId = megabyPublicModelId('videos-mini');
const input = { images: 0, videos: 0, audios: 0, outputs: 1, seconds: 5, resolution: '720p', ratio: '9:16', firstFrame: false, lastFrame: false };
const discovery = () => Response.json({ object: 'list', data: MEGABY_VIDEO_MODELS.map(id => ({ id, object: 'model', owned_by: 'video-api' })) });
function response() {
  const res: any = { headersSent: false, writableEnded: false, destroyed: false };
  res.status = vi.fn(code => { res.statusCode = code; return res; }); res.json = vi.fn(body => { res.body = body; return res; });
  res.setHeader = vi.fn(); res.flushHeaders = vi.fn(() => { res.headersSent = true; }); res.write = vi.fn();
  res.end = vi.fn(() => { res.writableEnded = true; }); return res;
}
const request = (body: Record<string, unknown> = {}) => ({ userId: 1, headers: {}, protocol: 'https', get: () => 'app.example',
  body: { model: modelId, prompt: '海浪拍打礁石', seconds: 5, aspect_ratio: '9:16', ...body } } as any);
function enable() {
  db.update(models).set({ isActive: 1 }).where(eq(models.modelId, modelId)).run();
  db.insert(modelPricing).values({ modelPattern: modelId, billingType: 'per_call', inputPrice: 2, outputPrice: 0 }).run();
}
beforeEach(async () => {
  if (sqlite.prepare("SELECT name FROM sqlite_master WHERE name='video_submission_receipts'").get()) sqlite.exec('DELETE FROM video_submission_receipts');
  vi.clearAllMocks();
  vi.mocked(probeVideoDurationSeconds).mockResolvedValue(5); vi.mocked(probeAudioDurationSeconds).mockResolvedValue(5);
  db.delete(contents).run(); db.delete(settings).run(); db.delete(models).run(); db.delete(channels).run(); db.delete(modelPricing).run(); db.delete(users).run();
  db.insert(users).values({ id: 1, email: 'megaby@test.invalid', username: 'test', passwordHash: 'test', balance: 100 }).run();
  vi.stubGlobal('fetch', vi.fn(async () => discovery()));
  channelId = ChannelService.createChannel({ name: 'Megaby 测试', type: 'megaby', baseUrl: MEGABY_BASE_URL + '/v1/', apiKey: key, maxRetries: 3 });
  await ChannelService.syncModels(channelId);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(() => sqlite.close());

describe('Megaby channel integration', () => {
  it('publishes unprefixed IDs and refuses unrelated name collisions', async () => {
    expect(db.select().from(models).all().map(m => m.modelId).sort()).toEqual(['videos-fast', 'videos-mini', 'videos-standard']);
    expect(db.select().from(models).all().every(m => m.displayName === m.modelId)).toBe(true);
    db.update(models).set({ provider: 'unrelated' }).where(eq(models.modelId, modelId)).run();
    await expect(ChannelService.syncModels(channelId)).rejects.toThrow('已被其他产品占用');
  });
  it.each([false, true])('handles immediate terminal rejection with task ID=%s and refunds once', async hasId => {
    enable();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...(hasId ? { task_id: 'videos-mini_terminal', id: 'videos-mini_terminal' } : {}),
      status: 'failed', error: { code: 'generation_failed', message: '上游已明确失败' } })));
    await handleSpecificationGeneration(request(), response(), 'video');
    const record = db.select().from(contents).all().at(-1)!;
    expect(record).toMatchObject({ status: 'failed', cost: 0 });
    expect(JSON.parse(record.metadata).requiresReview).not.toBe(true);
    expect(JSON.parse(record.metadata).error).toContain('generation_failed');
    expect(db.select().from(users).all()[0].balance).toBe(100);
    resumeSpecificationTasks(); resumeSpecificationTasks();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fetch).toHaveBeenCalledOnce();
    expect(db.select().from(users).all()[0].balance).toBe(100);
  });
  it('registers all three models disabled with documented limits and unknown costs', async () => {
    expect(await ChannelService.testChannel(channelId)).toMatchObject({ success: true });
    expect(ChannelService.getChannelRaw(channelId)).toMatchObject({ type: 'megaby', baseUrl: MEGABY_BASE_URL, maxRetries: 0 });
    expect(db.select().from(models).all()).toHaveLength(3);
    expect(db.select().from(models).all().every(m => m.isActive === 0 && m.capabilities === '["video"]')).toBe(true);
    expect(getModelSpecification(modelId)).toMatchObject({ limits: { maxImages: 9, maxVideos: 3, maxAudios: 3, duration: { min: 4, max: 15 } },
      routes: [{ upstreamModel: 'videos-mini', cost: null, costUnit: 'unknown' }] });
    expect(db.select().from(modelPricing).all()).toEqual([]);
    ChannelService.updateChannel(channelId, { baseUrl: MEGABY_BASE_URL + '/v1/', maxRetries: 5 });
    expect(ChannelService.getChannelRaw(channelId)).toMatchObject({ baseUrl: MEGABY_BASE_URL, maxRetries: 0 });
  });
  it('can register documented models without credentials or any network call for initial setup', () => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const id = ChannelService.createChannel({ name: 'Megaby 待配置', type: 'megaby', baseUrl: MEGABY_BASE_URL, status: 0 });
    ChannelService.updateChannel(id, { status: 0 });
    expect(ensureMegabyModels(ChannelService.getChannelRaw(id)!)).toMatchObject({ count: 3, added: 0 });
    expect(ChannelService.getChannelRaw(id)).toMatchObject({ apiKey: '', status: 0 });
    expect(upstream).not.toHaveBeenCalled();
    expect(getModelSpecification(modelId)?.routes).toHaveLength(2);
  });
  it('preserves manual prices, limits and switches across model synchronization', async () => {
    enable();
    const spec = getModelSpecification(modelId)!;
    spec.enabled = false; spec.limits.maxImages = 2; spec.routes[0].enabled = false; spec.routes[0].cost = 1.25; spec.routes[0].costUnit = 'per_call';
    saveModelSpecification(spec); ChannelService.updateChannel(channelId, { status: 0 });
    expect(await ChannelService.syncModels(channelId)).toMatchObject({ added: 0, count: 3 });
    expect(getModelSpecification(modelId)).toMatchObject({ enabled: false, limits: { maxImages: 2 }, routes: [{ enabled: false, cost: 1.25, costUnit: 'per_call' }] });
    expect(db.select().from(modelPricing).all()[0].inputPrice).toBe(2);
    expect(ChannelService.getChannelRaw(channelId)?.status).toBe(0);
  });
  it('validates discovery before mutation and stops routing unavailable models', async () => {
    const saved = ChannelService.getChannelRaw(channelId);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ name: 'videos-mini' }] })));
    await expect(ChannelService.syncModels(channelId)).rejects.toMatchObject({ code: 'INVALID_MODEL_LIST' });
    expect(ChannelService.getChannelRaw(channelId)?.supportedModels).toBe(saved?.supportedModels);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [] })));
    await ChannelService.syncModels(channelId); enable();
    expect(selectModelRoutes(getModelSpecification(modelId)!, input)).toEqual([]);
  });
  it('submits camelCase references and accepts task_id from HTTP 202 without retries', async () => {
    enable();
    const upstream = vi.fn(async () => Response.json({ task_id: 'videos-mini_job', id: 'videos-mini_job', status: 'queued' }, { status: 202 }));
    vi.stubGlobal('fetch', upstream); const starting = vi.fn();
    const images = Array.from({ length: 9 }, (_, i) => 'https://images.example/' + i + '.png');
    expect(await submitSpecificationVideo(selectModelRoutes(getModelSpecification(modelId)!, input)[0], {
      prompt: '海浪拍打礁石', input, images, videos: ['http://cdn.example/ref.mp4'], audios: ['https://cdn.example/ref.mp3'],
      firstFrame: '', lastFrame: '', body: {}, publicBaseUrl: 'https://app.example',
    }, starting)).toBe('videos-mini_job');
    const [url, init] = upstream.mock.calls[0] as any;
    expect(url).toBe(MEGABY_BASE_URL + '/v1/videos');
    expect(JSON.parse(init.body)).toEqual({ model: 'videos-mini', prompt: '海浪拍打礁石', duration: 5, ratio: '9:16', resolution: '720p',
      referenceImages: images, referenceVideos: ['http://cdn.example/ref.mp4'], referenceAudios: ['https://cdn.example/ref.mp3'] });
    expect(init.headers.Authorization).toBe('Bearer ' + key); expect(starting).toHaveBeenCalledTimes(2);
  });
  it.each([{ seconds: 3 }, { seconds: 16 }, { seconds: 5.5 }, { resolution: '1080p' }, { aspect_ratio: '4:3' },
    { reference_images: Array(10).fill('https://images.example/ref.png') }, { video_urls: Array(4).fill('https://cdn.example/ref.mp4') },
    { audio_urls: Array(4).fill('https://cdn.example/ref.mp3') }, { first_frame: 'https://images.example/first.png' }, { first_image: 'https://images.example/first.png' },
  ])('rejects unsupported input before billing %j', async body => {
    enable(); const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const res = response(); await handleSpecificationGeneration(request(body), res, 'video');
    expect(res.statusCode).toBe(400); expect(upstream).not.toHaveBeenCalled();
    expect(db.select().from(contents).all()).toEqual([]); expect(db.select().from(users).all()[0].balance).toBe(100);
  });
  it('rejects more than 15 seconds of actual reference media before billing', async () => {
    enable(); vi.mocked(probeVideoDurationSeconds).mockResolvedValue(8);
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const res = response(); await handleSpecificationGeneration(request({ video_urls: ['https://cdn.example/1.mp4', 'https://cdn.example/2.mp4'] }), res, 'video');
    expect(res.statusCode).toBe(400); expect(res.body.error).toContain('15 秒'); expect(upstream).not.toHaveBeenCalled();
    expect(db.select().from(contents).all()).toEqual([]); expect(db.select().from(users).all()[0].balance).toBe(100);
  });
  it.each(['completed', 'failed'])('settles billing only after confirmed %s and preserves native errors', async status => {
    enable();
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => Response.json(init?.method === 'POST' ? { task_id: 'videos-mini_job', status: 'queued' }
      : { task_id: 'videos-mini_job', status, metadata: status === 'completed' ? { content_url: MEGABY_BASE_URL + '/v1/videos/videos-mini_job/content' } : {},
        error: status === 'failed' ? { code: 'unsupported_material', message: '素材格式不被支持，请更换素材或转码后重试。' } : null })));
    const res = response(); await handleSpecificationGeneration(request({ seconds: undefined }), res, 'video');
    const record = db.select().from(contents).all().at(-1)!;
    expect(record, JSON.stringify(res.body)).toMatchObject({ status, cost: status === 'completed' ? 2 : 0 });
    expect(JSON.parse((vi.mocked(fetch).mock.calls[0][1] as any).body).duration).toBe(5);
    expect(db.select().from(users).all()[0].balance).toBe(status === 'completed' ? 98 : 100);
    if (status === 'completed') expect(downloadAndLocalizeVideo).toHaveBeenCalledWith(MEGABY_BASE_URL + '/v1/videos/videos-mini_job/content', 'videos-mini_job', modelId, channelId, null);
    else expect(JSON.parse(record.metadata)).toMatchObject({ error: expect.stringContaining('unsupported_material'), billingStatus: 'refunded' });
  });
  it('refunds an explicit HTTP 200 submission rejection with its native error code', async () => {
    enable(); vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'unsupported_request', message: '素材组合不被支持' } })));
    await handleSpecificationGeneration(request(), response(), 'video');
    const record = db.select().from(contents).all().at(-1)!;
    expect(record).toMatchObject({ status: 'failed', cost: 0 });
    expect(JSON.parse(record.metadata)).toMatchObject({ error: expect.stringContaining('unsupported_request') });
    expect(fetch).toHaveBeenCalledOnce(); expect(db.select().from(users).all()[0].balance).toBe(100);
  });
  it.each(['lost_response', 'missing_id'])('holds %s for review without a second submission or refund', async mode => {
    enable(); vi.stubGlobal('fetch', vi.fn(async () => { if (mode === 'lost_response') throw new Error('connection lost'); return Response.json({ status: 'queued' }); }));
    await handleSpecificationGeneration(request(), response(), 'video');
    const record = db.select().from(contents).all().at(-1)!;
    expect(record.status).toBe('processing'); expect(JSON.parse(record.metadata)).toMatchObject({ requiresReview: true, billingStatus: 'review' });
    expect(fetch).toHaveBeenCalledOnce(); expect(db.select().from(users).all()[0].balance).toBe(98);
  });
  it('keeps query failures separate from a confirmed failed task', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'server_error', message: '查询暂时不可用' } }, { status: 503 })));
    await expect(pollSpecificationVideo(ChannelService.getChannelRaw(channelId), 'videos-mini_job')).rejects.toMatchObject({
      code: 'server_error', confirmedFailure: false, upstreamStatus: 503,
    });
  });
  it('recovers accepted tasks after restart through GET only, including metadata content results', async () => {
    const id = Number(db.insert(contents).values({ userId: 1, type: 'video', modelId, title: 'test', status: 'processing',
      metadata: JSON.stringify({ managedSpecification: true, channelId, videoId: 'videos-mini_job', actualModel: modelId, requestedModel: modelId }),
    }).run().lastInsertRowid);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ task_id: 'videos-mini_job', status: 'completed', metadata: { content_url: 'https://cdn.example/metadata.mp4' } })));
    expect(await VideoRecoveryService.inspect(id)).toMatchObject({ status: 'completed', upstreamResultUrl: 'https://cdn.example/metadata.mp4' });
    vi.mocked(fetch).mockClear(); resumeSpecificationTasks();
    await vi.waitFor(() => expect(db.select().from(contents).where(eq(contents.id, id)).get()?.status).toBe('completed'));
    expect(fetch).toHaveBeenCalledOnce(); expect(vi.mocked(fetch).mock.calls[0][1]?.method).not.toBe('POST');
  });
  it('forwards image references normalized by the existing reference validation service', async () => {
    enable(); const images = ['https://images.example/authorized.png'];
    vi.spyOn(referenceValidation, 'validateAndNormalizeImageReferences').mockResolvedValue(images);
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => Response.json(init?.method === 'POST' ? { task_id: 'videos-mini_job' } : { status: 'completed' })));
    await handleSpecificationGeneration(request({ reference_images: images }), response(), 'video');
    expect(db.select().from(contents).all().at(-1)?.status).toBe('completed');
    expect(JSON.parse((vi.mocked(fetch).mock.calls[0][1] as any).body).referenceImages).toEqual(images);
  });
});
