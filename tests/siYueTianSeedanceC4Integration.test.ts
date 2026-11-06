import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/services/videoLocalizationService.js', () => ({ downloadAndLocalizeVideo: vi.fn(async () => '/uploads/h3.mp4') }));
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../server/db/index.js';
import { channels, contents, models, modelPricing, settings, users } from '../server/db/schema.js';
import { ChannelService } from '../server/services/channelService.js';
import { ensureSiYueTianMinimaxModel as ensureModel } from '../server/services/siYueTianMinimaxCatalog.js';
import { getModelSpecification } from '../server/services/modelRoutingService.js';
import { handleSpecificationGeneration, resumeSpecificationTasks } from '../server/services/specificationGenerationService.js';
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService.js';
import { reserveUserCharge } from '../server/services/billingReservation.js';
import { SI_YUE_TIAN_SEEDANCE_C4_MODEL as MODEL, SI_YUE_TIAN_SEEDANCE_C5_MODEL as C5, SI_YUE_TIAN_SEEDANCE_C5_UPSTREAM_MODEL as C5_UPSTREAM, siYueTianManagedVideoSpec } from '../shared/siYueTianManagedVideo.js';
const siYueTianMinimaxLimits = () => siYueTianManagedVideoSpec(MODEL)!.limits;
const ensureSiYueTianMinimaxModel = (sqlite: any) => ensureModel(sqlite, undefined, MODEL);
import { canvasVideoReferenceLimits } from '../shared/canvasVideoReferences.js';
import * as referenceValidation from '../server/services/imageReferenceValidationService.js';
import { VideoRecoveryService } from '../server/services/videoRecoveryService.js';
import { validateBatchInput } from '../server/routes/videoBatches.js';

let channelId: number;
const base = 'https://llm.chre3.com', taskId = 'task_minimax_original';
function response() {
  const res: any = { headersSent: false, writableEnded: false, destroyed: false };
  res.status = vi.fn(code => { res.statusCode = code; return res; }); res.json = vi.fn(body => { res.body = body; return res; });
  res.setHeader = vi.fn(); res.flushHeaders = vi.fn(() => { res.headersSent = true; }); res.write = vi.fn();
  res.end = vi.fn(() => { res.writableEnded = true; }); return res;
}
const request = (body: Record<string, unknown> = {}) => ({ userId: 1, headers: {}, protocol: 'https', get: () => 'app.example',
  body: { model: MODEL, prompt: '海边漫步', seconds: 15, aspect_ratio: '21:9', ...body } } as any);
