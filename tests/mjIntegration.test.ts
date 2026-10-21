import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/routes/imageGen.js', () => ({ localizeGeneratedImage: vi.fn(async (_url, prefix) => '/api/uploads/' + prefix + '.png') }));
// Localization is mocked above; API serialization must not require those fixture files on disk.
vi.mock('../server/services/uploadAccess.js', async importOriginal => ({
  ...await importOriginal<typeof import('../server/services/uploadAccess.js')>(),
  issueUploadUrl: (url: string, base: string) => new URL(url, base).toString(),
}));
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../server/db/index.js';
import { channels, contents, models, modelPricing, settings, users } from '../server/db/schema.js';
import { ChannelService } from '../server/services/channelService.js';
import { getModelSpecification, saveModelSpecification, selectModelRoutes, specificationAvailability } from '../server/services/modelRoutingService.js';
import { handleSpecificationGeneration, resumeSpecificationTasks, recoverMjSpecificationImages, restoreLegacyMjCompletedImages } from '../server/services/specificationGenerationService.js';
import { mediaOwnerContext } from '../server/services/uploadAccess.js';
import imageFiles from 'node:fs';
import { generateSpecificationImage } from '../server/services/specificationAdapters.js';
import { localizeGeneratedImage } from '../server/routes/imageGen.js';
import { LEGACY_MJ_MODEL_ID, MJ_MODEL_ID, MJ_SIZES } from '../shared/mj.js';
import { mjBaseUrl } from '../server/services/mjAdapter.js';
import { routeRequestCost } from '../shared/modelRouting.js';
import { reserveUserCharge } from '../server/services/billingReservation.js';
import { resolveBillingReservation } from '../server/services/billingReconciliation.js';
import { sanitizeContentRoutingForClient } from '../server/services/contentService.js';
import { canvasRequestStore } from '../server/middleware/canvasRequest.js';

const key = 'private-mj-test-key';
const input = { images: 0, videos: 0, audios: 0, outputs: 4, seconds: 6,
  resolution: '1K', ratio: '1:1', firstFrame: false, lastFrame: false };
const discovery = () => Response.json({ data: ['mj_imagine', 'gpt-image-2', 'seedance-2.0', 'indextts2-v1'].map(id => ({ id })) });
let channelId: number;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(localizeGeneratedImage).mockReset().mockImplementation(async (_url, prefix) => '/api/uploads/' + prefix + '.png');
  for (const table of [contents, settings, models, channels, modelPricing, users]) db.delete(table).run();
  db.insert(users).values({ id: 1, email: 'mj@test.invalid', username: 'test', passwordHash: 'test', balance: 100 }).run();
  vi.stubGlobal('fetch', vi.fn(async () => discovery()));
  channelId = ChannelService.createChannel({ name: 'MJ', type: 'mj', baseUrl: 'https://mj-provider.example/v1/', apiKey: key });
  await ChannelService.syncModels(channelId);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
afterAll(() => sqlite.close());
function enable() {
  db.update(models).set({ isActive: 1 }).where(eq(models.modelId, MJ_MODEL_ID)).run();
  db.insert(modelPricing).values({ modelPattern: MJ_MODEL_ID, billingType: 'per_call', inputPrice: 2, outputPrice: 0 }).run();
}
function imageRequest(overrides: Record<string, any> = {}) {
  return { prompt: 'a paper boat', input, images: [], videos: [], audios: [], firstFrame: '', lastFrame: '',
    body: {}, publicBaseUrl: 'https://app.example', ...overrides };
}
function response() {
  const res: any = { headersSent: false, writableEnded: false, destroyed: false };
  res.status = vi.fn(code => { res.statusCode = code; return res; }); res.json = vi.fn(body => { res.body = body; return res; });
  res.setHeader = vi.fn(); res.flushHeaders = vi.fn(() => { res.headersSent = true; }); res.write = vi.fn();
  res.end = vi.fn(() => { res.writableEnded = true; }); return res;
}
const request = (body: Record<string, unknown> = {}) => ({ userId: 1, headers: {}, protocol: 'https', get: () => 'app.example',
  body: { model: MJ_MODEL_ID, prompt: 'a paper boat', ...body } } as any);

