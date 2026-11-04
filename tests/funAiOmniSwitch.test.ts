import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/services/videoLocalizationService.js', () => ({ downloadAndLocalizeVideo: vi.fn(async () => '/uploads/omni.mp4') }));
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../server/db/index.js';
import { channels, contents, models, modelPricing, users, settings } from '../server/db/schema.js';
import { ChannelService } from '../server/services/channelService.js';
import { getModelSpecification, saveModelSpecification, selectModelRoutes } from '../server/services/modelRoutingService.js';
import { migrateFunAiOmniFlash11 } from '../server/services/funAiOmniMigration.js';
import { handleSpecificationGeneration, resumeSpecificationTasks } from '../server/services/specificationGenerationService.js';
import { reserveUserCharge, linkReservationContent } from '../server/services/billingReservation.js';
import { batchStore, tickVideoBatches } from '../server/services/videoBatchService.js';
import { buildFunAiVideoPayload } from '../server/services/funAiAdapter.js';
import { FUNAI_OMNI_FLASH_11_MODEL as next, FUNAI_OMNI_FLASH_ENTRY as old, funAiModelLimits } from '../shared/funAi.js';

const sale = 'funai-' + old, routesKey = 'model_specification_routes_v1';
const input = { images: 0, videos: 0, audios: 0, outputs: 1, seconds: 10, ratio: '9:16', resolution: '720p', firstFrame: false, lastFrame: false };
let channelId: number;
const row = () => ChannelService.getChannelRaw(channelId)!;
const balance = () => db.select().from(users).get()!.balance;
const latest = () => db.select().from(contents).all().at(-1)!;
const request = (body: any = {}, headers: any = {}) => ({ userId: 1, headers, body: { model: sale, prompt: 'original prompt', seconds: 10, aspect_ratio: '9:16', ...body }, protocol: 'https', get: () => 'app.example' }) as any;
function response() {
  const res: any = { headersSent: false, writableEnded: false, destroyed: false, events: [] };
  res.status = vi.fn(code => { res.statusCode = code; return res; }); res.json = vi.fn(body => { res.body = body; return res; });
  res.setHeader = vi.fn(); res.flushHeaders = vi.fn(() => { res.headersSent = true; });
  res.write = vi.fn(text => res.events.push(text)); res.end = vi.fn(() => { res.writableEnded = true; }); return res;
}
beforeEach(() => {
  vi.clearAllMocks();
  for (const { name } of sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) sqlite.exec(`DELETE FROM "${name}"`);
  db.insert(users).values({ id: 1, username: 'test', email: 'omni@example.test', passwordHash: 'unused', balance: 100 }).run();
  channelId = ChannelService.createChannel({ name: 'existing channel', type: 'funai', baseUrl: 'https://ztyunjuan.com', apiKey: 'private-key' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: next }] })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(() => sqlite.close());
async function enable() {
  await ChannelService.syncModels(channelId);
  db.update(models).set({ isActive: 1 }).where(eq(models.modelId, sale)).run();
  db.insert(modelPricing).values({ modelPattern: sale, billingType: 'per_call', inputPrice: 0.6, outputPrice: 0 }).run();
}
function oldConfig() {
  db.update(channels).set({ modelMapping: JSON.stringify({ [sale]: old, custom: 'manual-override' }), supportedModels: JSON.stringify([sale]) }).where(eq(channels.id, channelId)).run();
  db.insert(settings).values({ key: routesKey, value: JSON.stringify([{ modelId: sale, enabled: false, routes: [
    { channelId, upstreamModel: old, enabled: false, cost: 0.37 },
    { channelId, upstreamModel: 'manual-override' }, { channelId: 999, upstreamModel: old },
  ] }]) }).run();
}