const record = () => db.select().from(contents).all().at(-1)!;
const balance = () => db.select().from(users).all()[0].balance;
function enable() { db.update(models).set({ isActive: 1 }).where(eq(models.modelId, MODEL)).run(); }
function completed() {
  vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => Response.json(init?.method === 'POST'
    ? { id: taskId, status: 'queued' } : { id: taskId, status: 'completed', progress: '100%' })));
}
beforeEach(() => {
  vi.clearAllMocks();
  if (sqlite.prepare("SELECT name FROM sqlite_master WHERE name='video_submission_receipts'").get()) sqlite.exec('DELETE FROM video_submission_receipts');
  db.delete(contents).run(); db.delete(settings).run(); db.delete(models).run(); db.delete(channels).run(); db.delete(modelPricing).run(); db.delete(users).run();
  db.insert(users).values({ id: 1, email: 'h3@test.invalid', username: 'test', passwordHash: 'test', balance: 100 }).run();
  channelId = ChannelService.createChannel({ name: '四月天', type: 'openai', baseUrl: base + '/v1/', apiKey: 'test-only-key' });
  ensureSiYueTianMinimaxModel(sqlite);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
afterAll(() => sqlite.close());

describe('四月天 S4-seedance2.5 integration', () => {
  it('syncs the upstream name into the disabled public model and preserves an edited price', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: C5_UPSTREAM }, { id: 'unintegrated-siyuetian-video' }] })));
    expect(await ChannelService.syncModels(channelId)).toMatchObject({ models: [C5] });
    expect(db.select().from(models).where(eq(models.modelId, C5)).get()).toMatchObject({
      displayName: C5, isActive: 0, capabilities: '["video"]',
    });
    expect(getModelSpecification(C5)?.routes[0]).toMatchObject({ executionModel: C5, upstreamModel: C5_UPSTREAM, cost: 4.5 });
    expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern, C5)).get()).toMatchObject({ billingType: 'per_call', inputPrice: 5.5 });
    db.update(modelPricing).set({ inputPrice: 6.5 }).where(eq(modelPricing.modelPattern, C5)).run();
    await ChannelService.syncModels(channelId);
    expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern, C5)).get()?.inputPrice).toBe(6.5);
    expect(db.select().from(models).where(eq(models.modelId, C5_UPSTREAM)).get()).toBeUndefined();
  });

  it('generates under the public name at ¥5.50 using the upstream C5 ID and all reference media', async () => {
    ensureModel(sqlite, undefined, C5);
    db.update(models).set({ isActive: 1 }).where(eq(models.modelId, C5)).run();
    completed();
    vi.spyOn(referenceValidation, 'validateAndNormalizeImageReferences').mockImplementation(async images => images);
    const images = Array.from({ length: 30 }, (_, i) => `https://cdn.example/${i}.png`);
    const videos = Array.from({ length: 10 }, (_, i) => `https://cdn.example/${i}.mp4`);
    const audios = Array.from({ length: 10 }, (_, i) => `https://cdn.example/${i}.mp3`);
    await handleSpecificationGeneration(request({
      model: C5, seconds: 5, reference_images: images, video_urls: videos, audio_urls: audios,
    }), response(), 'video');
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toMatchObject({
      model: C5_UPSTREAM, duration: 5, aspect_ratio: '21:9', image_refs: images, video_refs: videos, audio_refs: audios,
    });
    expect(record()).toMatchObject({ modelId: C5, status: 'completed', cost: 5.5 });
    expect(balance()).toBe(94.5);
  });

  it.each([{ seconds: 4 }, { aspect_ratio: 'adaptive' }, { first_frame: 'https://cdn.example/start.png' }])(
    'rejects unlisted C5 capabilities before charging or submitting: %j', async body => {
      ensureModel(sqlite, undefined, C5);
      db.update(models).set({ isActive: 1 }).where(eq(models.modelId, C5)).run();
      const upstream = vi.fn();
      vi.stubGlobal('fetch', upstream);
      const res = response();
      await handleSpecificationGeneration(request({ model: C5, ...body }), res, 'video');
      expect(res.statusCode).toBe(400);
      expect(upstream).not.toHaveBeenCalled();
      expect(balance()).toBe(100);
    },
  );
});

