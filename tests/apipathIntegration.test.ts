vi.mock('../server/routes/imageGen.js', () => ({ localizeGeneratedImage: vi.fn(async () => '/uploads/apipath.png') }));
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/services/videoLocalizationService.js', () => ({ downloadAndLocalizeVideo: vi.fn(async () => '/uploads/async-video-result.mp4') }));
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../server/db/index.js';
import { channels, contents, models, modelPricing, settings, users, apipathChannelKeys } from '../server/db/schema.js';
import { ChannelService } from '../server/services/channelService.js';
import { getModelSpecification, saveModelSpecification } from '../server/services/modelRoutingService.js';
import { handleSpecificationGeneration, resumeSpecificationTasks } from '../server/services/specificationGenerationService.js';
import { VideoRecoveryService } from '../server/services/videoRecoveryService.js';
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService.js';
import * as referenceValidation from '../server/services/imageReferenceValidationService.js';
import { APIPATH_MODELS } from '../shared/apipathModels.js';
import { APIPATH_LEGACY_IMAGE_IDS, APIPATH_SUNBURST } from '../shared/apipathImageSizes.js';
import { AdminService } from '../server/services/adminService.js';
import { PricingService } from '../server/services/pricingService.js';

const key = 'private-apipath-key';
const selectedModels = ['seedance2-5-特惠-1080p', 'Seedance-2.0-mini-480-GK', 'dola2.5',
  'gpt-image-2-5-sunburst'];
let channelId: number, modelId: string;
const discovery = () => Response.json({ data: [{ id: 'seedance-2.0-YZ' }, { id: 'gpt-image-2-5-flare' }, ...['seedance2-5-特惠-1080p','Seedance-2.0-mini-480-GK','dola2.5','gpt-image-2-5-sunburst'].map(id=>({id}))] });
const response = () => {
  const res: any = { headersSent: false, writableEnded: false, destroyed: false };
  res.status = vi.fn(code => { res.statusCode = code; return res; }); res.json = vi.fn(body => { res.body = body; return res; });
  res.setHeader = vi.fn(); res.flushHeaders = vi.fn(() => { res.headersSent = true; }); res.write = vi.fn();
  res.end = vi.fn(() => { res.writableEnded = true; }); return res;
};
const request = (body: Record<string, unknown> = {}) => ({ userId: 1, headers: {}, protocol: 'https', get: () => 'app.example',
  body: { model: modelId, prompt: '海浪拍打礁石', seconds: 10, resolution: '720p', aspect_ratio: '9:16', ...body } } as any);

