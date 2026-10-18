import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/routes/imageGen.js', () => ({ localizeGeneratedImage: vi.fn(async (_url, prefix) => '/api/uploads/' + prefix + '.png') }));
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../server/db/index.js';
import { channels, contents, models, modelPricing, settings, users } from '../server/db/schema.js';
import { ChannelService } from '../server/services/channelService.js';
import { getModelSpecification, saveModelSpecification, selectModelRoutes, specificationAvailability } from '../server/services/modelRoutingService.js';
import { handleSpecificationGeneration, resumeSpecificationTasks, recoverMjSpecificationImages } from '../server/services/specificationGenerationService.js';
import { mediaOwnerContext } from '../server/services/uploadAccess.js';
import imageFiles from 'node:fs/promises';
import sharp from 'sharp';
import { generateSpecificationImage } from '../server/services/specificationAdapters.js';
import { localizeGeneratedImage } from '../server/routes/imageGen.js';
import { LEGACY_MJ_MODEL_ID, MJ_MODEL_ID, MJ_SIZES } from '../shared/mj.js';
import { mjBaseUrl } from '../server/services/mjAdapter.js';
import { routeRequestCost } from '../shared/modelRouting.js';
import { reserveUserCharge } from '../server/services/billingReservation.js';
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
afterEach(() => vi.unstubAllGlobals());
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
    expect(fetch).toHaveBeenCalledOnce();
    expect(db.select().from(users).all()[0].balance).toBe(98);
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
    originalResults.slice(0, 2),
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
  it('splits one original grid into four images before settling the original reservation', async () => {
    const record = await gatewayTimeout();
    const png = await sharp({ create: { width: 20, height: 12, channels: 3, background: '#ac55ef' } }).png().toBuffer();
    const read = vi.spyOn(imageFiles, 'readFile').mockResolvedValue(png);
    const write = vi.spyOn(imageFiles, 'writeFile').mockResolvedValue();
    try {
      expect(await recoverMjSpecificationImages(record.id, [originalResults[0]], 2, request())).toMatchObject({ status: 'completed' });
      expect(localizeGeneratedImage).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledTimes(4);
      const saved = db.select().from(contents).all()[0];
      expect(JSON.parse(saved.metadata).imageUrls).toHaveLength(4);
      expect(saved.cost).toBe(2);
      expect(db.select().from(users).all()[0].balance).toBe(98);
      expect(fetch).toHaveBeenCalledOnce();
    } finally { read.mockRestore(); write.mockRestore(); }
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
    expect(JSON.parse(init.body)).toEqual({ model: 'mj_imagine', prompt: 'a paper boat', size });
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
    expect(JSON.parse((vi.mocked(fetch).mock.calls[0][1] as any).body)).toEqual({ model: 'mj_imagine', prompt: 'a paper boat', size: '1024x1024' });
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
    expect(JSON.parse(record.metadata)).toMatchObject({ requiresReview: true, nativeImageBatch: { sourceUrls: expect.any(Array) } });
    resumeSpecificationTasks();
    await vi.waitFor(() => expect(db.select().from(contents).all()[0].status).toBe('completed'));
    expect(JSON.parse(db.select().from(contents).all()[0].metadata).imageUrls).toHaveLength(4);
    expect(fetch).toHaveBeenCalledOnce(); expect(db.select().from(users).all()[0].balance).toBe(98);
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
  it('keeps incomplete native results and their original charge for review', async () => {
    enable();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [1,2].map(n => ({ url: 'https://cdn.example/' + n + '.png' })) })));
    await handleSpecificationGeneration(request(), response(), 'image');
    const meta = JSON.parse(db.select().from(contents).all()[0].metadata);
    expect(meta).toMatchObject({ requiresReview: true, billingStatus: 'review' });
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
      const safe = '上游积分不足，暂时无法生成，请联系管理员补充额度后重试。';
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
    expect(canvasRequestStore().get(1, requestId)?.message).toBe('上游积分不足，暂时无法生成，请联系管理员补充额度后重试。');
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