describe('MJ image channel', () => {
  const originalResults = [1, 2, 3, 4].map(n => 'https://mj-provider.example/v1/public/image/evt-original-' + n);
  async function gatewayTimeout() {
    enable();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!DOCTYPE html><html>gateway timeout</html>', { status: 504 })));
    await handleSpecificationGeneration(request(), response(), 'image');
    return db.select().from(contents).all()[0];
  }
  it('keeps a gateway timeout uncertain, explains it without HTML and never retries the paid POST', async () => {
    const record = await gatewayTimeout();
    const meta = JSON.parse(record.metadata);
    expect(meta).toMatchObject({ requiresReview: true, billingStatus: 'review', error: expect.stringContaining('504') });
    expect(meta.error).not.toContain('<html');
    expect(meta.error).toContain('任务可能已受理或完成');
    expect(meta.mjSubmissionDiagnostics).toMatchObject({ phase:'submit', httpStatus:504, reason:'gateway_timeout', elapsedMs:expect.any(Number) });
    expect(JSON.parse(sanitizeContentRoutingForClient(record).metadata)).not.toHaveProperty('mjSubmissionDiagnostics');
    expect(fetch).toHaveBeenCalledOnce();
    expect(db.select().from(users).all()[0].balance).toBe(98);
  });
  it('allows a separately requested new task after a 504 while never automatically resubmitting the uncertain one', async () => {
    await gatewayTimeout();
    expect(specificationAvailability(getModelSpecification(MJ_MODEL_ID)!)).toEqual({ available:true });
    await handleSpecificationGeneration(request(), response(), 'image');
    expect(fetch).toHaveBeenCalledTimes(2);
    const records = db.select().from(contents).all();
    expect(records).toHaveLength(2);
    expect(records.every(row => JSON.parse(row.metadata).requiresReview)).toBe(true);
    expect(db.select().from(users).all()[0].balance).toBe(96);
  });
  it.each([
    { status: 504, body: '<!DOCTYPE html><html>gateway timeout</html>', headers: { 'x-request-id': 'req-mj-gateway' }, id: 'req-mj-gateway' },
    { status: 502, body: JSON.stringify({ error: { task_id: 'task-mj-original' } }), headers: {}, id: 'task-mj-original' },
    { status: 200, body: '{interrupted-json', headers: { 'x-request-id': 'req-mj-interrupted' }, id: 'req-mj-interrupted' },
    { status: 200, body: JSON.stringify({ data: [], task_id: 'task-mj-no-url' }), headers: {}, id: 'task-mj-no-url' },
  ])('persists the original response identifier before review: $id', async ({ status, body, headers, id }) => {
    enable();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status, headers })));
    await handleSpecificationGeneration(request(), response(), 'image');
    const record = db.select().from(contents).get()!, meta = JSON.parse(record.metadata);
    expect(meta).toMatchObject({ requiresReview: true, billingStatus: 'review', upstreamTaskId: id,
      upstreamTaskIds: [id], upstreamResponses: [{ id, state: 'captured', httpStatus: status }] });
    for (const state of ['processing', 'review']) {
      db.update(contents).set({ status: state }).where(eq(contents.id, record.id)).run();
      resumeSpecificationTasks();
    }
    expect(fetch).toHaveBeenCalledOnce();
    expect(db.select().from(users).get()?.balance).toBe(98);
  });
  it('records no response without inventing a provider identifier or refunding an unknown submission', async () => {
    enable();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection interrupted'); }));
    await handleSpecificationGeneration(request(), response(), 'image');
    const meta = JSON.parse(db.select().from(contents).get()!.metadata);
    expect(meta).toMatchObject({ requiresReview: true, upstreamTaskId: '', upstreamTaskIds: [],
      upstreamResponses: [{ id: '', state: 'no_response' }], billingStatus: 'review' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(db.select().from(users).get()?.balance).toBe(98);
  });
  it('refunds an explicit rejection even when it includes a request tracing header', async () => {
    enable();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'invalid size' }, { status: 400,
      headers: { 'x-request-id': 'req-mj-rejected' } })));
    await handleSpecificationGeneration(request(), response(), 'image');
    const record = db.select().from(contents).get()!;
    expect(record).toMatchObject({ status: 'failed', cost: 0 });
    expect(JSON.parse(record.metadata)).toMatchObject({ upstreamTaskId: 'req-mj-rejected', billingStatus: 'refunded' });
    expect(db.select().from(users).get()?.balance).toBe(100);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('recovers four verified original results with the original funds and owner, then is idempotent', async () => {
    const record = await gatewayTimeout();
    vi.mocked(localizeGeneratedImage).mockImplementation(async (_url, prefix) => {
      expect(mediaOwnerContext.getStore()).toBe(1);
      return '/api/uploads/' + prefix + '.png';
    });
    expect(await recoverMjSpecificationImages(record.id, originalResults, 2, request())).toMatchObject({ status: 'completed' });
    const recovered = db.select().from(contents).all()[0], meta = JSON.parse(recovered.metadata);
    expect(recovered).toMatchObject({ status: 'completed', cost: 2 });
    expect(meta).toMatchObject({ requiresReview: false, error: null, billingStatus: 'settled', imageUrls: expect.any(Array), mjRecovery: { actorId: 2 } });
    expect(meta.imageUrls).toHaveLength(4);
    expect(JSON.parse(sanitizeContentRoutingForClient(recovered).metadata)).not.toHaveProperty('mjRecovery');
    expect(sqlite.prepare('SELECT state,actual FROM billing_reservations WHERE id=?').get(meta.billingReservationId)).toEqual({ state: 'settled', actual: 2 });
    expect(db.select().from(users).all()[0].balance).toBe(98);
    expect(fetch).toHaveBeenCalledOnce();
    expect(localizeGeneratedImage).toHaveBeenCalledTimes(4);
    expect(await recoverMjSpecificationImages(record.id, originalResults, 2, request())).toMatchObject({ alreadyRecovered: true });
    expect(localizeGeneratedImage).toHaveBeenCalledTimes(4);
  });
  it('preserves saved images and held funds after download interruption and resumes only missing originals', async () => {
    const record = await gatewayTimeout();
    vi.mocked(localizeGeneratedImage).mockResolvedValueOnce('/api/uploads/first.png').mockRejectedValueOnce(new Error('download interrupted'));
    await expect(recoverMjSpecificationImages(record.id, originalResults, 2, request())).rejects.toThrow('download interrupted');
    let meta = JSON.parse(db.select().from(contents).all()[0].metadata);
    expect(meta.nativeImageBatch.jobs[0].localUrl).toBe('/api/uploads/first.png');
    expect(sqlite.prepare('SELECT state FROM billing_reservations WHERE id=?').get(meta.billingReservationId)).toEqual({ state: 'review' });
    expect(db.select().from(users).all()[0].balance).toBe(98);
    await expect(recoverMjSpecificationImages(record.id, originalResults, 2, request())).resolves.toMatchObject({ status: 'completed' });
    meta = JSON.parse(db.select().from(contents).all()[0].metadata);
    expect(meta.imageUrls[0]).toBe('/api/uploads/first.png');
    expect(localizeGeneratedImage).toHaveBeenCalledTimes(5);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    ['https://other.example/v1/public/image/evt-1'],
    ['https://mj-provider.example/v1/private/image/evt-1'],
    ['https://mj-provider.example/v1/public/image/evt-1?key=secret'],
    ['http://mj-provider.example/v1/public/image/evt-1'],
    [...originalResults, 'https://mj-provider.example/v1/public/image/evt-extra'],
    Array(4).fill(originalResults[0]),
  ])('rejects unverified result addresses before downloading: %j', async (...urls) => {
    const record = await gatewayTimeout();
    await expect(recoverMjSpecificationImages(record.id, urls, 2, request())).rejects.toThrow();
    expect(localizeGeneratedImage).not.toHaveBeenCalled();
    expect(db.select().from(users).all()[0].balance).toBe(98);
  });
  it('rejects recovery when another operation refunded the original reservation', async () => {
    const record = await gatewayTimeout(), meta = JSON.parse(record.metadata);
    sqlite.prepare("UPDATE billing_reservations SET state='refunded',actual=0 WHERE id=?").run(meta.billingReservationId);
    await expect(recoverMjSpecificationImages(record.id, originalResults, 2, request())).rejects.toThrow('原预扣费用已变更');
    expect(localizeGeneratedImage).not.toHaveBeenCalled();
    expect(db.select().from(contents).all()[0].status).not.toBe('completed');
  });
  it('recovers one original as one intact image and settles the full per-call charge', async () => {
    const record = await gatewayTimeout();
    expect(await recoverMjSpecificationImages(record.id, [originalResults[0]], 2, request())).toMatchObject({ status: 'completed' });
    expect(localizeGeneratedImage).toHaveBeenCalledOnce();
    const saved = db.select().from(contents).all()[0];
    expect(JSON.parse(saved.metadata)).toMatchObject({ count: 1, imageUrls: [saved.resultUrl] });
    expect(saved.cost).toBe(2);
    expect(db.select().from(users).all()[0].balance).toBe(98);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([1,2,3,4])('saves %i upstream originals without cropping and charges one whole task', async count => {
    enable();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: originalResults.slice(0, count).map(url => ({ url })) })));
    await handleSpecificationGeneration(request(), response(), 'image');
    const saved = db.select().from(contents).all()[0], meta = JSON.parse(saved.metadata);
    expect(saved).toMatchObject({ status: 'completed', cost: 2 });
    expect(meta.count).toBe(count);
    expect(meta.imageUrls).toHaveLength(count);
    expect(localizeGeneratedImage).toHaveBeenCalledTimes(count);
    expect(fetch).toHaveBeenCalledOnce();
    expect(db.select().from(users).all()[0].balance).toBe(98);
  });
  it.each([true, false])('restores completed crops only when the original cache exists, without changing billing: %s', async cached => {
    enable();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: originalResults.map(url => ({ url })) })));
    await handleSpecificationGeneration(request(), response(), 'image');
    const saved = db.select().from(contents).all()[0], meta = JSON.parse(saved.metadata);
    const jobs = originalResults.map((_, index) => ({ index, sourceUrl: originalResults[0], localUrl: '/api/uploads/crop-' + index + '.png', status: 'completed' }));
    Object.assign(meta, { nativeImageBatch: { sourceUrls: [originalResults[0]], gridLocalUrl: '/api/uploads/intact.png', jobs }, imageUrls: jobs.map(job => job.localUrl) });
    db.update(contents).set({ metadata: JSON.stringify(meta), resultUrl: jobs[0].localUrl }).where(eq(contents.id, saved.id)).run();
    const reservation = sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(meta.billingReservationId);
    const exists = vi.spyOn(imageFiles, 'existsSync').mockReturnValue(cached);
    try {
      expect(restoreLegacyMjCompletedImages()).toBe(Number(cached));
      expect(restoreLegacyMjCompletedImages()).toBe(0);
      const repaired = db.select().from(contents).all()[0];
      expect(repaired).toMatchObject({ resultUrl: cached ? '/api/uploads/intact.png' : jobs[0].localUrl, status: 'completed', cost: 2 });
      if (cached) expect(JSON.parse(repaired.metadata)).toMatchObject({ count: 1, imageUrls: ['/api/uploads/intact.png'], nativeImageBatch: { legacyCroppedJobs: jobs } });
      else expect(repaired.metadata).toBe(JSON.stringify(meta));
      expect(sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(meta.billingReservationId)).toEqual(reservation);
      expect(db.select().from(users).all()[0].balance).toBe(98);
      expect(fetch).toHaveBeenCalledOnce();
    } finally { exists.mockRestore(); }
  });
  it('rejects a reservation belonging to another content record before any download', async () => {
    const record = await gatewayTimeout(), meta = JSON.parse(record.metadata);
    sqlite.prepare('UPDATE billing_reservations SET context=? WHERE id=?').run(JSON.stringify({ userId: 1, contentId: record.id + 1 }), meta.billingReservationId);
    await expect(recoverMjSpecificationImages(record.id, originalResults, 2, request())).rejects.toThrow('原预扣记录不匹配');
    expect(localizeGeneratedImage).not.toHaveBeenCalled();
  });
  it('blocks concurrent recovery while the original image is downloading', async () => {
    const record = await gatewayTimeout();
    let release!: (url: string) => void;
    let started!: () => void;
    const downloading = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(localizeGeneratedImage).mockImplementationOnce(() => new Promise(resolve => { release = resolve; started(); }));
    const first = recoverMjSpecificationImages(record.id, originalResults, 2, request());
    await downloading;
    try {
      await expect(recoverMjSpecificationImages(record.id, originalResults, 2, request())).rejects.toThrow('原任务不处于待核实状态');
    } finally { release('/api/uploads/first.png'); }
    await expect(first).resolves.toMatchObject({ status: 'completed' });
    expect(localizeGeneratedImage).toHaveBeenCalledTimes(4);
    expect(db.select().from(users).all()[0].balance).toBe(98);
  });
  it('uses a neutral public name and a server-side default endpoint', async () => {
    expect(MJ_MODEL_ID).toBe('mj-imagine-1k');
    expect(db.select().from(models).get()).toMatchObject({ provider:'mj', displayName:'MJ · 1K' });
    const defaultChannel = ChannelService.createChannel({ name:'MJ 默认', type:'mj', baseUrl:'', apiKey:key });
    await ChannelService.syncModels(defaultChannel);
    expect(ChannelService.getChannelRaw(defaultChannel)).toMatchObject({ type:'mj', baseUrl:'' });
    enable();
    const spec = getModelSpecification(MJ_MODEL_ID)!;
    const target = selectModelRoutes(spec, input).find(candidate => candidate.channel.id === defaultChannel)!;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data:[1,2,3,4].map(n => ({ url:'/v1/public/image/task-' + n })) })));
    await generateSpecificationImage(target, imageRequest(), vi.fn(), vi.fn());
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(mjBaseUrl('') + '/v1/images/generations');
    const res = response(); await handleSpecificationGeneration(request({ model:LEGACY_MJ_MODEL_ID }), res, 'image');
    expect(db.select().from(contents).get()?.modelId).toBe(MJ_MODEL_ID);
  });
  it('imports only MJ as a disabled image entry without converting upstream credits into a price', async () => {
    expect(await ChannelService.testChannel(channelId)).toMatchObject({ success: true });
    expect(db.select().from(models).all()).toEqual([expect.objectContaining({ modelId: MJ_MODEL_ID, capabilities: '["image"]', isActive: 0 })]);
    expect(ChannelService.getChannelRaw(channelId)).toMatchObject({ baseUrl: 'https://mj-provider.example', maxRetries: 0,
      supportedModels: JSON.stringify([MJ_MODEL_ID]), modelMapping: JSON.stringify({ [MJ_MODEL_ID]: 'mj_imagine' }) });
    expect(getModelSpecification(MJ_MODEL_ID)).toMatchObject({ imageFamily: 'mj-imagine', kind: 'image',
      limits: { resolutions: ['1K'], maxImages: 6, maxOutputs: 4, outputsPerTask: 4 }, routes: [{ cost: null, costUnit: 'unknown' }] });
    expect(db.select().from(modelPricing).all()).toEqual([]);
    ChannelService.updateChannel(channelId, { baseUrl: 'https://mj-provider.example/v1/', maxRetries: 4 });
    expect(ChannelService.getChannelRaw(channelId)).toMatchObject({ baseUrl: 'https://mj-provider.example', maxRetries: 0 });
  });
  it('preserves administrator settings across synchronization and adds a second channel to the same entry', async () => {
    enable();
    const spec = getModelSpecification(MJ_MODEL_ID)!;
    spec.enabled = false; spec.limits.maxImages = 2; spec.routes[0].enabled = false;
    spec.routes[0].costUnit = 'per_image'; spec.routes[0].cost = 0.5;
    saveModelSpecification(spec);
    await ChannelService.syncModels(channelId);
    expect(getModelSpecification(MJ_MODEL_ID)).toEqual(spec);
    expect(db.select().from(modelPricing).all()[0].inputPrice).toBe(2);
    const second = ChannelService.createChannel({ name: 'MJ second', type: 'mj', baseUrl: 'https://provider.example', apiKey: 'second-key' });
    await ChannelService.syncModels(second);
    expect(getModelSpecification(MJ_MODEL_ID)!.routes).toHaveLength(2);
    expect(db.select().from(models).all()).toHaveLength(1);
  });
  it('keeps saved configuration on invalid discovery and stops routing when MJ is removed', async () => {
    const before = ChannelService.getChannelRaw(channelId);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ name: 'mj_imagine' }] })));
    await expect(ChannelService.syncModels(channelId)).rejects.toThrow('格式');
    expect(ChannelService.getChannelRaw(channelId)).toEqual(before);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: 'other-image' }] })));
    expect(await ChannelService.testChannel(channelId)).toMatchObject({ success: false, message: expect.stringContaining('mj_imagine') });
    expect(await ChannelService.syncModels(channelId)).toMatchObject({ count: 0 });
    enable();
    expect(selectModelRoutes(getModelSpecification(MJ_MODEL_ID)!, input)).toEqual([]);
  });
  it.each(Object.entries(MJ_SIZES))('sends the documented 1K size for %s without quality parameters', async (ratio, size) => {
    enable();
    const target = selectModelRoutes(getModelSpecification(MJ_MODEL_ID)!, { ...input, ratio })[0];
    const upstream = vi.fn(async () => Response.json({ data: [{ url: 'https://cdn.example/mj.png' }] }));
    vi.stubGlobal('fetch', upstream);
    const start = vi.fn();
    expect(await generateSpecificationImage(target, imageRequest({ input: { ...input, ratio } }), start, vi.fn()))
      .toMatchObject({ imageUrl: 'https://cdn.example/mj.png' });
    const [url, init] = upstream.mock.calls[0] as any;
    expect(url).toBe('https://mj-provider.example/v1/images/generations');
    expect(init.headers).toEqual({ Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ model: 'mj_imagine', prompt: 'a paper boat', size, async: true });
    expect(Math.max(...size.split('x').map(Number))).toBeLessThan(1800);
    expect(start).toHaveBeenCalledOnce();
  });
  it.each([1, 6])('uploads all %i reference images as files with their original MIME types', async count => {
    enable();
    const images = Array.from({ length: count }, (_, i) => 'data:image/png;base64,' + Buffer.from('reference-' + i).toString('base64'));
    const target = selectModelRoutes(getModelSpecification(MJ_MODEL_ID)!, { ...input, images: count })[0];
    const upstream = vi.fn(async () => Response.json({ data: [{ url: '/v1/public/image/mj-id' }] }));
    vi.stubGlobal('fetch', upstream);
    await generateSpecificationImage(target, imageRequest({ input: { ...input, images: count }, images }), vi.fn(), vi.fn());
    const [url, init] = upstream.mock.calls[0] as any;
    expect(url).toBe('https://mj-provider.example/v1/images/edits');
    expect(init.headers).toEqual({ Authorization: 'Bearer ' + key });
    const form: FormData = init.body;
    expect(form.get('model')).toBe('mj_imagine'); expect(form.get('size')).toBe('1024x1024');
    expect(form.get('async')).toBe('true');
    const files = form.getAll(count === 1 ? 'image' : 'image[]') as File[];
    expect(files).toHaveLength(count);
    for (const [index, file] of files.entries()) {
      expect(file.type).toBe('image/png'); expect(await file.text()).toBe('reference-' + index);
    }
  });
  it('rejects unsupported input before any request even when routing limits were loosened', async () => {
    enable(); const target = selectModelRoutes(getModelSpecification(MJ_MODEL_ID)!, input)[0];
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    for (const override of [{ images: Array(7).fill('data:image/png;base64,eA==') }, { input: { ...input, resolution: '2K' } },
      { input: { ...input, ratio: '7:2' } }, { audios: ['audio'] }, { images: ['https://external.example/ref.png'] },
      { body: { quality: 'high' } }, { body: { size: '2048x2048' } }]) {
      await expect(generateSpecificationImage(target, imageRequest(override), vi.fn(), vi.fn())).rejects.toMatchObject({ retrySafe: true, uncertain: false });
    }
    expect(upstream).not.toHaveBeenCalled();
  });
  it('saves all four native results using one upstream request and one charge', async () => {
    enable(); vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [1,2,3,4].map(n => ({ url: 'https://cdn.example/mj-' + n + '.png' })) })));
    const res = response(); await handleSpecificationGeneration(request(), res, 'image');
    const record = db.select().from(contents).all()[0];
    expect(record, JSON.stringify(res.body)).toMatchObject({ status: 'completed', cost: 2, resultUrl: '/api/uploads/mj_' + record.id + '_0.png' });
    expect(JSON.parse(record.metadata)).toMatchObject({ count: 4, nativeImageOutputs: 4, billingStatus: 'settled', imageUrls: [0,1,2,3].map(n => '/api/uploads/mj_' + record.id + '_' + n + '.png') });
    expect(db.select().from(users).all()[0].balance).toBe(98);
    expect(localizeGeneratedImage).toHaveBeenCalledTimes(4);
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse((vi.mocked(fetch).mock.calls[0][1] as any).body)).toEqual({ model: 'mj_imagine', prompt: 'a paper boat', size: '1024x1024', async: true });
  });
  it.each([{ resolution: '2K' }, { n: 2 }, { reference_images: Array(7).fill('data:image/png;base64,eA==') }])
    ('rejects invalid website limits before charging: %j', async body => {
      enable(); const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
      const res = response(); await handleSpecificationGeneration(request(body), res, 'image');
      expect(res.statusCode).toBe(400); expect(upstream).not.toHaveBeenCalled();
      expect(db.select().from(users).all()[0].balance).toBe(100);
    });
  it.each(['lost-response', 'missing-url'])('retains uncertain submissions for review without a duplicate request: %s', async mode => {
    enable(); vi.stubGlobal('fetch', vi.fn(async () => {
      if (mode === 'lost-response') throw new Error('connection lost');
      return Response.json({ data: [] });
    }));
    await handleSpecificationGeneration(request(), response(), 'image');
    expect(JSON.parse(db.select().from(contents).all()[0].metadata)).toMatchObject({ requiresReview: true, billingStatus: 'review' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(db.select().from(users).all()[0].balance).toBe(98);
  });
  it('resumes interrupted result saving without another generation or another charge', async () => {
    enable();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [1,2,3,4].map(n => ({ url: 'https://cdn.example/' + n + '.png' })) })));
    vi.mocked(localizeGeneratedImage).mockRejectedValueOnce(new Error('download interrupted'));
    await handleSpecificationGeneration(request({ n: 4 }), response(), 'image');
    const record = db.select().from(contents).all()[0];
    expect(JSON.parse(record.metadata)).toMatchObject({ requiresReview: true, nativeImageBatch: { sourceUrls: expect.any(Array) }, mjSubmissionDiagnostics: { phase:'save', reason:'result_save' } });
    resumeSpecificationTasks();
    await vi.waitFor(() => expect(db.select().from(contents).all()[0].status).toBe('completed'));
    expect(JSON.parse(db.select().from(contents).all()[0].metadata).imageUrls).toHaveLength(4);
    expect(fetch).toHaveBeenCalledOnce(); expect(db.select().from(users).all()[0].balance).toBe(98);
  });
  async function interruptedOriginal() {
    enable();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ url: originalResults[0] }] })));
    vi.mocked(localizeGeneratedImage).mockRejectedValueOnce(new Error('download interrupted'));
    await handleSpecificationGeneration(request(), response(), 'image');
    const record = db.select().from(contents).get()!;
    db.update(contents).set({ status: 'review' }).where(eq(contents.id, record.id)).run();
    return { record, meta: JSON.parse(record.metadata) };
  }
  it('resumes an explicit review row with a known original URL, preserving ownership and clearing the stale error', async () => {
    const { record, meta } = await interruptedOriginal();
    vi.mocked(localizeGeneratedImage).mockImplementation(async (_url, prefix) => {
      expect(mediaOwnerContext.getStore()).toBe(record.userId);
      return '/api/uploads/' + prefix + '.png';
    });
    resumeSpecificationTasks(); resumeSpecificationTasks();
    await vi.waitFor(() => expect(db.select().from(contents).get()?.status).toBe('completed'));
    const completed = db.select().from(contents).get()!;
    expect(JSON.parse(completed.metadata)).toMatchObject({ count: 1, requiresReview: false,
      error: null, failureReason: null, billingStatus: 'settled' });
    expect(sqlite.prepare('SELECT state,actual FROM billing_reservations WHERE id=?').get(meta.billingReservationId))
      .toEqual({ state: 'settled', actual: 2 });
    expect(completed.cost).toBe(2);
    expect(localizeGeneratedImage).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledOnce();
    expect(db.select().from(users).get()?.balance).toBe(98);
  });
  it('skips original-result recovery after the held funds have been refunded', async () => {
    const { meta } = await interruptedOriginal();
    resolveBillingReservation(meta.billingReservationId, 2, 0, 'confirmed provider failure');
    resumeSpecificationTasks();
    expect(localizeGeneratedImage).toHaveBeenCalledOnce();
    expect(db.select().from(contents).get()).toMatchObject({ status: 'review', cost: 0 });
    expect(db.select().from(users).get()?.balance).toBe(100);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('does not mark success or recharge if an administrator refunds while the original is downloading', async () => {
    const { meta } = await interruptedOriginal();
    vi.mocked(localizeGeneratedImage).mockImplementationOnce(async () => {
      resolveBillingReservation(meta.billingReservationId, 2, 0, 'confirmed provider failure');
      return '/api/uploads/original-after-refund.png';
    });
    resumeSpecificationTasks();
    await vi.waitFor(() => expect(JSON.parse(db.select().from(contents).get()!.metadata).nativeImageBatch.jobs[0].localUrl)
      .toBe('/api/uploads/original-after-refund.png'));
    const record = db.select().from(contents).get()!;
    expect(record).toMatchObject({ status: 'review', cost: 0 });
    expect(JSON.parse(record.metadata)).toMatchObject({ billingStatus: 'refunded' });
    expect(sqlite.prepare('SELECT state,actual FROM billing_reservations WHERE id=?').get(meta.billingReservationId))
      .toEqual({ state: 'refunded', actual: 0 });
    expect(db.select().from(users).get()?.balance).toBe(100);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('prices a native four-image task as one call and preserves all results for API clients', async () => {
    enable();
    const spec = getModelSpecification(MJ_MODEL_ID)!;
    expect(routeRequestCost({ ...spec.routes[0], cost: 2, costUnit: 'per_call' }, input)).toBe(2);
    expect(routeRequestCost({ ...spec.routes[0], cost: 0.5, costUnit: 'per_image' }, input)).toBe(2);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [1,2,3,4].map(n => ({ url: 'https://cdn.example/' + n + '.png' })) })));
    await handleSpecificationGeneration(request({ n: 1 }), response(), 'image');
    expect(JSON.parse(db.select().from(contents).all()[0].metadata).imageUrls).toHaveLength(4);
    expect(db.select().from(users).all()[0].balance).toBe(98); expect(fetch).toHaveBeenCalledOnce();
  });
  it('accepts two actual upstream originals without inventing two more images', async () => {
    enable();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [1,2].map(n => ({ url: 'https://cdn.example/' + n + '.png' })) })));
    await handleSpecificationGeneration(request(), response(), 'image');
    const meta = JSON.parse(db.select().from(contents).all()[0].metadata);
    expect(meta).toMatchObject({ requiresReview: false, billingStatus: 'settled', count: 2 });
    expect(meta.imageUrls).toHaveLength(2);
    expect(fetch).toHaveBeenCalledOnce(); expect(db.select().from(users).all()[0].balance).toBe(98);
  });
  it('refunds one charge for an explicitly rejected task', async () => {
    enable(); vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'invalid input' } }, { status: 400 })));
    await handleSpecificationGeneration(request(), response(), 'image');
    expect(db.select().from(contents).all()[0]).toMatchObject({ status: 'failed', cost: 0 });
    expect(db.select().from(users).all()[0].balance).toBe(100); expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([400, 402, 403].flatMap(status => ['workbench', 'api'].map(transport => ({ status, transport }))))
    ('retains the upstream credit rejection, displays a clear reason and refunds once: $transport / $status', async ({ status, transport }) => {
      enable();
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error:{ message:'insufficient credits' },
        provider:'private-provider', diagnostic:'https://private.invalid?key=' + key }, { status })));
      const res = response();
      await handleSpecificationGeneration(request(), res, 'image', transport === 'api' ? {
        token:{ id:1, userId:1 }, reserve:amount => reserveUserCharge(1, amount, 'test_mj_api'),
      } : undefined);
      const record = db.select().from(contents).get()!, meta = JSON.parse(record.metadata);
      expect(record).toMatchObject({ status:'failed', cost:0 });
      expect(meta).toMatchObject({ count:4, nativeImageOutputs:4, billingStatus:'refunded', refundAmount:2,
        routingAttempts:[{ reason:expect.stringContaining('insufficient credits'), upstreamStatus:status }] });
      expect(specificationAvailability(getModelSpecification(MJ_MODEL_ID)!)).toEqual({ available:true });
      expect(meta.failureReason).toContain('insufficient credits');
      expect(meta.failureReason).not.toContain(key);
      expect(meta.error).toBe(meta.failureReason);
      const safe = 'insufficient credits';
      expect(JSON.parse(sanitizeContentRoutingForClient(record).metadata)).toMatchObject({ error:safe, failureReason:safe, progressText:safe });
      if (transport === 'api') expect(res.body).toMatchObject({ status:'failed', error:safe });
      else {
        const events = res.write.mock.calls.map(([line]: [string]) => JSON.parse(line.slice(6)));
        expect(events).toContainEqual({ type:'error', message:safe });
        expect(JSON.stringify(events)).not.toContain('private-provider');
      }
      expect(db.select().from(users).get()?.balance).toBe(100);
      expect(fetch).toHaveBeenCalledOnce();
    });
  it.each(['workbench', 'api'])('keeps ambiguous credit-related server failures under review without resubmitting: %s', async transport => {
    enable();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error:{ message:'insufficient credits' } }, { status:500 })));
    const res = response();
    await handleSpecificationGeneration(request(), res, 'image', transport === 'api' ? {
      token:{ id:1, userId:1 }, reserve:amount => reserveUserCharge(1, amount, 'test_mj_api'),
    } : undefined);
    const record = db.select().from(contents).get()!, meta = JSON.parse(record.metadata);
    expect(meta).toMatchObject({ requiresReview:true, billingStatus:'review' });
    expect(JSON.parse(sanitizeContentRoutingForClient(record).metadata).error).toContain('请勿重复提交');
    if (transport === 'api') {
      expect(res.statusCode).toBe(202);
      expect(res.body).toMatchObject({ requires_review:true, error:expect.stringContaining('请勿重复提交') });
    } else expect(res.write.mock.calls.map(([line]: [string]) => JSON.parse(line.slice(6))))
      .toContainEqual({ type:'error', message:expect.stringContaining('请勿重复提交') });
    expect(db.select().from(users).get()?.balance).toBe(98);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('keeps the explicit credit guidance when a canvas task is restored after disconnection', async () => {
    enable();
    const requestId = 'mj-credit-reconnect-task';
    canvasRequestStore().claim(1, requestId, 'credit-error-parameters');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error:'insufficient credits' }, { status:402 })));
    await handleSpecificationGeneration(request({ canvasRequestId:requestId }), response(), 'image');
    expect(canvasRequestStore().get(1, requestId)?.message).toBe('insufficient credits');
    expect(fetch).toHaveBeenCalledOnce();
  });
});