describe('四月天 Seedance C4 integration', () => {
  it('supports 30-second adaptive requests at the confirmed per-call price', async () => {
    enable(); completed();
    await handleSpecificationGeneration(request({ seconds: 30, aspect_ratio: 'adaptive' }), response(), 'video');
    expect(record()).toMatchObject({ status: 'completed', cost: 6 });
    expect(JSON.parse((vi.mocked(fetch).mock.calls[0][1] as any).body)).toMatchObject({ model: MODEL, duration: 30, aspect_ratio: 'adaptive' });
    expect(balance()).toBe(94);
  });
  it('registers 6 yuan/call disabled, preserves admin pricing, switches and removed associations on reboot', () => {
    expect(db.select().from(models).all()[0]).toMatchObject({ modelId: MODEL, isActive: 0, capabilities: '["video"]' });
    expect(db.select().from(modelPricing).all()[0]).toMatchObject({ modelPattern: MODEL, billingType: 'per_call', inputPrice: 6 });
    expect(getModelSpecification(MODEL)?.limits).toEqual(siYueTianMinimaxLimits());
    expect(canvasVideoReferenceLimits(MODEL)).toEqual({ images: 30, videos: 10, audios: 10 });
    db.update(modelPricing).set({ inputPrice: 3.5 }).run(); enable();
    db.update(channels).set({ supportedModels: '[]', status: 0 }).run();
    ensureSiYueTianMinimaxModel(sqlite);
    expect(db.select().from(modelPricing).all()[0].inputPrice).toBe(3.5);
    expect(db.select().from(models).all()[0].isActive).toBe(1);
    expect(ChannelService.getChannelRaw(channelId)).toMatchObject({ supportedModels: '[]', status: 0 });
  });
  it('syncs advertised IDs with video capability without resetting price or activation', async () => {
    enable(); db.update(modelPricing).set({ inputPrice: 4 }).run();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: MODEL }] })));
    await ChannelService.syncModels(channelId);
    expect(db.select().from(models).all()[0]).toMatchObject({ modelId: MODEL, isActive: 1, capabilities: '["video"]' });
    expect(db.select().from(modelPricing).all()[0].inputPrice).toBe(4);
    expect(getModelSpecification(MODEL)?.routes).toHaveLength(1);
  });
  it('does not take over another provider product with the same ID', () => {
    db.update(models).set({ provider: 'unrelated' }).run();
    expect(() => ensureSiYueTianMinimaxModel(sqlite)).toThrow('已被其他产品占用');
  });
  it.each([{ seconds: 3 }, { seconds: 31 }, { seconds: 4.5 }, { seconds: 15, duration: 4 }, { resolution: '2K' }, { aspect_ratio: '2:3' },
    { reference_images: Array(31).fill('https://cdn.example/image.png') }, { video_urls: Array(11).fill('https://cdn.example/video.mp4') },
    { audio_urls: Array(11).fill('https://cdn.example/audio.mp3') },
    { first_frame: 'https://cdn.example/start.png', audio_urls: ['https://cdn.example/audio.mp3'] },
    { last_frame: 'https://cdn.example/end.png', reference_images: ['https://cdn.example/image.png'] },
  ])('rejects invalid inputs before saving/charging/sending: %j', async body => {
    enable(); const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const res = response(); await handleSpecificationGeneration(request(body), res, 'video');
    expect(res.statusCode).toBe(400); expect(upstream).not.toHaveBeenCalled();
    expect(db.select().from(contents).all()).toEqual([]); expect(balance()).toBe(100);
  });
  it('website submits once, persists ID before polling, localizes and charges exactly 6 yuan', async () => {
    enable();
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      if (init?.method === 'POST') {
        expect(url).toBe(base + '/v1/videos');
        expect(JSON.parse(init.body)).toEqual({ model: MODEL, prompt: '海边漫步', duration: 15, aspect_ratio: '21:9' });
        return Response.json({ id: taskId, status: 'queued' });
      }
      expect(JSON.parse(record().metadata)).toMatchObject({ upstreamTaskId: taskId, channelId });
      expect(url).toBe(base + '/v1/videos/' + taskId);
      return Response.json({ id: taskId, status: 'completed', progress: '100%' });
    }));
    await handleSpecificationGeneration(request(), response(), 'video');
    expect(record()).toMatchObject({ status: 'completed', cost: 6, resultUrl: '/uploads/h3.mp4' });
    expect(balance()).toBe(94); expect(fetch).toHaveBeenCalledTimes(2);
    expect(downloadAndLocalizeVideo).toHaveBeenCalledWith(base + '/v1/videos/' + taskId + '/content', taskId, MODEL, channelId, null, expect.any(Function));
  });
  it('batch validation uses the registered model limits rather than legacy defaults', () => {
    const input = { model: MODEL, resolution: '720p', aspect_ratio: '21:9', video_length: 15, autoRetry: false, maxRetries: 0,
      creatives: [{ prompt: '测试', count: 1, reference_images: Array(30).fill('https://cdn.example/image.png'),
        reference_videos: Array(10).fill('https://cdn.example/video.mp4'), audio_urls: Array(10).fill('https://cdn.example/audio.mp3') }] };
    expect(validateBatchInput(input).creatives[0].reference_images).toHaveLength(30);
    expect(() => validateBatchInput({ ...input, creatives: [{ ...input.creatives[0], reference_images: Array(31).fill('https://cdn.example/image.png') }] })).toThrow();
  });
  it.each([200, 400, 451])('ends an explicit error envelope (HTTP %s) and keeps its cause', async httpStatus => {
    enable(); vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'rejected_input', message: '输入被拒绝' } }, { status: httpStatus })));
    await handleSpecificationGeneration(request(), response(), 'video');
    expect(record()).toMatchObject({ status: 'failed', cost: 0 });
    expect(JSON.parse(record().metadata).error).toContain('rejected_input');
    expect(balance()).toBe(100); expect(fetch).toHaveBeenCalledOnce();
  });
  it('API service returns a local asynchronous handle while the same executor completes', async () => {
    enable(); completed(); const res = response();
    const token = { id: 1, userId: 1, allowedModels: [] };
    await handleSpecificationGeneration(request(), res, 'video', { token, reserve: amount => reserveUserCharge(1, amount, 'api_test') });
    expect(res.body).toMatchObject({ model: MODEL, status: 'queued', id: expect.stringMatching(/^task_\d+$/) });
    await vi.waitFor(() => expect(record().status).toBe('completed'));
    expect(record().cost).toBe(6); expect(balance()).toBe(94);
  });
  it.each(['references', 'frames'])('forwards all %s with selected ratio', async mode => {
    enable(); completed();
    vi.spyOn(referenceValidation, 'validateAndNormalizeImageReferences').mockImplementation(async images => images);
    const images = Array.from({ length: 30 }, (_, i) => `https://cdn.example/${i}.png`);
    const videos = Array.from({ length: 10 }, (_, i) => `https://cdn.example/${i}.mp4`);
    const audios = Array.from({ length: 10 }, (_, i) => `https://cdn.example/${i}.mp3`);
    const body = mode === 'references' ? { reference_images: images, video_urls: videos, audio_urls: audios }
      : { first_frame: images[0], last_frame: images[1] };
    await handleSpecificationGeneration(request(body), response(), 'video');
    expect(record()?.status).toBe('completed');
    const payload = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as any).body);
    expect(payload.aspect_ratio).toBe('21:9');
    expect(payload).toEqual(mode === 'references'
      ? { model: MODEL, prompt: '海边漫步', duration: 15, aspect_ratio: '21:9', image_refs: images, video_refs: videos, audio_refs: audios }
      : { model: MODEL, prompt: '海边漫步', duration: 15, aspect_ratio: '21:9', first_frame: images[0], last_frame: images[1] });
  });
  it.each([false, true])('ends immediate terminal failure with ID=%s and refunds once', async withId => {
    enable(); vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...(withId ? { id: taskId } : {}),
      status: 'failed', error: { code: 'invalid_request', message: '素材格式错误' } })));
    await handleSpecificationGeneration(request(), response(), 'video');
    expect(record()).toMatchObject({ status: 'failed', cost: 0 });
    expect(JSON.parse(record().metadata)).toMatchObject({ billingStatus: 'refunded', error: expect.stringContaining('素材格式错误') });
    if (withId) expect(JSON.parse(record().metadata).upstreamTaskId).toBe(taskId);
    resumeSpecificationTasks(); resumeSpecificationTasks();
    expect(balance()).toBe(100); expect(fetch).toHaveBeenCalledOnce();
  });
  it('recovers a task ID returned alongside 502 instead of resubmitting or refunding', async () => {
    enable(); vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => init?.method === 'POST'
      ? Response.json({ id: taskId, status: 'queued' }, { status: 502 }) : Response.json({ id: taskId, status: 'completed' })));
    await handleSpecificationGeneration(request(), response(), 'video');
    expect(record().status).toBe('completed'); expect(balance()).toBe(94); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(['missing_id', 'disconnect'])('does not repeat an uncertain submission: %s', async mode => {
    enable(); vi.stubGlobal('fetch', vi.fn(async () => {
      if (mode === 'disconnect') throw new TypeError('fetch failed');
      return Response.json({ status: 'queued' });
    }));
    await handleSpecificationGeneration(request(), response(), 'video');
    expect(JSON.parse(record().metadata).requiresReview).toBe(true);
    resumeSpecificationTasks(); resumeSpecificationTasks();
    expect(fetch).toHaveBeenCalledOnce(); expect(balance()).toBe(94);
  });
  it('temporary query 404 retains the original task and charge, then completes', async () => {
    enable(); vi.useFakeTimers(); let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => init?.method === 'POST'
      ? Response.json({ id: taskId }) : ++reads === 1 ? new Response('404 page not found', { status: 404 })
        : Response.json({ id: taskId, status: 'completed' })));
    const pending = handleSpecificationGeneration(request(), response(), 'video');
    await vi.advanceTimersByTimeAsync(100);
    expect(record().status).toBe('processing'); expect(balance()).toBe(94);
    await vi.advanceTimersByTimeAsync(12_100); await pending;
    expect(record().status).toBe('completed'); expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('a confirmed failed query ends the original task and refunds once', async () => {
    enable(); vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => Response.json(init?.method === 'POST'
      ? { taskId, status: 'queued' } : { id: taskId, status: 'failed', error: { code: 'generation_failed', message: '生成失败原因' } })));
    await handleSpecificationGeneration(request(), response(), 'video');
    expect(record()).toMatchObject({ status: 'failed', cost: 0 });
    expect(JSON.parse(record().metadata).error).toContain('generation_failed');
    resumeSpecificationTasks(); resumeSpecificationTasks(); expect(balance()).toBe(100); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('resumes the original task after a polling window instead of placing it in permanent review', async () => {
    enable(); vi.useFakeTimers(); let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
      if (init?.method === 'POST') return Response.json({ id: taskId });
      if (++reads === 1) {
        vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
        return Response.json({ id: taskId, status: 'in_progress', progress: '90%' });
      }
      return Response.json({ id: taskId, status: 'completed' });
    }));
    const pending = handleSpecificationGeneration(request(), response(), 'video');
    await vi.advanceTimersByTimeAsync(8_100); await pending;
    expect(record().status).toBe('processing'); expect(JSON.parse(record().metadata).requiresReview).not.toBe(true);
    resumeSpecificationTasks(); expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_100); resumeSpecificationTasks();
    await vi.advanceTimersByTimeAsync(100);
    expect(record().status).toBe('completed'); expect(fetch).toHaveBeenCalledTimes(3); expect(balance()).toBe(94);
  });
  it('retries saving the original completed result without querying or generating again', async () => {
    enable(); vi.useFakeTimers();
    vi.mocked(downloadAndLocalizeVideo).mockRejectedValueOnce(new Error('temporary storage error'));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: taskId, status: 'completed' })));
    const pending = handleSpecificationGeneration(request(), response(), 'video');
    await vi.advanceTimersByTimeAsync(100); expect(record().status).toBe('processing');
    await vi.advanceTimersByTimeAsync(8_100); await pending;
    expect(record().status).toBe('completed'); expect(fetch).toHaveBeenCalledOnce(); expect(balance()).toBe(94);
  });
  it('restart recovery only queries the persisted original task', async () => {
    const id = Number(db.insert(contents).values({ userId: 1, type: 'video', modelId: MODEL, title: '恢复', status: 'processing', cost: 6,
      metadata: JSON.stringify({ managedSpecification: true, channelId, videoId: taskId, upstreamTaskId: taskId, actualModel: MODEL, requestedModel: MODEL, reservedCost: 2, count: 1 }) }).run().lastInsertRowid);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: taskId, status: 'completed' })));
    resumeSpecificationTasks(); resumeSpecificationTasks();
    await vi.waitFor(() => expect(db.select().from(contents).where(eq(contents.id, id)).get()?.status).toBe('completed'));
    expect(fetch).toHaveBeenCalledOnce(); expect(vi.mocked(fetch).mock.calls[0][1]?.method).not.toBe('POST');
    expect(balance()).toBe(100);
  });
  it('administrator inspection uses the same succeeded normalization and content endpoint', async () => {
    const id = Number(db.insert(contents).values({ userId: 1, type: 'video', modelId: MODEL, title: '检查', status: 'processing',
      metadata: JSON.stringify({ managedSpecification: true, channelId, videoId: taskId, actualModel: MODEL }) }).run().lastInsertRowid);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: taskId, status: 'succeeded', progress: '100%' })));
    expect(await VideoRecoveryService.inspect(id)).toMatchObject({ status: 'completed', upstreamResultUrl: base + '/v1/videos/' + taskId + '/content' });
    expect(balance()).toBe(100); expect(fetch).toHaveBeenCalledOnce();
  });
});
