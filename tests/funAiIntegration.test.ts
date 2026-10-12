import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const sqlite = new Database(':memory:'); return { sqlite, db: drizzle(sqlite) };
});
vi.mock('../server/routes/imageGen.js', () => ({ localizeGeneratedImage: vi.fn(async () => '/api/uploads/funai-result.png') }));
vi.mock('../server/services/videoLocalizationService.js', () => ({ downloadAndLocalizeVideo: vi.fn(async () => '/uploads/funai-result.mp4') }));
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../server/db/index.js';
import { initDatabase } from '../server/db/seed.js';
import { channels, models, settings, users, contents, modelPricing } from '../server/db/schema.js';
import { ChannelService } from '../server/services/channelService.js';
import { getModelSpecification, saveModelSpecification, selectModelRoutes } from '../server/services/modelRoutingService.js';
import { handleSpecificationGeneration } from '../server/services/specificationGenerationService.js';
import { generateSpecificationImage, pollSpecificationImage, submitSpecificationVideo } from '../server/services/specificationAdapters.js';
import { getEnabledPublicModels } from '../server/services/modelCatalogService.js';
import { localizeGeneratedImage } from '../server/routes/imageGen.js';
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService.js';

const discovered = ['gpt-image-2', 'nano-banana2', 'veo-3.1', 'minimax-h3', 'unknown-new-video'];
const key = 'private-test-funai-key';
const discovery = () => Response.json({ data: discovered.map(id => ({ id })) });
const input = (resolution = '720p') => ({ images: 0, videos: 0, audios: 0, outputs: 1, seconds: 6, resolution, ratio: '1:1', firstFrame: false, lastFrame: false });
let channelId: number, userId: number;
beforeAll(async () => {
  process.env.ADMIN_EMAIL = 'funai-test@example.com'; process.env.ADMIN_PASSWORD = 'test-password-only';
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [] })));
  await initDatabase(); userId = db.select().from(users).all()[0].id;
});
beforeEach(() => {
  vi.clearAllMocks();
  db.delete(contents).run(); db.delete(channels).run();
  for (const name of ['model_specification_routes_v1','model_specification_health_v1']) db.delete(settings).where(eq(settings.key, name)).run();
  sqlite.prepare("DELETE FROM models WHERE provider='funai'").run();
  sqlite.prepare("DELETE FROM model_pricing WHERE model_pattern LIKE 'funai-%'").run();
  db.update(users).set({ balance: 100 }).where(eq(users.id, userId)).run();
  vi.stubGlobal('fetch', vi.fn(async () => discovery()));
  channelId = ChannelService.createChannel({ name: 'FunAI test', type: 'funai', baseUrl: 'https://ztyunjuan.com/v1/', apiKey: key });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => sqlite.close());
const price = (id: string, billingType = 'per_call', amount = 2) => {
  db.update(models).set({ isActive: 1 }).where(eq(models.modelId, id)).run();
  db.insert(modelPricing).values({ modelPattern: id, billingType, inputPrice: amount, outputPrice: 0 }).run();
};
function response() {
  const res: any = { headersSent: false, writableEnded: false, destroyed: false, events: [] };
  res.status = vi.fn(code => { res.statusCode = code; return res; }); res.json = vi.fn(body => { res.body = body; return res; });
  res.setHeader = vi.fn(); res.flushHeaders = vi.fn(() => { res.headersSent = true; });
  res.write = vi.fn(text => { if (text.startsWith('data: ')) { try { res.events.push(JSON.parse(text.slice(6))); } catch {} } });
  res.end = vi.fn(() => { res.writableEnded = true; }); return res;
}
function req(model: string, body: any = {}) {
  return { userId, headers: {}, body: { model, prompt: 'product camera movement', ...body }, protocol: 'https', get: () => 'app.example' } as any;
}
describe('FunAI channel in website generation and billing workflows', () => {
  it('imports only discovered media models, creates independent resolution entries, and keeps new sales disabled', async () => {
    expect(await ChannelService.testChannel(channelId)).toMatchObject({ success: true });
    const synced = await ChannelService.syncModels(channelId);
    expect(synced).toMatchObject({ count: 8, added: 8 });
    expect(synced.models).toContain('funai-gpt-image-2-2k');
    expect(synced.models).toContain('funai-nano-banana2-4k');
    expect(synced.models).toContain('funai-veo-3.1');
    const channel = ChannelService.getChannelRaw(channelId)!;
    expect(channel).toMatchObject({ baseUrl: 'https://ztyunjuan.com', type: 'funai', maxRetries: 0 });
    expect(JSON.parse(channel.modelMapping)['funai-gpt-image-2-2k']).toBe('gpt-image-2');
    expect(JSON.parse(channel.supportedModels)).toEqual(synced.models);
    expect(db.select().from(models).all().filter(model => model.provider === 'funai').every(model => model.isActive === 0)).toBe(true);
    expect(getEnabledPublicModels().filter(model => model.provider === 'funai')).toEqual([]);
    expect(getModelSpecification('funai-gpt-image-2-2k')).toMatchObject({ kind: 'image', imageFamily: 'funai-gpt-image-2', limits: { resolutions: ['2K'], maxImages: 16 } });
    expect(getModelSpecification('funai-veo-3.1')!.limits.duration).toMatchObject({ mode: 'options', values: [4,6,8] });
    expect(getModelSpecification('funai-minimax-h3')).toMatchObject({ limits: { resolutions: ['1440p'], maxAudios: 3 } });
    expect(db.select().from(models).all().some(model => model.modelId.includes('unknown-new-video'))).toBe(false);
  });
  it('preserves custom route settings, sale prices and manual switches on resync and adds another channel as a route', async () => {
    await ChannelService.syncModels(channelId);
    const id = 'funai-veo-3.1', spec = getModelSpecification(id)!;
    price(id, 'per_call', 3);
    spec.enabled = false; spec.routes[0].enabled = false; spec.routes[0].cost = 0.25; spec.routes[0].costUnit = 'per_call';
    spec.routes[0].upstreamModel = 'custom-provider-override'; saveModelSpecification(spec);
    await ChannelService.syncModels(channelId);
    expect(getModelSpecification(id)).toMatchObject({ enabled: false, routes: [{ enabled: false, cost: 0.25, upstreamModel: 'custom-provider-override' }] });
    expect(db.select().from(models).where(eq(models.modelId, id)).get()?.isActive).toBe(1);
    expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern, id)).get()?.inputPrice).toBe(3);
    const second = ChannelService.createChannel({ name: 'FunAI second', type: 'funai', baseUrl: 'https://proxy.example/v1', apiKey: 'another-key' });
    await ChannelService.syncModels(second);
    expect(getModelSpecification(id)!.routes).toHaveLength(2);
    expect(getModelSpecification(id)!.enabled).toBe(false);
  });
  it('keeps the old catalog intact on malformed discovery and removes unavailable models from routing', async () => {
    await ChannelService.syncModels(channelId);
    const before = ChannelService.getChannelRaw(channelId)!.supportedModels;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ model: 'bad-shape' }] })));
    await expect(ChannelService.syncModels(channelId)).rejects.toThrow('格式');
    expect(ChannelService.getChannelRaw(channelId)!.supportedModels).toBe(before);
    const id = 'funai-veo-3.1'; price(id);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [] })));
    await ChannelService.syncModels(channelId);
    expect(selectModelRoutes(getModelSpecification(id)!, { ...input(), ratio: '16:9' })).toEqual([]);
  });
  it('generates and saves a video with the chosen route and settles exactly once', async () => {
    await ChannelService.syncModels(channelId); price('funai-veo-3.1');
    let posted: any;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (init?.method === 'POST') { posted = JSON.parse(init.body); return Response.json({ id: 'video/opaque', status: 'queued' }); }
      expect(String(url)).toBe('https://ztyunjuan.com/v1/videos/video%2Fopaque');
      return Response.json({ status: 'completed', url: 'https://cdn.example/result.mp4', progress: 100 });
    }));
    const res = response();
    expect(await handleSpecificationGeneration(req('funai-veo-3.1', { seconds: 8, resolution: '1080p', aspect_ratio: '9:16' }), res, 'video')).toBe(true);
    expect(posted).toMatchObject({ model: 'veo-3.1', seconds: 8, resolution: '1080p', aspect_ratio: '9:16' });
    const record = db.select().from(contents).all().at(-1)!;
    expect(record, JSON.stringify(res.body)).toMatchObject({ status: 'completed', resultUrl: '/uploads/funai-result.mp4', cost: 2 });
    expect(JSON.parse(record.metadata)).toMatchObject({ upstreamTaskId: 'video/opaque', channelId, billingStatus: 'settled', actualChannel: 'funai' });
    expect(downloadAndLocalizeVideo).toHaveBeenCalledWith('https://cdn.example/result.mp4', 'video/opaque', 'funai-veo-3.1', channelId, null);
    expect(db.select().from(users).where(eq(users.id, userId)).get()?.balance).toBe(98);
  });
  it.each(['funai-gpt-image-2-2k', 'funai-nano-banana2-2k'])('generates %s through the website with result saving and image billing', async id => {
    await ChannelService.syncModels(channelId); price(id);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).includes(':generateContent')) return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] } }] });
      if (init?.method === 'POST') return Response.json({ id: 'image-accepted', status: 'queued' });
      return Response.json({ status: 'completed', data: [{ url: 'https://cdn.example/image.png' }] });
    }));
    const res = response();
    await handleSpecificationGeneration(req(id, { n: 2 }), res, 'image');
    const record = db.select().from(contents).all().at(-1)!;
    expect(record, JSON.stringify(res.body)).toMatchObject({ status: 'completed', resultUrl: '/api/uploads/funai-result.png', cost: 4 });
    expect(localizeGeneratedImage).toHaveBeenCalledTimes(2);
    expect(JSON.parse(record.metadata).imageUrls).toHaveLength(2);
    expect(db.select().from(users).where(eq(users.id, userId)).get()?.balance).toBe(96);
  });
  it('uses per-second sale pricing for MiniMax and refunds a confirmed upstream failure', async () => {
    await ChannelService.syncModels(channelId); price('funai-minimax-h3', 'per_second', 0.2);
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => init?.method === 'POST'
      ? Response.json({ id: 'minimax-task' }) : Response.json({ status: 'failed', error: { message: 'generation failed' } })));
    const res = response(); await handleSpecificationGeneration(req('funai-minimax-h3', { seconds: 10 }), res, 'video');
    const record = db.select().from(contents).all().at(-1)!;
    expect(record).toMatchObject({ status: 'failed', cost: 0 });
    expect(JSON.parse(record.metadata)).toMatchObject({ reservedCost: 2, billingStatus: 'refunded' });
    expect(db.select().from(users).where(eq(users.id, userId)).get()?.balance).toBe(100);
  });
  it('holds uncertain submissions for review instead of submitting again or refunding', async () => {
    await ChannelService.syncModels(channelId); price('funai-veo-3.1');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection lost'); }));
    const res = response(); await handleSpecificationGeneration(req('funai-veo-3.1'), res, 'video');
    const record = db.select().from(contents).all().at(-1)!;
    expect(JSON.parse(record.metadata)).toMatchObject({ requiresReview: true, billingStatus: 'review', actualChannel: 'funai' });
    expect(fetch).toHaveBeenCalledTimes(1); expect(db.select().from(users).where(eq(users.id, userId)).get()?.balance).toBe(98);
  });
  it('resumes the exact accepted image using GET and normalizes cancellation as failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'completed', data: [{ url: 'https://cdn.example/img.png' }] })));
    expect(await pollSpecificationImage(ChannelService.getChannelRaw(channelId), 'accepted/id')).toMatchObject({ status: 'completed', imageUrl: 'https://cdn.example/img.png' });
    expect(fetch).toHaveBeenCalledWith('https://ztyunjuan.com/v1/videos/accepted%2Fid', expect.objectContaining({ headers: { Authorization: 'Bearer ' + key } }));
    expect((fetch as any).mock.calls.every((call: any) => !call[1].method || call[1].method === 'GET')).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'cancelled', error: { message: 'cancelled' } })));
    expect(await pollSpecificationImage(ChannelService.getChannelRaw(channelId), 'accepted/id')).toMatchObject({ status: 'failed' });
  });
  it('retains an accepted GPT image ID and treats its failure as confirmed', async () => {
    await ChannelService.syncModels(channelId); price('funai-gpt-image-2-1k');
    const target = selectModelRoutes(getModelSpecification('funai-gpt-image-2-1k')!, input('1K'))[0];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => init?.method === 'POST' ? Response.json({ id: 'accepted' })
      : Response.json({ status: 'failed', error: { message: 'policy ' + key } })));
    const submitted = vi.fn();
    await expect(generateSpecificationImage(target, { prompt: 'x', input: { images: 0, videos: 0, audios: 0, outputs: 1, seconds: 6, resolution: '1K', ratio: '1:1', firstFrame: false, lastFrame: false }, images: [], videos: [], audios: [], firstFrame: '', lastFrame: '', body: {}, publicBaseUrl: 'https://app.example' }, vi.fn(), submitted))
      .rejects.toMatchObject({ confirmedFailure: true, uncertain: false });
    expect(submitted).toHaveBeenCalledExactlyOnceWith('accepted');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