it('lets the user immediately submit again after credit exhaustion without automatic resubmission', async () => {
  enable();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error:'insufficient credits' }, { status:402 })));
  await handleSpecificationGeneration(request(), response(), 'image');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(specificationAvailability(getModelSpecification(MJ_MODEL_ID)!)).toEqual({ available:true });
  await handleSpecificationGeneration(request(), response(), 'image');
  expect(fetch).toHaveBeenCalledTimes(2);
  const records = db.select().from(contents).all();
  expect(records).toHaveLength(2);
  expect(records.every(record => record.status === 'failed' && record.cost === 0)).toBe(true);
  expect(db.select().from(users).get()!.balance).toBe(100);
});


describe('MJ image response receipt persistence', () => {
  const cases = [
    { label: 'task_id', fields: { task_id: 'evt-mj-task', request_id: 'req-secondary' }, headers: { 'x-request-id': 'req-header' }, id: 'evt-mj-task' },
    { label: 'id', fields: { id: 'evt-mj-log' }, headers: {}, id: 'evt-mj-log' },
    { label: 'request header', fields: {}, headers: { 'x-request-id': 'req-mj-image' }, id: 'req-mj-image' },
    { label: 'missing ID', fields: {}, headers: {}, id: '' },
  ];
  it.each(cases.flatMap(item => [false, true].map(edit => ({ ...item, edit }))))
    ('persists $label through image saving (edit=$edit)', async ({ fields, headers, id, edit }) => {
      enable();
      const sharp = (await import('sharp')).default;
      const reference = edit ? 'data:image/png;base64,' + (await sharp({ create: {
        width: 64, height: 64, channels: 3, background: '#88aacc',
      } }).png().toBuffer()).toString('base64') : undefined;
      const upstream = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ created: 1792324800,
        data: [{ url: 'https://mj-provider.example/v1/public/image/original-resource' }], ...fields }, { headers }));
      vi.stubGlobal('fetch', upstream);
      // The receipt must already be durable before result localization can fail or restart.
      vi.mocked(localizeGeneratedImage).mockImplementation(async (_url, prefix) => {
        expect(JSON.parse(db.select().from(contents).get()!.metadata)).toMatchObject({
          upstreamTaskId: id, upstreamTaskIds: id ? [id] : [],
          upstreamResponses: [{ id, httpStatus: 200, state: id ? 'captured' : 'response_without_id' }],
        });
        return '/api/uploads/' + prefix + '.png';
      });
      await handleSpecificationGeneration(request(reference ? { reference_images: [reference] } : {}), response(), 'image');
      const record = db.select().from(contents).get()!;
      expect(record).toMatchObject({ status: 'completed', cost: 2 });
      expect(JSON.parse(record.metadata)).toMatchObject({ upstreamTaskId: id, billingStatus: 'settled', count: 1 });
      expect(upstream).toHaveBeenCalledOnce();
      expect(upstream.mock.calls[0][0]).toBe('https://mj-provider.example/v1/images/' + (edit ? 'edits' : 'generations'));
      expect(localizeGeneratedImage).toHaveBeenCalledOnce();
      expect(db.select().from(users).get()!.balance).toBe(98);
    });
});