beforeEach(async () => {
  if (sqlite.prepare("SELECT name FROM sqlite_master WHERE name='video_submission_receipts'").get()) sqlite.exec('DELETE FROM video_submission_receipts');
  vi.clearAllMocks();
  db.delete(apipathChannelKeys).run();
  db.delete(contents).run(); db.delete(settings).run(); db.delete(models).run(); db.delete(channels).run(); db.delete(modelPricing).run(); db.delete(users).run();
  db.insert(users).values({ id: 1, email: 'async@test.invalid', username: 'test', passwordHash: 'test', balance: 100 }).run();
  vi.stubGlobal('fetch', vi.fn(async () => discovery()));
  channelId = ChannelService.createChannel({ name: '通联测试', type: 'apipath', baseUrl: 'http://provider.invalid:8080/v1/', apiKey: key });
  await ChannelService.syncModels(channelId); modelId = 'dola2.5';
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => sqlite.close());
function enable() {
  db.update(models).set({ isActive: 1 }).where(eq(models.modelId, modelId)).run();
  db.insert(modelPricing).values({ modelPattern: modelId, billingType: 'per_call', inputPrice: 2, outputPrice: 0 }).run();
}


describe('通联 actual specification entry and isolated billing', () => {
  function seedLegacyImages() {
    for (const [index, id] of APIPATH_LEGACY_IMAGE_IDS.entries()) {
      db.insert(models).values({ provider: 'apipath', modelId: id, displayName: id, capabilities: '["image"]', isActive: 1 }).run();
      db.insert(modelPricing).values({ modelPattern: id, billingType: 'per_call', inputPrice: index + 1,
        extraParams: JSON.stringify({ category: 'image' }) }).run();
      const entry = APIPATH_MODELS.find(m => m.id === id)!;
      saveModelSpecification({ modelId: id, kind: 'image', imageFamily: APIPATH_SUNBURST, enabled: true,
        limits: entry.limits, aliases: [], routes: [{ ...getModelSpecification(APIPATH_SUNBURST)!.routes[0],
          id: 'legacy-' + index, executionModel: id, limits: entry.limits }] });
    }
    ChannelService.updateChannel(channelId, { supportedModels: [...selectedModels.slice(0, 3), ...APIPATH_LEGACY_IMAGE_IDS] });
  }
  it('merges existing tier rows on resync, preserves history and prices, and lists only four models', async () => {
    seedLegacyImages();
    const oldPrices = db.select().from(modelPricing).all();
    db.insert(contents).values({ userId: 1, type: 'image', modelId: APIPATH_LEGACY_IMAGE_IDS[1], status: 'completed',
      resultUrl: '/uploads/old.png', cost: 2, metadata: JSON.stringify({ channelId, requestedModel: APIPATH_LEGACY_IMAGE_IDS[1] }) }).run();
    const history = db.select().from(contents).all();
    ChannelService.updateChannel(channelId, { apipathImageKey: 'image-secret', apipathVideoKey: 'video-secret' });
    expect(await ChannelService.syncModels(channelId)).toMatchObject({ count: 4 });
    expect(AdminService.getModels(false).map(m => m.modelId).sort()).toEqual([...selectedModels].sort());
    expect(PricingService.getPricingRules({ scope: 'models' }).map(m => m.modelPattern).sort()).toEqual([...selectedModels].sort());
    expect(db.select().from(contents).all()).toEqual(history);
    expect(db.select().from(modelPricing).all().filter(p => p.modelPattern !== APIPATH_SUNBURST)).toEqual(oldPrices);
    expect(PricingService.getPublicPricingForModels([APIPATH_SUNBURST])[0].resolution_prices).toEqual({ '1K': 1, '2K': 2, '4K': 3 });
    expect(db.select().from(models).all().filter(m => APIPATH_LEGACY_IMAGE_IDS.includes(m.modelId)).every(m => m.isActive === 0)).toBe(true);
    const imageKey = db.select().from(apipathChannelKeys).all().find(k => k.kind === 'image')!;
    expect(JSON.parse(imageKey.supportedModels)).toEqual([APIPATH_SUNBURST]);
    const prices = db.select().from(modelPricing).all();
    await ChannelService.syncModels(channelId);
    expect(db.select().from(modelPricing).all()).toEqual(prices);
    modelId = APIPATH_LEGACY_IMAGE_IDS[0]; vi.mocked(fetch).mockClear();
    const res = response(); await handleSpecificationGeneration(request({ resolution: '1K' }), res, 'image');
    expect(res.statusCode).toBe(403); expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves an existing consolidated price and does not retire old entries bound to another channel', async () => {
    seedLegacyImages();
    const other = ChannelService.createChannel({ name: 'other', type: 'openai', baseUrl: 'https://other.invalid', supportedModels: [APIPATH_LEGACY_IMAGE_IDS[0]] });
    const before = ChannelService.getChannelRaw(other);
    db.insert(modelPricing).values({ modelPattern: APIPATH_SUNBURST, inputPrice: 9, extraParams: '{"1K":9,"2K":12,"4K":15}' }).run();
    const prices = db.select().from(modelPricing).all();
    await ChannelService.syncModels(channelId);
    expect(db.select().from(modelPricing).all()).toEqual(prices);
    expect(ChannelService.getChannelRaw(other)).toEqual(before);
    expect(AdminService.getModels(false).some(m => m.modelId === APIPATH_LEGACY_IMAGE_IDS[0])).toBe(true);
  });
  it('does not invent missing tier prices during consolidation', async () => {
    seedLegacyImages();
    db.delete(modelPricing).where(eq(modelPricing.modelPattern, APIPATH_LEGACY_IMAGE_IDS[2])).run();
    const result = await ChannelService.syncModels(channelId);
    expect(result.warnings.join()).toContain('旧分档售价不完整');
    expect(PricingService.getPublicPricingForModels([APIPATH_SUNBURST])).toEqual([]);
  });
  it('upgrades the original default Sunburst specification without changing its route switch or price', async () => {
    const spec = getModelSpecification(APIPATH_SUNBURST)!;
    spec.limits.resolutions = ['default']; spec.limits.maxImages = 1;
    spec.routes[0].limits = structuredClone(spec.limits); spec.routes[0].enabled = false;
    saveModelSpecification(spec);
    modelId = APIPATH_SUNBURST; enable();
    await ChannelService.syncModels(channelId);
    expect(getModelSpecification(modelId)).toMatchObject({ limits: { resolutions: ['1K', '2K', '4K'], maxImages: 4 },
      routes: [{ enabled: false, limits: { resolutions: ['1K', '2K', '4K'], maxImages: 4 } }] });
    expect(PricingService.getPublicPricingForModels([modelId])[0].unit_price).toBe(2);
  });
  it('does not archive or migrate old prices if either key catalog fails', async () => {
    seedLegacyImages();
    ChannelService.updateChannel(channelId, { apipathImageKey: 'image-secret', apipathVideoKey: 'video-secret' });
    const before = { models: db.select().from(models).all(), prices: db.select().from(modelPricing).all(), settings: db.select().from(settings).all() };
    vi.stubGlobal('fetch', vi.fn(async (_url, init: any) => init.headers.Authorization === 'Bearer video-secret'
      ? Response.json({ error: { code: 'invalid_api_key', message: 'invalid' } }, { status: 401 }) : discovery()));
    await expect(ChannelService.syncModels(channelId)).rejects.toThrow();
    expect({ models: db.select().from(models).all(), prices: db.select().from(modelPricing).all(), settings: db.select().from(settings).all() }).toEqual(before);
  });
  it.each([['1K', 1], ['2K', 2.5], ['4K', 4]] as const)('charges the selected %s price using the image key only', async (resolution, price) => {
    ChannelService.updateChannel(channelId, { apipathImageKey: 'image-secret', apipathVideoKey: 'video-secret' });
    await ChannelService.syncModels(channelId);
    modelId = APIPATH_SUNBURST; enable();
    db.update(modelPricing).set({ extraParams: '{"category":"image","1K":1,"2K":2.5,"4K":4}' }).where(eq(modelPricing.modelPattern, modelId)).run();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ url: 'https://cdn.example/result.png' }] })));
    await handleSpecificationGeneration(request({ resolution }), response(), 'image');
    expect(db.select().from(contents).all()[0]).toMatchObject({ status: 'completed', cost: price });
    expect(db.select().from(users).all()[0].balance).toBe(100 - price);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer image-secret' });
  });
  it('refunds the selected 4K price once on explicit image rejection without replay', async () => {
    modelId = APIPATH_SUNBURST; enable();
    db.update(modelPricing).set({ extraParams: '{"4K":7}' }).where(eq(modelPricing.modelPattern, modelId)).run();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'invalid_api_key', message: 'invalid key' } }, { status: 401 })));
    await handleSpecificationGeneration(request({ resolution: '4K' }), response(), 'image');
    const failed = db.select().from(contents).all()[0];
    expect(failed).toMatchObject({ status: 'failed', cost: 0 });
    expect(JSON.parse(failed.metadata).reservedCost).toBe(7);
    await resumeSpecificationTasks(); await resumeSpecificationTasks();
    expect(db.select().from(users).all()[0].balance).toBe(100);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['legacy', 'dual'])('imports exactly the four selected products from the full upstream catalog (%s)', async mode => {
    if (mode === 'dual') ChannelService.updateChannel(channelId, { apipathImageKey: 'image-secret', apipathVideoKey: 'video-secret' });
    db.delete(models).run(); db.delete(settings).run();
    const upstreamIds = [...new Set(APIPATH_MODELS.map(x => x.upstreamModel || x.id)), 'future-unrequested-model'];
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: upstreamIds.map(id => ({ id })) })));
    const result = await ChannelService.syncModels(channelId);
    expect(result.count).toBe(4); expect(result.added).toBe(4);
    expect(result.models.sort()).toEqual([...selectedModels].sort());
    expect(db.select().from(models).all().map(x => x.modelId).sort()).toEqual([...selectedModels].sort());
    expect(db.select().from(models).all().every(x => x.isActive === 0)).toBe(true);
    const saved = ChannelService.getChannelRaw(channelId)!;
    expect(JSON.parse(saved.supportedModels).sort()).toEqual([...selectedModels].sort());
    expect(Object.keys(JSON.parse(saved.modelMapping)).sort()).toEqual([...selectedModels].sort());
    expect(result.models).not.toContain('gpt-image-2-5-sunburst-1k'); // One image model with three resolutions.
    if (mode === 'dual') {
      const keys = db.select().from(apipathChannelKeys).all();
      expect(JSON.parse(keys.find(k => k.kind === 'image')!.supportedModels).sort()).toEqual(selectedModels.slice(3).sort());
      expect(JSON.parse(keys.find(k => k.kind === 'video')!.supportedModels).sort()).toEqual(selectedModels.slice(0, 3).sort());
    }
  });
  it.each(['image', 'video'])('imports only the selected %s entries when only that key is configured', async kind => {
    ChannelService.updateChannel(channelId, kind === 'image' ? { apipathImageKey: 'image-secret' } : { apipathVideoKey: 'video-secret' });
    const result = await ChannelService.syncModels(channelId);
    expect(result.models.sort()).toEqual((kind === 'image' ? selectedModels.slice(3) : selectedModels.slice(0, 3)).sort());
    expect(result.count).toBe(kind === 'image' ? 1 : 3);
  });
  it('does not invent selected products absent from the key authorization', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: 'dola2.5' }, { id: 'gpt-image-2-5-flare' }] })));
    expect(await ChannelService.syncModels(channelId)).toMatchObject({ count: 1, models: ['dola2.5'] });
  });
  it('prunes obsolete bindings while retaining existing records, prices, other channels and task recovery', async () => {
    ChannelService.updateChannel(channelId, { apipathImageKey: 'image-secret', apipathVideoKey: 'video-secret' });
    await ChannelService.syncModels(channelId);
    const videoKey = db.select().from(apipathChannelKeys).all().find(k => k.kind === 'video')!;
    const oldId = 'seedance-2.0-YZ';
    db.insert(models).values({ provider: 'apipath', modelId: oldId, displayName: '旧视频', description: '管理员说明', capabilities: '["video"]', isActive: 1 }).run();
    db.insert(modelPricing).values({ modelPattern: oldId, billingType: 'per_call', inputPrice: 9, outputPrice: 0 }).run();
    const otherChannel = ChannelService.createChannel({ name: '其他渠道', type: 'openai', baseUrl: 'https://other.invalid', apiKey: 'other-secret', supportedModels: [oldId] });
    const otherBefore = ChannelService.getChannelRaw(otherChannel);
    const spec = structuredClone(getModelSpecification('dola2.5')!);
    spec.modelId = oldId; spec.routes[0] = { ...spec.routes[0], id: 'old-route', executionModel: oldId, upstreamModel: oldId };
    saveModelSpecification(spec);
    ChannelService.updateChannel(channelId, { supportedModels: [...selectedModels, oldId], modelMapping: { [oldId]: oldId } });
    db.update(apipathChannelKeys).set({ supportedModels: JSON.stringify([...selectedModels.slice(0, 3), oldId]) }).where(eq(apipathChannelKeys.id, videoKey.id)).run();
    const oldModel = db.select().from(models).where(eq(models.modelId, oldId)).get();
    const prices = db.select().from(modelPricing).all();
    await ChannelService.syncModels(channelId);
    expect(JSON.parse(ChannelService.getChannelRaw(channelId)!.modelMapping)).not.toHaveProperty(oldId);
    expect(ChannelService.getActiveChannels().filter(c => c.id === channelId).every(c => !c.supportedModels.includes(oldId))).toBe(true);
    expect(ChannelService.findChannelsForModel(oldId).map(c => c.id)).toEqual([otherChannel]);
    expect(db.select().from(models).where(eq(models.modelId, oldId)).get()).toEqual(oldModel);
    expect(db.select().from(modelPricing).all()).toEqual(prices);
    expect(getModelSpecification(oldId)).toEqual(spec);
    expect(ChannelService.getChannelRaw(otherChannel)).toEqual(otherBefore);
    const id = Number(db.insert(contents).values({ userId: 1, type: 'video', modelId: oldId, status: 'processing',
      metadata: JSON.stringify({ managedSpecification: true, channelId, channelApiKeyId: videoKey.id, videoId: 'old-task', actualModel: oldId, requestedModel: oldId }) }).run().lastInsertRowid);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ task_no: 'old-task', status: 'completed', url: 'https://cdn.example/old.mp4' })));
    expect(await VideoRecoveryService.inspect(id)).toMatchObject({ status: 'completed' });
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer video-secret' } });
  });
  it('uses two type-specific keys in one channel and persists distinct execution key IDs', async () => {
    ChannelService.updateChannel(channelId, { apipathImageKey: 'image-secret', apipathVideoKey: 'video-secret' });
    await ChannelService.syncModels(channelId); // Each key returns both types; binding must still filter by kind.
    expect(vi.mocked(fetch).mock.calls.slice(-2).map(c => (c[1]?.headers as any).Authorization)).toEqual(['Bearer image-secret', 'Bearer video-secret']);
    const candidates = ChannelService.getActiveChannels().filter(c => c.id === channelId);
    expect(candidates).toHaveLength(2);
    expect(candidates.find(c => c.apiKey === 'image-secret')?.supportedModels).not.toContain('dola2.5');
    expect(candidates.find(c => c.apiKey === 'video-secret')?.supportedModels).not.toContain('gpt-image-2-5-sunburst-2k');
    vi.stubGlobal('fetch', vi.fn(async (url: any) => Response.json(String(url).includes('/images/')
      ? { data: [{ url: 'https://cdn.example/image.png' }] } : { task_no: 'dual-key', status: 'completed', url: 'https://cdn.example/video.mp4' })));
    modelId = 'dola2.5'; enable(); await handleSpecificationGeneration(request({ seconds: 5 }), response(), 'video');
    modelId = 'gpt-image-2-5-sunburst'; enable(); await handleSpecificationGeneration(request({ resolution: '2K' }), response(), 'image');
    expect(vi.mocked(fetch).mock.calls.map(c => (c[1]?.headers as any).Authorization)).toEqual(['Bearer video-secret', 'Bearer image-secret']);
    const rows = db.select().from(contents).all();
    expect(rows.map(r => r.status)).toEqual(['completed', 'completed']);
    expect(rows.map(r => JSON.parse(r.metadata).channelId)).toEqual([channelId, channelId]);
    const ids = rows.map(r => JSON.parse(r.metadata).channelApiKeyId);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every(id => Number(id) > 0)).toBe(true);
    expect(db.select().from(users).all()[0].balance).toBe(96);
  });
  it('does not fall back to the image or legacy key when video key is absent', async () => {
    ChannelService.updateChannel(channelId, { apipathImageKey: 'image-only-secret' });
    await ChannelService.syncModels(channelId);
    modelId = 'dola2.5'; enable(); vi.mocked(fetch).mockClear();
    await handleSpecificationGeneration(request({ seconds: 5 }), response(), 'video');
    expect(fetch).not.toHaveBeenCalled();
    expect(db.select().from(users).all()[0].balance).toBe(100);
  });
  it.each(['rejected', 'unknown'])('settles a typed-key %s submission without resending or duplicate refunds', async outcome => {
    ChannelService.updateChannel(channelId, { apipathImageKey: 'image-secret', apipathVideoKey: 'video-secret' });
    await ChannelService.syncModels(channelId); enable();
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
      expect(init.headers.Authorization).toBe('Bearer video-secret');
      if (outcome === 'unknown') throw new Error('socket closed');
      return Response.json({ error: { code: 'invalid_request_error', message: '参数拒绝' } }, { status: 400 });
    }));
    await handleSpecificationGeneration(request(), response(), 'video');
    resumeSpecificationTasks(); resumeSpecificationTasks();
    expect(fetch).toHaveBeenCalledOnce();
    const row = db.select().from(contents).all().at(-1)!;
    expect(JSON.parse(row.metadata).channelApiKeyId).toBeGreaterThan(0);
    if (outcome === 'rejected') expect(row.status).toBe('failed');
    else expect(JSON.parse(row.metadata).requiresReview).toBe(true);
    expect(db.select().from(users).all()[0].balance).toBe(outcome === 'rejected' ? 100 : 98);
  });
  it('rejects stale catalog bindings when a key changes during discovery', async () => {
    ChannelService.updateChannel(channelId, { apipathImageKey: 'image-secret' });
    vi.stubGlobal('fetch', vi.fn(async () => {
      ChannelService.updateChannel(channelId, { apipathImageKey: 'image-replacement' });
      return discovery();
    }));
    await expect(ChannelService.syncModels(channelId)).rejects.toThrow('Key 已变更');
    expect(ChannelService.getActiveChannels().find(c => c.apiKey === 'image-replacement')?.supportedModels).toEqual([]);
  });
  it('keeps discovery atomic when either key fails, with no secret disclosure', async () => {
    ChannelService.updateChannel(channelId, { apipathImageKey: 'image-secret', apipathVideoKey: 'video-secret' });
    await ChannelService.syncModels(channelId);
    const before = ChannelService.getChannelRaw(channelId);
    const bindings = db.select().from(apipathChannelKeys).all();
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => init.headers.Authorization.includes('video-secret')
      ? Response.json({ error: { code: 'invalid_api_key', message: 'invalid video-secret' } }, { status: 401 })
      : Response.json({ data: [] })));
    let message = '';
    try { await ChannelService.syncModels(channelId); } catch (error: any) { message = error.message; }
    expect(message).toContain('视频 Key'); expect(message).toContain('invalid_api_key'); expect(message).not.toContain('video-secret');
    expect(ChannelService.getChannelRaw(channelId)).toEqual(before);
    expect(db.select().from(apipathChannelKeys).all()).toEqual(bindings);
  });
  it('recovers an accepted video with the original key after key replacement, GET only', async () => {
    ChannelService.updateChannel(channelId, { apipathVideoKey: 'video-original' });
    await ChannelService.syncModels(channelId);
    const original = ChannelService.getActiveChannels().find(c => c.id === channelId)!;
    const id = Number(db.insert(contents).values({ userId: 1, type: 'video', modelId, status: 'processing',
      metadata: JSON.stringify({ managedSpecification: true, channelId, channelApiKeyId: original.apiKeyId, videoId: 'original-receipt', actualModel: modelId, requestedModel: modelId }) }).run().lastInsertRowid);
    ChannelService.updateChannel(channelId, { apipathVideoKey: 'video-new', apipathImageKey: 'image-secret' });
    expect(ChannelService.getActiveChannels().find(c => c.apiKey === 'video-new')?.supportedModels).toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ task_no: 'original-receipt', status: 'completed', url: 'https://cdn.example/video.mp4' })));
    expect(await VideoRecoveryService.inspect(id)).toMatchObject({ status: 'completed' });
    resumeSpecificationTasks();
    await vi.waitFor(() => expect(db.select().from(contents).where(eq(contents.id, id)).get()?.status).toBe('completed'));
    expect(vi.mocked(fetch).mock.calls.every(c => c[1]?.method === 'GET' && (c[1]?.headers as any).Authorization === 'Bearer video-original')).toBe(true);
    expect(ChannelService.getChannelRaw(channelId, 999999)).toBeUndefined();
    expect(ChannelService.getChannelRaw(channelId)?.apiKey).toBe(key); // Pre-upgrade receipts with no key ID retain their legacy identity.
  });
  it('masks both keys, preserves blank edits and validates key changes atomically', async () => {
    const id = ChannelService.createChannel({ name: '单渠道双 Key', type: 'apipath', baseUrl: 'https://provider.invalid', apipathImageKey: 'image-secret-1111', apipathVideoKey: 'video-secret-2222' });
    const exposed = ChannelService.getChannels().find(c => c.id === id)!;
    expect(exposed).toMatchObject({ apipathImageKey: '****1111', apipathVideoKey: '****2222', apiKey: '' });
    expect(JSON.stringify(exposed)).not.toMatch(/image-secret|video-secret/);
    const before = db.select().from(apipathChannelKeys).all();
    ChannelService.updateChannel(id, { apipathImageKey: '', apipathVideoKey: '' });
    expect(db.select().from(apipathChannelKeys).all()).toEqual(before);
    expect(() => ChannelService.updateChannel(id, { apipathImageKey: 'replacement', apipathVideoKey: '****2222' })).toThrow();
    expect(db.select().from(apipathChannelKeys).all()).toEqual(before);
    expect(await ChannelService.testChannel(id)).toMatchObject({ success: true });
    expect(vi.mocked(fetch).mock.calls.every(c => c[1]?.method === 'GET')).toBe(true);
  });
  it.each(APIPATH_MODELS.filter(entry => entry.description && selectedModels.includes(entry.id)))('imports and upgrades the description of $id without changing configuration', async entry => {
    const read = () => db.select().from(models).where(eq(models.modelId, entry.id)).get()!;
    expect(read()).toMatchObject({ description: entry.description, isActive: 0 });
    modelId = entry.id;
    enable();
    const spec = getModelSpecification(entry.id)!;
    spec.routes[0].enabled = false;
    saveModelSpecification(spec);
    const oldDescription = entry.kind === 'video'
      ? '通联视频；规格按独立模型配置。配置售价后启用。'
      : `通联 Sunburst 图片 ${entry.limits.resolutions[0]}；最多 4 张参考图；尺寸按上游档位映射。配置售价后启用。`;
    for (const previous of [oldDescription, '']) {
      db.update(models).set({ description: previous }).where(eq(models.modelId, entry.id)).run();
      const before = read();
      const result = await ChannelService.syncModels(channelId);
      expect(result.added).toBe(0);
      expect(read()).toEqual({ ...before, description: entry.description });
      expect(getModelSpecification(entry.id)).toEqual(spec);
      expect(db.select().from(modelPricing).all()[0].inputPrice).toBe(2);
    }
    db.update(models).set({ description: '管理员自定义说明' }).where(eq(models.modelId, entry.id)).run();
    await ChannelService.syncModels(channelId);
    expect(read().description).toBe('管理员自定义说明');
  });
  it('does not update descriptions for a conflicting provider or unrelated model', async () => {
    db.insert(models).values({ provider: 'apipath', modelId: 'seedance-2.0-YZ', displayName: '旧模型', description: '旧说明', capabilities: '["video"]', isActive: 0 }).run();
    const original = db.select().from(models).where(eq(models.modelId, 'seedance-2.0-YZ')).get()!;
    db.update(models).set({ provider: 'other', description: '' }).where(eq(models.modelId, 'dola2.5')).run();
    await ChannelService.syncModels(channelId);
    expect(db.select().from(models).where(eq(models.modelId, 'dola2.5')).get()?.description).toBe('');
    expect(db.select().from(models).where(eq(models.modelId, 'seedance-2.0-YZ')).get()).toEqual(original);
  });
  it.each(['completed','failed'])('settles %s and persists the receipt before GET', async status => {
    enable(); vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
      if(init?.method==='POST') return Response.json({task_no:'task_1',status:'queued'});
      const meta=JSON.parse(db.select().from(contents).all().at(-1)!.metadata);
      expect(meta.videoId).toBe('task_1');
      return Response.json({task_no:'task_1',status,url:'https://cdn.example/result.mp4',error:status==='failed'?{code:'render_failed',message:'具体渲染原因'}:null});
    }));
    await handleSpecificationGeneration(request(),response(),'video');
    expect(db.select().from(contents).all().at(-1)).toMatchObject({status,cost:status==='completed'?2:0});
    expect(db.select().from(users).all()[0].balance).toBe(status==='completed'?98:100);
    resumeSpecificationTasks(); expect(db.select().from(users).all()[0].balance).toBe(status==='completed'?98:100);
  });
  it.each([400,401])('refunds documented rejection %s exactly once',async status=>{
    enable();vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error:{code:status===400?'invalid_request_error':'invalid_api_key',message:'真实拒绝原因'}},{status})));
    await handleSpecificationGeneration(request(),response(),'video');
    const row=db.select().from(contents).all().at(-1)!;expect(row.status).toBe('failed');
    expect(JSON.parse(row.metadata).requiresReview).not.toBe(true);expect(row.metadata).toContain('真实拒绝原因');
    expect(db.select().from(users).all()[0].balance).toBe(100);resumeSpecificationTasks();expect(fetch).toHaveBeenCalledOnce();
    expect(db.select().from(users).all()[0].balance).toBe(100);
  });
  it.each(['disconnect','missing','html','upstream'])('holds unknown %s without replay or refund',async kind=>{
    enable();vi.stubGlobal('fetch',vi.fn(async()=>{if(kind==='disconnect')throw new Error('socket closed');if(kind==='html')return new Response('<html>gateway</html>',{status:502});return Response.json(kind==='missing'?{}:{error:{code:'upstream_error',message:'服务异常'}},{status:kind==='upstream'?502:200});}));
    await handleSpecificationGeneration(request(),response(),'video');resumeSpecificationTasks();
    expect(fetch).toHaveBeenCalledOnce();expect(db.select().from(users).all()[0].balance).toBe(98);
    expect(JSON.parse(db.select().from(contents).all().at(-1)!.metadata)).toMatchObject({requiresReview:true});
  });
  it('honors immediate failed task without querying or losing its ID',async()=>{
    enable();vi.stubGlobal('fetch',vi.fn(async()=>Response.json({task_no:'failed_1',status:'failed',error:{message:'立即失败'}})));
    await handleSpecificationGeneration(request(),response(),'video');expect(fetch).toHaveBeenCalledOnce();
    const row=db.select().from(contents).all().at(-1)!;expect(row.status).toBe('failed');expect(JSON.parse(row.metadata).videoId).toBe('failed_1');expect(db.select().from(users).all()[0].balance).toBe(100);
  });
  it('resumes original video with GET only',async()=>{
    const id=Number(db.insert(contents).values({userId:1,type:'video',modelId,status:'processing',metadata:JSON.stringify({managedSpecification:true,channelId,videoId:'original',actualModel:modelId,requestedModel:modelId})}).run().lastInsertRowid);
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({task_no:'original',status:'completed',url:'https://cdn.example/video.mp4'})));
    expect(await VideoRecoveryService.inspect(id)).toMatchObject({status:'completed'});resumeSpecificationTasks();
    await vi.waitFor(()=>expect(db.select().from(contents).where(eq(contents.id,id)).get()?.status).toBe('completed'));
    expect(vi.mocked(fetch).mock.calls.every(c=>c[1]?.method==='GET')).toBe(true);
  });
  it('generates an image through the charged website entry',async()=>{
    modelId='gpt-image-2-5-sunburst';enable();vi.stubGlobal('fetch',vi.fn(async()=>Response.json({created:1,data:[{url:'https://cdn.example/image.png'}]})));
    const res=response();await handleSpecificationGeneration(request({resolution:'1K'}),res,'image');
    expect(db.select().from(contents).all().at(-1),JSON.stringify(res.body)).toMatchObject({status:'completed',cost:2});
    const [url,init]=vi.mocked(fetch).mock.calls[0];expect(String(url)).toContain('/v1/images/generations');expect(JSON.parse(String(init?.body))).toMatchObject({model:'gpt-image-2-5-sunburst',n:1});
  });
  it('imports disabled and preserves prices and administrator switches',async()=>{
    expect(db.select().from(models).all().every(x=>x.isActive===0)).toBe(true);enable();const spec=getModelSpecification(modelId)!;spec.routes[0].enabled=false;saveModelSpecification(spec);
    await ChannelService.syncModels(channelId);expect(getModelSpecification(modelId)?.routes[0].enabled).toBe(false);expect(db.select().from(modelPricing).all()[0].inputPrice).toBe(2);
    expect(ChannelService.getChannelRaw(channelId)?.maxRetries).toBe(0);
  });
  it('retries a query failure without repeating the paid submission',async()=>{
    enable();vi.useFakeTimers();let queries=0;
    vi.stubGlobal('fetch',vi.fn(async (_url:any,init:any)=>init?.method==='POST'?Response.json({task_no:'q1',status:'queued'}):++queries===1?Response.json({error:{code:'upstream_error',message:'临时查询异常'}},{status:502}):Response.json({task_no:'q1',status:'completed',url:'https://cdn.example/video.mp4'})));
    try {const work=handleSpecificationGeneration(request(),response(),'video');await vi.advanceTimersByTimeAsync(13000);await work;
      expect(vi.mocked(fetch).mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(1);
      expect(db.select().from(contents).all().at(-1)?.status).toBe('completed');expect(db.select().from(users).all()[0].balance).toBe(98);
    }finally{vi.useRealTimers();}
  });
  it('keeps the completed receipt when saving fails and never generates again',async()=>{
    enable();vi.useFakeTimers();vi.mocked(downloadAndLocalizeVideo).mockRejectedValueOnce(new Error('disk temporarily unavailable'));
    vi.stubGlobal('fetch',vi.fn(async (_url:any,init:any)=>Response.json(init?.method==='POST'?{task_no:'save1',status:'queued'}:{task_no:'save1',status:'completed',url:'https://cdn.example/video.mp4'})));
    try {const work=handleSpecificationGeneration(request(),response(),'video');await vi.advanceTimersByTimeAsync(9000);await work;
      expect(fetch).toHaveBeenCalledTimes(2);expect(downloadAndLocalizeVideo).toHaveBeenCalledTimes(2);expect(db.select().from(users).all()[0].balance).toBe(98);
    }finally{vi.useRealTimers();}
  });
  it('uses multipart edits with all validated reference bytes',async()=>{
    modelId='gpt-image-2-5-sunburst';enable();const validation=vi.spyOn(referenceValidation,'validateAndNormalizeImageReferences').mockResolvedValue(['data:image/png;base64,aGVsbG8=']);
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({data:[{url:'https://cdn.example/edited.png'}]})));
    try{await handleSpecificationGeneration(request({resolution:'1K',reference_images:['https://images.example/ref.png']}),response(),'image');
      const [url,init]=vi.mocked(fetch).mock.calls[0];expect(String(url)).toContain('/v1/images/edits');expect(init?.body).toBeInstanceOf(FormData);expect((init?.body as FormData).getAll('image[]')).toHaveLength(1);
      expect(db.select().from(contents).all().at(-1)?.status).toBe('completed');
    }finally{validation.mockRestore();}
  });
  it('preserves accepted ID even when HTTP error accompanies the receipt',async()=>{
    enable();vi.stubGlobal('fetch',vi.fn(async()=>Response.json({task_no:'accepted',status:'processing',error:{code:'upstream_error',message:'网关异常'}},{status:502})));
    await handleSpecificationGeneration(request(),response(),'video');const meta=JSON.parse(db.select().from(contents).all().at(-1)!.metadata);
    expect(meta).toMatchObject({videoId:'accepted',requiresReview:true});expect(db.select().from(users).all()[0].balance).toBe(98);expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['seedance2-5-特惠-1080p','1080p','9:16',5],['seedance2-5-特惠-1080p','1080p','16:9',30],
    ...['1:1','9:16','16:9'].map(r=>['Seedance-2.0-mini-480-GK','480p',r,4]),
    ...['1:1','9:16','16:9'].map(r=>['dola2.5','720p',r,15]),
  ])('executes selected video %s %s %s %s without changing parameters',async (model,resolution,ratio,seconds)=>{
    modelId=String(model);enable();vi.stubGlobal('fetch',vi.fn(async()=>Response.json({task_no:'selected',status:'completed',url:'https://cdn.example/video.mp4'})));
    const res=response();await handleSpecificationGeneration(request({resolution,aspect_ratio:ratio,seconds}),res,'video');
    expect(db.select().from(contents).all().at(-1),JSON.stringify(res.body)).toMatchObject({status:'completed',cost:2});
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({model,prompt:'海浪拍打礁石',count:1,duration:seconds,aspect_ratio:ratio,resolution});
  });
  it.each([
    ['dola2.5','720p',6],['dola2.5','480p',5],['Seedance-2.0-mini-480-GK','720p',5],['seedance2-5-特惠-1080p','1080p',4],
  ])('rejects unsupported video %s %s %s before charge',async(model,resolution,seconds)=>{
    modelId=String(model);enable();vi.stubGlobal('fetch',vi.fn());const res=response();await handleSpecificationGeneration(request({resolution,seconds}),res,'video');
    expect(res.statusCode).toBe(400);expect(fetch).not.toHaveBeenCalled();expect(db.select().from(contents).all()).toHaveLength(0);expect(db.select().from(users).all()[0].balance).toBe(100);
  });
  it.each([
    ['1k','1:1','1024x1024'],['2k','1:1','2048x2048'],['4k','1:1','2880x2880'],
    ['1k','16:9','1280x720'],['2k','16:9','2560x1440'],['4k','16:9','3840x2160'],
    ['1k','9:16','720x1280'],['2k','9:16','1440x2560'],['4k','9:16','2160x3840'],
    ['4k','21:9','3696x1584'],
  ])('maps Sunburst %s %s to the documented size %s',async(tier,ratio,size)=>{
    modelId='gpt-image-2-5-sunburst';enable();vi.stubGlobal('fetch',vi.fn(async()=>Response.json({data:[{url:'https://cdn.example/image.png'}]})));
    const res=response();await handleSpecificationGeneration(request({resolution:tier,aspect_ratio:ratio}),res,'image');
    expect(db.select().from(contents).all().at(-1),JSON.stringify(res.body)).toMatchObject({status:'completed',cost:2});
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toMatchObject({model:'gpt-image-2-5-sunburst',size,aspect_ratio:ratio});
    expect(getModelSpecification(modelId)?.limits.resolutions).toEqual(['1K','2K','4K']);
  });
  it('preserves four edit references and applies 4K dimensions to multipart',async()=>{
    modelId='gpt-image-2-5-sunburst';enable();const images=Array(4).fill('data:image/png;base64,aGVsbG8=');const validation=vi.spyOn(referenceValidation,'validateAndNormalizeImageReferences').mockResolvedValue(images);
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({data:[{url:'https://cdn.example/edited.png'}]})));
    try{await handleSpecificationGeneration(request({resolution:'4K',reference_images:images}),response(),'image');const form=vi.mocked(fetch).mock.calls[0][1]?.body as FormData;
      expect(form.get('model')).toBe('gpt-image-2-5-sunburst');expect(form.get('size')).toBe('2160x3840');expect(form.getAll('image[]')).toHaveLength(4);
      expect(db.select().from(contents).all().at(-1)?.status).toBe('completed');
    }finally{validation.mockRestore();}
  });
  it.each([{size:'1024x1024',aspect_ratio:'1:1'},{resolution:'8K'},{reference_images:Array(5).fill('https://cdn.example/ref.png')}])('rejects conflicting Sunburst request before charge: %j',async body=>{
    modelId='gpt-image-2-5-sunburst';enable();vi.stubGlobal('fetch',vi.fn());const res=response();await handleSpecificationGeneration(request({resolution:'4K',...body}),res,'image');expect(res.statusCode).toBe(400);expect(fetch).not.toHaveBeenCalled();expect(db.select().from(users).all()[0].balance).toBe(100);
  });
  it('syncs one Sunburst model with three resolutions without replacing prices or switches',async()=>{
    modelId='gpt-image-2-5-sunburst';enable();const spec=getModelSpecification(modelId)!;spec.enabled=false;spec.routes[0].limits.maxImages=2;saveModelSpecification(spec);await ChannelService.syncModels(channelId);
    expect(getModelSpecification(modelId)).toMatchObject({enabled:false,routes:[{limits:{maxImages:2}}]});expect(db.select().from(modelPricing).all()[0].inputPrice).toBe(2);
    const mapping=JSON.parse(ChannelService.getChannelRaw(channelId)!.modelMapping);expect(mapping['gpt-image-2-5-sunburst']).toBe('gpt-image-2-5-sunburst');
  });

  it('uses separate image and video keys and preserves their channel bindings',async()=>{
    const imageKey='private-image-only-key';
    const imageChannel=ChannelService.createChannel({name:'通联图片',type:'apipath',baseUrl:'https://provider.invalid',apiKey:imageKey});
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({data:[{id:'gpt-image-2-5-sunburst'}]})));await ChannelService.syncModels(imageChannel);
    ChannelService.updateChannel(channelId,{supportedModels:['dola2.5']});
    const calls:any[]=[];vi.stubGlobal('fetch',vi.fn(async(url:any,init:any)=>{calls.push([url,init]);return Response.json(String(url).includes('/images/')?{data:[{url:'https://cdn.example/image.png'}]}:{task_no:'split',status:'completed',url:'https://cdn.example/video.mp4'});}));
    modelId='dola2.5';enable();await handleSpecificationGeneration(request({seconds:5}),response(),'video');
    modelId='gpt-image-2-5-sunburst';enable();await handleSpecificationGeneration(request({resolution:'2K'}),response(),'image');
    expect(calls[0][1].headers.Authorization).toBe('Bearer '+key);expect(calls[1][1].headers.Authorization).toBe('Bearer '+imageKey);
    expect(db.select().from(contents).all().map(x=>JSON.parse(x.metadata).channelId)).toEqual([channelId,imageChannel]);
  });

});