describe('Omni Flash 1.1 replacement and original-task safety', () => {
  it('switches persisted channel and specification mappings together, preserves all other settings and is one-time', () => {
    oldConfig(); const before = row();
    db.insert(modelPricing).values({ modelPattern: sale, billingType: 'per_call', inputPrice: 0.6 }).run();
    db.insert(contents).values({ userId: 1, type: 'video', modelId: sale, status: 'processing', cost: 0.6, metadata: JSON.stringify({ upstreamModel: old, videoId: 'original-task' }) }).run();
    const original = latest();
    migrateFunAiOmniFlash11(sqlite);
    expect(JSON.parse(row().modelMapping)).toEqual({ [sale]: next, custom: 'manual-override' });
    expect(row()).toMatchObject({ apiKey: before.apiKey, status: before.status, supportedModels: before.supportedModels });
    const config = JSON.parse(db.select().from(settings).where(eq(settings.key, routesKey)).get()!.value);
    expect(config[0]).toMatchObject({ enabled: false, routes: [{ upstreamModel: next, enabled: false, cost: 0.37 }, { upstreamModel: 'manual-override' }, { upstreamModel: old }] });
    expect(latest()).toEqual(original); expect(balance()).toBe(100);
    expect(db.select().from(modelPricing).get()?.inputPrice).toBe(0.6);
    db.update(channels).set({ modelMapping: '{"custom":"changed-after-migration"}' }).where(eq(channels.id, channelId)).run();
    migrateFunAiOmniFlash11(sqlite);
    expect(row().modelMapping).toBe('{"custom":"changed-after-migration"}');
  });
  it('recognizes the exact legacy channel host and leaves other providers untouched', () => {
    oldConfig(); db.update(channels).set({ type: 'openai' }).where(eq(channels.id, channelId)).run();
    const other = ChannelService.createChannel({ name: 'other', type: 'openai', baseUrl: 'https://other.example', apiKey: 'other-key', supportedModels: [sale], modelMapping: { [sale]: old } });
    migrateFunAiOmniFlash11(sqlite);
    expect(JSON.parse(row().modelMapping)[sale]).toBe(next);
    expect(JSON.parse(ChannelService.getChannelRaw(other)!.modelMapping)[sale]).toBe(old);
  });
  it('does not partially update mappings or mark migration complete if persisted config is malformed', () => {
    oldConfig(); db.update(settings).set({ value: '{}' }).where(eq(settings.key, routesKey)).run();
    expect(() => migrateFunAiOmniFlash11(sqlite)).toThrow('不是数组');
    expect(JSON.parse(row().modelMapping)[sale]).toBe(old);
    expect(db.select().from(settings).all()).toHaveLength(1);
  });
  it('rolls channel mappings back when saving the specification fails and can safely resume the migration', () => {
    oldConfig();
    sqlite.exec("CREATE TRIGGER reject_omni_migration BEFORE UPDATE ON settings WHEN NEW.key='model_specification_routes_v1' BEGIN SELECT RAISE(ABORT,'test rollback'); END;");
    try { expect(() => migrateFunAiOmniFlash11(sqlite)).toThrow('test rollback'); }
    finally { sqlite.exec('DROP TRIGGER reject_omni_migration'); }
    expect(JSON.parse(row().modelMapping)[sale]).toBe(old);
    expect(db.select().from(settings).all()).toHaveLength(1);
    migrateFunAiOmniFlash11(sqlite);
    expect(JSON.parse(row().modelMapping)[sale]).toBe(next);
  });
  it('discovers the new model as one disabled sale until the administrator enables it', async () => {
    expect(await ChannelService.syncModels(channelId)).toMatchObject({ added: 1, models: [sale] });
    expect(db.select().from(models).get()).toMatchObject({ modelId: sale, isActive: 0 });
    expect(JSON.parse(row().modelMapping)[sale]).toBe(next);
    expect(getModelSpecification(sale)!.routes[0].upstreamModel).toBe(next);
    expect(db.select().from(modelPricing).all()).toEqual([]);
  });
  it('deduplicates old/new discovery, keeps the original sale and administrator pricing, and respects custom routes', async () => {
    await enable(); const spec = getModelSpecification(sale)!;
    spec.routes[0].upstreamModel = old; spec.routes[0].cost = 0.29; spec.routes[0].costUnit = 'per_call'; spec.routes[0].enabled = false; spec.enabled = false;
    saveModelSpecification(spec);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: old }, { id: next }] })));
    expect(await ChannelService.syncModels(channelId)).toMatchObject({ count: 1, added: 0, models: [sale] });
    expect(getModelSpecification(sale)).toMatchObject({ enabled: false, routes: [{ upstreamModel: next, cost: 0.29, enabled: false }] });
    expect(db.select().from(models).all()).toHaveLength(1);
    expect(db.select().from(models).get()?.isActive).toBe(1);
    expect(db.select().from(modelPricing).get()?.inputPrice).toBe(0.6);
    const custom = getModelSpecification(sale)!; custom.routes[0].upstreamModel = 'manual-override'; saveModelSpecification(custom);
    await ChannelService.syncModels(channelId);
    expect(getModelSpecification(sale)!.routes[0].upstreamModel).toBe('manual-override');
  });
  it('does not silently switch back to the old upstream when the new ID is not authorized', async () => {
    await enable(); vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: old }] })));
    expect(await ChannelService.syncModels(channelId)).toMatchObject({ count: 0, warnings: [expect.stringContaining(next)] });
    expect(selectModelRoutes(getModelSpecification(sale)!, input)).toEqual([]);
    expect(db.select().from(models).get()?.isActive).toBe(1);
  });
  it.each(['frame', 'style', 'element'])('retains %s reference roles and base64 without truncation in the new upstream request', mode => {
    const image = 'data:image/png;base64,aGVsbG8=';
    const payload = buildFunAiVideoPayload(next, { prompt: 'x', input, images: [image], videos: [], audios: [], firstFrame: '', lastFrame: '', body: { reference_mode: mode }, publicBaseUrl: 'https://app.example' });
    expect(payload).toMatchObject({ model: next, seconds: 10, aspect_ratio: '9:16', resolution: '720p' });
    expect(payload[mode === 'frame' ? 'input_reference' : mode === 'style' ? 'style_references' : 'element_references']).toEqual(mode === 'frame' ? image : [image]);
    expect(funAiModelLimits(next)).toEqual(funAiModelLimits(old));
  });
  it('submits the new model through website generation and saves the accepted ID before polling with one sale charge', async () => {
    await enable();
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (init?.method === 'POST') {
        expect(url).toBe('https://ztyunjuan.com/v1/videos'); expect(JSON.parse(init.body)).toMatchObject({ model: next, seconds: 10 });
        return Response.json({ id: 'new/task', status: 'queued' });
      }
      expect(url).toBe('https://ztyunjuan.com/v1/videos/new%2Ftask');
      expect(JSON.parse(latest().metadata)).toMatchObject({ videoId: 'new/task', upstreamModel: next });
      return Response.json({ status: 'completed', url: 'https://cdn.example/result.mp4' });
    }));
    const res = response(); await handleSpecificationGeneration(request(), res, 'video');
    expect(latest(), JSON.stringify(res.body)).toMatchObject({ modelId: sale, status: 'completed', cost: 0.6 });
    expect(balance()).toBe(99.4); expect(fetch).toHaveBeenCalledTimes(2);
    resumeSpecificationTasks(); expect(fetch).toHaveBeenCalledTimes(2); expect(balance()).toBe(99.4);
  });
  it('dispatches a real prepaid batch through the shared website executor with one upstream POST and one charge', async () => {
    await enable();
    const batchId = batchStore.create(1, crypto.randomUUID(), { name: 'omni', model: sale, resolution: '720p', aspect_ratio: '9:16', video_length: 10,
      autoRetry: false, maxRetries: 0, creatives: [{ prompt: 'batch prompt', count: 1, reference_images: [] }] }, 0.6, 'https://app.example');
    const itemId = batchStore.detail(batchId, 1).items[0].id;
    let paidPosts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).includes('/api/video/generate')) {
        const headers = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]));
        const res = response(); await handleSpecificationGeneration(request(JSON.parse(init.body), headers), res, 'video');
        return new Response(res.events.join(''), { status: res.statusCode || 200 });
      }
      if (init?.method === 'POST') { paidPosts++; expect(JSON.parse(init.body).model).toBe(next); return Response.json({ id: 'batch-task' }); }
      return Response.json({ status: 'completed', url: 'https://cdn.example/batch.mp4' });
    }));
    tickVideoBatches();
    await vi.waitFor(() => expect(latest()?.status).toBe('completed'));
    tickVideoBatches(); tickVideoBatches();
    expect(batchStore.item(itemId)).toMatchObject({ status: 'completed', billing_state: 'charged' });
    expect(paidPosts).toBe(1); expect(balance()).toBe(99.4); expect(latest().cost).toBe(0.6);
  });
  it('recovers an old accepted task after migration using its original ID, never submits the replacement', async () => {
    await enable();
    const record = db.insert(contents).values({ userId: 1, type: 'video', modelId: sale, status: 'processing', cost: 0.6, metadata: '{}' }).returning().get();
    const charge = reserveUserCharge(1, 0.6, 'specification_generate', { contentId: record.id }); linkReservationContent(charge.id, record.id);
    db.update(contents).set({ metadata: JSON.stringify({ managedSpecification: true, channelId, videoId: 'old/accepted', upstreamTaskId: 'old/accepted', upstreamModel: old,
      actualModel: sale, requestedModel: sale, billingReservationId: charge.id, reservedCost: 0.6, count: 1 }) }).where(eq(contents.id, record.id)).run();
    migrateFunAiOmniFlash11(sqlite);
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      expect(init?.method || 'GET').toBe('GET'); expect(url).toBe('https://ztyunjuan.com/v1/videos/old%2Faccepted');
      return Response.json({ status: 'completed', url: 'https://cdn.example/old.mp4' });
    }));
    resumeSpecificationTasks(); resumeSpecificationTasks();
    await vi.waitFor(() => expect(latest().status).toBe('completed'));
    expect(JSON.parse(latest().metadata).upstreamModel).toBe(old);
    resumeSpecificationTasks(); expect(fetch).toHaveBeenCalledOnce(); expect(balance()).toBe(99.4);
    expect(sqlite.prepare('SELECT state,actual FROM billing_reservations WHERE id=?').get(charge.id)).toMatchObject({ state: 'settled', actual: 0.6 });
  });
});