describe('MJ asynchronous image lifecycle', () => {
  const handle = 'temporary/image-handle';
  const taskId = 'evt-permanent-log';
  const originals = [1, 2, 3, 4].map(n => ({ url: 'https://cdn.example/original-' + n + '.png' }));
  const done = () => Response.json({ id: handle, task_id: taskId, status: 'completed', data: originals });
  const current = () => db.select().from(contents).get()!;
  const meta = () => JSON.parse(current().metadata);
  it.each([false, true].flatMap(edit => ['workbench', 'api'].map(transport => ({ edit, transport }))))
    ('persists the handle before GET, polls progress and saves the permanent ID: $edit / $transport', async ({ edit, transport }) => {
      enable(); vi.useFakeTimers();
      const sharp = (await import('sharp')).default;
      const reference = edit ? 'data:image/png;base64,' + (await sharp({ create: {
        width: 64, height: 64, channels: 3, background: '#88aacc',
      } }).png().toBuffer()).toString('base64') : undefined;
      let polls = 0;
      const upstream = vi.fn(async (url: string, init: any) => {
        if (init.method === 'POST') {
          expect(url).toBe('https://mj-provider.example/v1/images/' + (edit ? 'edits' : 'generations'));
          expect(edit ? init.body.get('async') : JSON.parse(init.body).async).toBe(edit ? 'true' : true);
          return Response.json({ id: handle, status: 'queued' }, { status: 202 });
        }
        expect(url).toBe('https://mj-provider.example/v1/images/' + encodeURIComponent(handle));
        expect(init.headers.Authorization).toBe('Bearer ' + key);
        expect(meta()).toMatchObject({ mjAsyncImage: { handle }, upstreamTaskId: '', upstreamTaskIds: [] });
        expect(JSON.parse(sanitizeContentRoutingForClient(current()).metadata)).not.toHaveProperty('mjAsyncImage');
        return ++polls === 1 ? Response.json({ id: handle, status: 'in_progress', progress: 42 }) : done();
      });
      vi.stubGlobal('fetch', upstream);
      vi.mocked(localizeGeneratedImage).mockImplementation(async (_url, prefix) => {
        expect(meta()).toMatchObject({ upstreamTaskId: taskId, upstreamTaskIds: [taskId], mjAsyncImage: { handle, status: 'completed' } });
        return '/api/uploads/' + prefix + '.png';
      });
      const res = response();
      const work = handleSpecificationGeneration(request(reference ? { reference_images: [reference] } : {}), res, 'image', transport === 'api' ? {
        token: { id: 1, userId: 1 }, reserve: amount => reserveUserCharge(1, amount, 'mj_async_api'),
      } : undefined);
      await vi.waitFor(() => expect(meta().mjAsyncImage).toMatchObject({ status: 'in_progress', progress: 42 }));
      await vi.advanceTimersByTimeAsync(5000); await work;
      expect(current()).toMatchObject({ status: 'completed', cost: 2 });
      expect(meta(), JSON.stringify({ error: meta().error, response: res.body })).toMatchObject({ billingStatus: 'settled', count: 4, upstreamTaskId: taskId });
      expect(db.select().from(users).get()!.balance).toBe(98);
      expect(upstream).toHaveBeenCalledTimes(3);
      expect(upstream.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
      expect(localizeGeneratedImage).toHaveBeenCalledTimes(4);
      if (transport === 'api') expect(res.body.data).toHaveLength(4);
      else expect(res.write.mock.calls.some(([line]: [string]) => line.includes('"progress":42'))).toBe(true);
    });
  it('refunds an explicit async failure once while retaining both IDs and keeping the model available', async () => {
    enable();
    const upstream = vi.fn().mockResolvedValueOnce(Response.json({ id: handle, status: 'queued' }))
      .mockResolvedValueOnce(Response.json({ id: handle, task_id: taskId, status: 'failed', error: { message: 'insufficient credits' } }));
    vi.stubGlobal('fetch', upstream);
    const res = response(); await handleSpecificationGeneration(request(), res, 'image');
    expect(current()).toMatchObject({ status: 'failed', cost: 0 });
    expect(meta()).toMatchObject({ requiresReview: false, billingStatus: 'refunded', upstreamTaskId: taskId, mjAsyncImage: { handle, status: 'failed' } });
    expect(db.select().from(users).get()!.balance).toBe(100);
    expect(specificationAvailability(getModelSpecification(MJ_MODEL_ID)!)).toEqual({ available: true });
    expect(JSON.parse(sanitizeContentRoutingForClient(current()).metadata).error).toContain('insufficient credits');
    resumeSpecificationTasks(); expect(upstream).toHaveBeenCalledTimes(2);
  });
  it.each([401, 402, 403, 404, 410])('holds an accepted task when its GET returns %i without refund, locking or resubmission', async status => {
    enable();
    const upstream = vi.fn().mockResolvedValueOnce(Response.json({ id: handle, status: 'queued' }))
      .mockResolvedValueOnce(new Response('', { status }));
    vi.stubGlobal('fetch', upstream);
    await handleSpecificationGeneration(request(), response(), 'image');
    expect(meta()).toMatchObject({ requiresReview: true, billingStatus: 'review', upstreamTaskId: '', mjAsyncImage: { handle, status: 'unavailable' } });
    expect(db.select().from(users).get()!.balance).toBe(98);
    expect(specificationAvailability(getModelSpecification(MJ_MODEL_ID)!)).toEqual({ available: true });
    resumeSpecificationTasks(); expect(upstream).toHaveBeenCalledTimes(2);
  });
  async function interruptedQuery() {
    enable(); vi.useFakeTimers();
    const upstream = vi.fn().mockResolvedValueOnce(Response.json({ id: handle, status: 'queued' }))
      .mockImplementation(async () => new Response('', { status: 503 }));
    vi.stubGlobal('fetch', upstream);
    const work = handleSpecificationGeneration(request(), response(), 'image');
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(10_000); await work;
    expect(meta()).toMatchObject({ requiresReview: true, billingStatus: 'review', mjAsyncImage: { handle, status: 'poll_error' } });
    return upstream;
  }
  it('resumes a saved handle after interruption using GET only, with original ownership and charge', async () => {
    const upstream = await interruptedQuery();
    db.update(contents).set({ status: 'review' }).where(eq(contents.id, current().id)).run();
    upstream.mockImplementation(async (_url: string, init: any) => { expect(init.method).not.toBe('POST'); return done(); });
    vi.mocked(localizeGeneratedImage).mockImplementation(async (_url, prefix) => {
      expect(mediaOwnerContext.getStore()).toBe(1); return '/api/uploads/' + prefix + '.png';
    });
    resumeSpecificationTasks(); resumeSpecificationTasks();
    await vi.waitFor(() => expect(current().status).toBe('completed'));
    expect(upstream).toHaveBeenCalledTimes(5);
    expect(db.select().from(users).get()!.balance).toBe(98);
    expect(meta()).toMatchObject({ upstreamTaskId: taskId, billingStatus: 'settled', requiresReview: false, error: null });
  });
  it('never resumes or charges again after an administrator refunds the original reservation', async () => {
    const upstream = await interruptedQuery();
    resolveBillingReservation(meta().billingReservationId, 2, 0, 'verified failure');
    resumeSpecificationTasks();
    expect(upstream).toHaveBeenCalledTimes(4);
    expect(localizeGeneratedImage).not.toHaveBeenCalled();
    expect(db.select().from(users).get()!.balance).toBe(100);
    expect(meta().billingStatus).toBe('refunded');
  });
  it('stops at the persisted polling deadline and never submits another task', async () => {
    enable(); vi.useFakeTimers();
    const upstream = vi.fn().mockResolvedValueOnce(Response.json({ id: handle, status: 'queued' }))
      .mockImplementation(async () => {
        vi.setSystemTime(Date.now() + 31 * 60_000);
        return Response.json({ id: handle, status: 'in_progress' });
      });
    vi.stubGlobal('fetch', upstream);
    const work = handleSpecificationGeneration(request(), response(), 'image');
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(5000); await work;
    expect(meta()).toMatchObject({ requiresReview: true, billingStatus: 'review', mjAsyncImage: { handle, status: 'timed_out' } });
    resumeSpecificationTasks(); expect(upstream).toHaveBeenCalledTimes(2);
    expect(db.select().from(users).get()!.balance).toBe(98);
  });
  it('saves valid completed images without mislabeling a temporary ID when task_id is missing', async () => {
    enable();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ id: handle, status: 'queued' }))
      .mockResolvedValueOnce(Response.json({ id: handle, status: 'completed', data: originals })));
    await handleSpecificationGeneration(request(), response(), 'image');
    expect(current().status).toBe('completed');
    expect(meta()).toMatchObject({ upstreamTaskId: '', upstreamTaskIds: [], mjAsyncImage: { handle },
      upstreamResponses: [{ id: '', state: 'response_without_id' }] });
  });
  it('keeps a completed receipt but holds missing output without pretending it failed', async () => {
    enable();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ id: handle, status: 'queued' }))
      .mockResolvedValueOnce(Response.json({ id: handle, status: 'completed', task_id: taskId, data: [] })));
    await handleSpecificationGeneration(request(), response(), 'image');
    expect(meta()).toMatchObject({ requiresReview: true, billingStatus: 'review', upstreamTaskId: taskId });
    expect(db.select().from(users).get()!.balance).toBe(98);
    expect(localizeGeneratedImage).not.toHaveBeenCalled();
  });
  it('continues polling after one network interruption without another paid POST', async () => {
    enable(); vi.useFakeTimers();
    const upstream = vi.fn().mockResolvedValueOnce(Response.json({ id: handle, status: 'queued' }))
      .mockRejectedValueOnce(new Error('network interrupted')).mockResolvedValueOnce(done());
    vi.stubGlobal('fetch', upstream);
    const work = handleSpecificationGeneration(request(), response(), 'image');
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(5000); await work;
    expect(current()).toMatchObject({ status: 'completed', cost: 2 });
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(db.select().from(users).get()!.balance).toBe(98);
  });
  it('retains the original source URLs when saving fails, then resumes saving without querying or generating again', async () => {
    enable();
    const upstream = vi.fn().mockResolvedValueOnce(Response.json({ id: handle, status: 'queued' })).mockResolvedValueOnce(done());
    vi.stubGlobal('fetch', upstream);
    vi.mocked(localizeGeneratedImage).mockRejectedValueOnce(new Error('download interrupted'));
    await handleSpecificationGeneration(request(), response(), 'image');
    expect(meta()).toMatchObject({ requiresReview: true, upstreamTaskId: taskId, mjAsyncImage: { handle },
      nativeImageBatch: { sourceUrls: originals.map(item => item.url) } });
    resumeSpecificationTasks();
    await vi.waitFor(() => expect(current().status).toBe('completed'));
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(meta().billingStatus).toBe('settled');
    expect(db.select().from(users).get()!.balance).toBe(98);
  });
  it('does not overwrite a refund made while an accepted task is being queried', async () => {
    enable();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ id: handle, status: 'queued' }))
      .mockImplementation(async () => {
        sqlite.prepare("UPDATE billing_reservations SET state='review' WHERE id=?").run(meta().billingReservationId);
        resolveBillingReservation(meta().billingReservationId, 2, 0, 'verified failure'); return done();
      }));
    await handleSpecificationGeneration(request(), response(), 'image');
    expect(current().cost).toBe(0);
    expect(meta().billingStatus).toBe('refunded');
    expect(localizeGeneratedImage).not.toHaveBeenCalled();
    expect(db.select().from(users).get()!.balance).toBe(100);
  });
  it.each([
    { body: { status: 'queued' }, calls: 1 },
    { body: { id: handle, status: 'unexpected' }, calls: 1 },
  ])('holds an invalid submit acknowledgement without a second POST: $body', async ({ body, calls }) => {
    enable(); vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)));
    await handleSpecificationGeneration(request(), response(), 'image');
    expect(meta()).toMatchObject({ requiresReview: true, billingStatus: 'review', upstreamTaskId: '' });
    expect(fetch).toHaveBeenCalledTimes(calls);
    expect(db.select().from(users).get()!.balance).toBe(98);
  });
  it('keeps a completed async handle separate even when a nested result also has an id', async () => {
    enable();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ id: handle, data: [] }))
      .mockResolvedValueOnce(Response.json({ id: handle, status: 'completed', result: { id: handle, data: originals } })));
    await handleSpecificationGeneration(request(), response(), 'image');
    expect(current().status).toBe('completed');
    expect(meta()).toMatchObject({ upstreamTaskId: '', upstreamTaskIds: [], mjAsyncImage: { handle } });
  });
});

describe('documented MJ HTTP 402 contract', () => {
  const cases = [
    { label:'empty body', body:'', id:'' },
    { label:'generic JSON', body:JSON.stringify({ error:'Payment Required' }), id:'' },
    { label:'HTML body', body:'<html>Payment Required</html>', id:'' },
    { label:'log receipt', body:JSON.stringify({ task_id:'evt-credit-rejected', error:'Payment Required' }), id:'evt-credit-rejected' },
  ];
  it.each(cases.flatMap(item => ['workbench','api'].map(transport => ({...item, transport}))))
    ('refunds without locking or review: $label / $transport', async ({body,id,transport}) => {
      enable();
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status:402 })));
      const res = response();
      await handleSpecificationGeneration(request(), res, 'image', transport === 'api' ? {
        token:{id:1,userId:1}, reserve:amount => reserveUserCharge(1,amount,'test_402'),
      } : undefined);
      const record = db.select().from(contents).get()!, meta = JSON.parse(record.metadata);
      expect(record).toMatchObject({status:'failed',cost:0});
      expect(meta.requiresReview).not.toBe(true);
      expect(meta).toMatchObject({billingStatus:'refunded', upstreamTaskId:id,
        upstreamResponses:[{id,httpStatus:402,state:id ? 'captured' : 'response_without_id'}]});
      expect(specificationAvailability(getModelSpecification(MJ_MODEL_ID)!)).toEqual({available:true});
      expect(ChannelService.getChannelRaw(channelId)?.status).toBe(1);
      expect(db.select().from(users).get()!.balance).toBe(100);
      const safe = body.startsWith('{') ? 'Payment Required' : '上游积分不足 (HTTP 402)：';
      expect(JSON.parse(sanitizeContentRoutingForClient(record).metadata).error).toBe(safe);
      if (transport === 'api') expect(res.body.error).toBe(safe);
      else expect(res.write.mock.calls.some(([line]:[string]) => line.includes(safe))).toBe(true);
      expect(fetch).toHaveBeenCalledOnce();
    });
  it('classifies 402 from received headers even if the body is interrupted, and retains its receipt', async () => {
    enable();
    const upstream = new Response('', {status:402,headers:{'x-request-id':'evt-credit-header'}});
    vi.spyOn(upstream,'text').mockRejectedValue(new Error('interrupted'));
    vi.stubGlobal('fetch',vi.fn(async () => upstream));
    await handleSpecificationGeneration(request(),response(),'image');
    const record = db.select().from(contents).get()!;
    expect(record).toMatchObject({status:'failed',cost:0});
    expect(JSON.parse(record.metadata)).toMatchObject({billingStatus:'refunded',upstreamTaskId:'evt-credit-header',
      upstreamResponses:[{id:'evt-credit-header',httpStatus:402,state:'captured'}]});
    expect(db.select().from(users).get()!.balance).toBe(100);
  });
});
