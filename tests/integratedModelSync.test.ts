import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/config/env.js', () => ({ env: { NODE_ENV: 'test', GEMINI_API_KEY: '', GEMINI_API_BASE_URL: 'https://google.invalid',
  ADMIN_EMAIL: 'sync@test.invalid', ADMIN_PASSWORD: 'test-only-password' }, getApiKeys: () => [] }));
vi.mock('../server/middleware/auth.js', () => ({ authMiddleware: (req: any, _res: any, next: any) => { req.userRole = 'super_admin'; next(); } }));
import express from 'express';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../server/db/index.js';
import { channelApiKeys, channels, contents, models, modelPricing, users } from '../server/db/schema.js';
import { initDatabase, syncModelsFromAPI } from '../server/db/seed.js';
import { env } from '../server/config/env.js';
import channelRoutes from '../server/routes/channels.js';
import { ChannelService } from '../server/services/channelService.js';
import { reserveUserCharge } from '../server/services/billingReservation.js';
import { asyncVideoPublicModelId } from '../shared/asyncVideo.js';
import { defaultRoutingLimits } from '../shared/modelRouting.js';
import { getModelSpecification, saveModelSpecification } from '../server/services/modelRoutingService.js';

const nativeFetch = globalThis.fetch;
let server: ReturnType<ReturnType<typeof express>['listen']>, origin: string;
let catalog: any, upstreamStatus = 200;
const sync = async (id: number) => {
  const r = await nativeFetch(origin + `/channels/${id}/sync-models`, { method: 'POST' });
  return { status: r.status, body: await r.json() as any };
};
const model = (id: string, provider = 'openai') => db.insert(models).values({ provider, modelId: id, displayName: '管理员名称', isActive: 0 }).run();
const channel = (patch: any = {}) => db.insert(channels).values({ name: 'scope', type: 'openai', baseUrl: 'https://catalog.invalid', apiKey: 'test', ...patch }).returning().get();
beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw Error('No external calls'); }));
  await initDatabase();
  const app = express(); app.use(express.json()); app.use('/channels', channelRoutes);
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as any).port;
});
beforeEach(() => {
  sqlite.exec('SAVEPOINT sync_scope'); catalog = { data: [] }; upstreamStatus = 200;
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(catalog, { status: upstreamStatus })));
});
afterEach(() => { sqlite.exec('ROLLBACK TO sync_scope; RELEASE sync_scope'); env.GEMINI_API_KEY = ''; vi.unstubAllGlobals(); });
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); sqlite.close(); });

describe('actual admin model sync scope', () => {
  it.each([
    { type: 'openai', baseUrl: 'https://julun.cc', known: 'wan3.0th' },
    { type: 'snumom', baseUrl: 'https://snumom.com', known: 'sd-mini' },
    { type: 'hmstudio', baseUrl: 'https://hm.invalid', known: 'SD2.0MINI503' },
  ])('archives stale mapped entries and retains the actual $type mapping on repeat sync', async ({ type, baseUrl, known }) => {
    const stale = 'old-catalog-only';
    const c = channel({ type, baseUrl, supportedModels: JSON.stringify([known, stale]),
      modelMapping: JSON.stringify({ [known]: known, [stale]: stale }) });
    if (type === 'hmstudio') db.insert(channelApiKeys).values({ channelId: c.id, name: 'test', apiKey: 'test' }).run();
    model(stale);
    catalog = { data: [known, stale] };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await sync(c.id)).toMatchObject({ status: 200, body: { models: [known] } });
      expect(ChannelService.getChannelRaw(c.id)).toMatchObject({
        supportedModels: JSON.stringify([known]), modelMapping: JSON.stringify({ [known]: known }),
      });
    }
    expect(db.select().from(models).where(eq(models.modelId, stale)).get()).toBeDefined();
  });

  it('detaches an old auto-generated async route while keeping its completed task and price', async () => {
    const c = channel({ type: 'async-video' });
    const upstream = 'old-unverified-async';
    const stale = asyncVideoPublicModelId(c.id, upstream);
    const limits = defaultRoutingLimits();
    model(stale, 'async-video');
    db.update(models).set({ capabilities: '["video"]' }).where(eq(models.modelId, stale)).run();
    db.insert(modelPricing).values({ modelPattern: stale, inputPrice: 6 }).run();
    db.update(channels).set({ supportedModels: JSON.stringify([stale]), modelMapping: JSON.stringify({ [stale]: upstream }) }).where(eq(channels.id, c.id)).run();
    saveModelSpecification({ modelId: stale, kind: 'video', enabled: true, aliases: [], limits,
      routes: [{ id: 'async-video-' + c.id + '-1', channelId: c.id, executionModel: stale, upstreamModel: upstream,
        enabled: true, limits, cost: null, costUnit: 'unknown', resolutionCosts: {}, priority: 0 }] });
    const user = db.select().from(users).get()!;
    const task = db.insert(contents).values({ userId: user.id, type: 'video', title: '原任务', modelId: stale, status: 'completed',
      metadata: JSON.stringify({ channelId: c.id, upstreamTaskId: 'original' }) }).returning().get();
    catalog = { data: [{ name: upstream }] };
    expect(await sync(c.id)).toMatchObject({ status: 200, body: { count: 0, models: [] } });
    expect(ChannelService.getChannelRaw(c.id)).toMatchObject({ supportedModels: '[]', modelMapping: '{}' });
    expect(getModelSpecification(stale)?.routes).toEqual([]);
    expect(db.select().from(contents).where(eq(contents.id, task.id)).get()).toEqual(task);
    expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern, stale)).get()?.inputPrice).toBe(6);
  });

  it('removes historical Siyuetian catalog-only bindings even if still advertised upstream', async () => {
    const stale = 'seedance-2.0-fast-480p-c3';
    const known = 'seedance-2.0-mini-720p';
    const c = channel({ baseUrl: 'https://llm.domie.studio', supportedModels: JSON.stringify([known, stale]),
      modelMapping: JSON.stringify({ [known]: known, [stale]: stale }) });
    model(stale);
    db.insert(modelPricing).values({ modelPattern: stale, inputPrice: 7 }).run();
    catalog = { data: [known, stale] };
    const result = await sync(c.id);
    expect(result).toMatchObject({ status: 200, body: { models: [known] } });
    expect(result.body.warnings).toContainEqual(expect.stringContaining(stale));
    expect(ChannelService.getChannelRaw(c.id)).toMatchObject({
      supportedModels: JSON.stringify([known]), modelMapping: JSON.stringify({ [known]: known }),
    });
    expect(db.select().from(models).where(eq(models.modelId, stale)).get()).toBeDefined();
    expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern, stale)).get()?.inputPrice).toBe(7);
    await sync(c.id);
    const archive = sqlite.prepare('SELECT value FROM settings WHERE key=?').get('siyuetian_removed_catalog_bindings_' + c.id) as { value: string };
    expect(JSON.parse(archive.value)).toEqual([{ supportedModels: [stale], modelMapping: { [stale]: stale } }]);
  });

  it('does not recreate removed Siyuetian mappings or unmapped old associations on repeated startup and sync', async () => {
    const c = db.select().from(channels).where(eq(channels.baseUrl, 'https://llm.chre3.com')).get()!;
    const kept = 'seedance-2.0-mini-720p';
    const c5 = 'S4-seedance2.5';
    const unmapped = 'gpt-image-2-siyuetian';
    const stale = 'seedance-2.0-480p-c3';
    const savedMapping = { [kept]: kept };
    expect(getModelSpecification(c5)?.routes[0]).toMatchObject({ channelId: c.id, upstreamModel: 'seedance-2.5-720p-c5' });
    sqlite.prepare('DELETE FROM settings WHERE key=?').run('catalog_siyuetian_seedance_c5_' + c.id);
    db.update(channels).set({ apiKey: 'test', supportedModels: JSON.stringify([kept, c5, unmapped, stale]),
      modelMapping: JSON.stringify({ ...savedMapping, [stale]: stale }) }).where(eq(channels.id, c.id)).run();
    for (let attempt = 0; attempt < 2; attempt++) {
      await initDatabase();
      catalog = { data: [kept, 'seedance-2.5-720p-c5', 'gpt-image-2', stale] };
      expect(await sync(c.id)).toMatchObject({ status: 200, body: { models: [kept] } });
      expect(ChannelService.getChannelRaw(c.id)).toMatchObject({
        supportedModels: JSON.stringify([kept]), modelMapping: JSON.stringify(savedMapping),
      });
    }
  });
  it('uses the saved upstream ID, while the same local model without a mapping cannot sync on another Siyuetian channel', async () => {
    const id = 'nano-banana-2.1';
    const upstream = 'operator-image-upstream';
    const mapped = channel({ baseUrl: 'https://llm.domie.studio', modelMapping: JSON.stringify({ [id]: upstream }) });
    const unmapped = channel({ baseUrl: 'https://llm.domie.studio', supportedModels: JSON.stringify([id]) });
    catalog = { data: [id] };
    expect(await sync(mapped.id)).toMatchObject({ status: 200, body: { models: [] } });
    catalog = { data: [id, upstream] };
    expect(await sync(mapped.id)).toMatchObject({ status: 200, body: { models: [id] } });
    expect(await sync(unmapped.id)).toMatchObject({ status: 200, body: { models: [] } });
    expect(ChannelService.getChannelRaw(mapped.id)).toMatchObject({
      supportedModels: JSON.stringify([id]), modelMapping: JSON.stringify({ [id]: upstream }),
    });
    expect(ChannelService.getChannelRaw(unmapped.id)).toMatchObject({ supportedModels: '[]', modelMapping: '{}' });
  });
  it('removes historical unapproved V6K associations from the actual admin channel list after sync',async()=>{
    const id='ZH-dola2.0',c=channel({type:'zongheng-v6k',baseUrl:'https://www.v6k.top',supportedModels:JSON.stringify([id]),modelMapping:JSON.stringify({[id]:'dola2.0'})});
    model(id,'zongheng-v6k');db.insert(modelPricing).values({modelPattern:id,billingType:'per_call',inputPrice:6.5}).run();
    catalog={data:['dola2.0','Asedanco2.0']};const result=await sync(c.id);
    expect(result).toMatchObject({status:200,body:{models:['zh-seedance.2.0']}});
    expect(result.body.warnings.join('')).toContain('解除未接入');
    const list=await(await nativeFetch(origin+'/channels')).json() as any[];
    const current=list.find(row=>row.id===c.id),supported=typeof current.supportedModels==='string'?JSON.parse(current.supportedModels):current.supportedModels;
    expect(supported).not.toContain(id);expect(supported).toContain('zh-seedance.2.0');
    expect(db.select().from(models).where(eq(models.modelId,id)).get()).toMatchObject({displayName:'管理员名称',isActive:0});
    expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern,id)).get()?.inputPrice).toBe(6.5);
  });
  it('clears unapproved V6K bindings on actual startup while retaining the old order, reservation, price and model switch',async()=>{
    const id='ZH-dola2.0',c=channel({type:'zongheng-v6k',baseUrl:'https://www.v6k.top',supportedModels:JSON.stringify([id]),modelMapping:JSON.stringify({[id]:'dola2.0'})});
    model(id,'zongheng-v6k');db.insert(modelPricing).values({modelPattern:id,billingType:'per_call',inputPrice:6.5}).run();
    const user=db.select().from(users).get()!;db.update(users).set({balance:100}).where(eq(users.id,user.id)).run();reserveUserCharge(user.id,6.5,'startup-cleanup');
    db.insert(contents).values({userId:user.id,type:'video',modelId:id,status:'processing',cost:6.5,metadata:JSON.stringify({channelId:c.id,videoId:'original-on-startup',zonghengProtocol:'v6k'})}).run();
    const before=JSON.stringify([db.select().from(contents).all(),sqlite.prepare('SELECT * FROM billing_reservations').all(),db.select().from(users).all()]);
    await initDatabase();
    expect(ChannelService.getChannelRaw(c.id)!.supportedModels).toBe('[]');
    expect(JSON.stringify([db.select().from(contents).all(),sqlite.prepare('SELECT * FROM billing_reservations').all(),db.select().from(users).all()])).toBe(before);
    expect(db.select().from(models).where(eq(models.modelId,id)).get()).toMatchObject({isActive:0});expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern,id)).get()?.inputPrice).toBe(6.5);
  });
  it('does not treat a wildcard, an arbitrary upstream name or another channel binding as approval', async () => {
    const c = channel({ supportedModels: '["*"]' });
    channel({ supportedModels: '["foreign-image"]' }); model('foreign-image');
    catalog = { data: [{ id: 'future-video', type: 'video' }, { id: 'foreign-image' }] };
    const before = ChannelService.getChannelRaw(c.id);
    expect(await sync(c.id)).toMatchObject({ status: 200, body: { count: 0, added: 0, models: [] } });
    expect(ChannelService.getChannelRaw(c.id)).toEqual(before);
    expect(db.select().from(models).where(eq(models.modelId, 'future-video')).get()).toBeUndefined();
  });
  it.each(['openai', 'hmstudio', 'async-video'])('archives an unmapped legacy supported-model entry on %s', async type => {
    const c = channel({ type, supportedModels: '["unmapped-video"]', modelMapping: '{}' });
    if (type === 'hmstudio') db.insert(channelApiKeys).values({ channelId: c.id, name: 'test', apiKey: 'test' }).run();
    catalog = { data: type === 'async-video' ? [{ name: 'unmapped-video' }] : [{ id: 'unmapped-video', type: 'video' }] };
    expect(await sync(c.id)).toMatchObject({ status: 200, body: { count: 0, added: 0, models: [] } });
    expect(ChannelService.getChannelRaw(c.id)).toMatchObject({ supportedModels: '[]', modelMapping: '{}' });
    expect(db.select().from(models).where(eq(models.modelId, 'unmapped-video')).get()).toBeUndefined();
  });
  it('matches the configured upstream ID to its public alias and leaves orders, reservations, wallets and prices untouched', async () => {
    const c = channel({ supportedModels: '["approved-sale","unlisted-sale"]', modelMapping: '{"approved-sale":"upstream-v1","unlisted-sale":"absent"}' });
    model('approved-sale');
    db.insert(modelPricing).values({ modelPattern: 'approved-sale', billingType: 'per_second', inputPrice: 0.28, extraParams: '{"720p":0.4}' }).run();
    const user = db.select().from(users).get()!;
    db.update(users).set({ balance: 100 }).where(eq(users.id, user.id)).run();
    reserveUserCharge(user.id, 6.5, 'sync-test');
    db.insert(contents).values({ userId: user.id, type: 'video', modelId: 'approved-sale', status: 'processing', cost: 6.5,
      metadata: JSON.stringify({ videoId: 'original-task', channelId: c.id, billingStatus: 'reserved' }) }).run();
    const snapshot = () => JSON.stringify(['users', 'contents', 'billing_reservations', 'model_pricing'].map(t => sqlite.prepare(`SELECT * FROM ${t}`).all()));
    const before = snapshot();
    catalog = { data: ['upstream-v1', 'new-video'] };
    for (let n = 0; n < 2; n++) expect(await sync(c.id)).toMatchObject({ status: 200, body: { count: 1, added: 0, models: ['approved-sale'] } });
    expect(snapshot()).toBe(before);
    expect(ChannelService.getChannelRaw(c.id)).toMatchObject({ supportedModels: c.supportedModels, modelMapping: c.modelMapping });
    expect(db.select().from(models).where(eq(models.modelId, 'approved-sale')).get()).toMatchObject({ isActive: 0, displayName: '管理员名称' });
    expect(db.select().from(models).where(eq(models.modelId, 'upstream-v1')).get()).toBeUndefined();
    expect(db.select().from(models).where(eq(models.modelId, 'new-video')).get()).toBeUndefined();
  });
  it.each([{ data: [] }, { data: ['unapproved'] }, {}, { data: [null] }])('preserves exact channel configuration when no import is possible: %j', async body => {
    const c = channel({ supportedModels: '["approved"]', modelMapping: '{"approved":"approved"}' }); const before = ChannelService.getChannelRaw(c.id);
    catalog = body; const result = await sync(c.id);
    expect(result.status).toBe(body.data && body.data[0] !== null ? 200 : 502);
    expect(ChannelService.getChannelRaw(c.id)).toEqual(before);
  });
  it('creates only explicitly configured missing models, disabled, and keeps configured mappings', async () => {
    const c = channel({ supportedModels: '["custom-sale"]', modelMapping: '{"custom-sale":"raw-image"}' });
    catalog = { data: [{ id: 'raw-image', type: 'image' }, { id: 'other-image', type: 'image' }] };
    expect(await sync(c.id)).toMatchObject({ status: 200, body: { added: 1, models: ['custom-sale'] } });
    expect(db.select().from(models).where(eq(models.modelId, 'custom-sale')).get()).toMatchObject({ isActive: 0, capabilities: '["image"]' });
    expect(db.select().from(models).where(eq(models.modelId, 'other-image')).get()).toBeUndefined();
  });
  it('recognizes a disabled specification route without enabling or modifying the specification', async () => {
    const c = channel(); const limits = defaultRoutingLimits();
    model('route-only');
    db.update(models).set({ capabilities: '["video"]' }).where(eq(models.modelId, 'route-only')).run();
    saveModelSpecification({ modelId: 'route-only', kind: 'video', enabled: false, aliases: [], limits,
      routes: [{ id: 'explicit-route', channelId: c.id, executionModel: 'route-only', upstreamModel: 'route-upstream',
        enabled: false, limits, cost: null, costUnit: 'unknown', resolutionCosts: {}, priority: 0 }] });
    const before = getModelSpecification('route-only'); catalog = { data: ['route-upstream', 'future-video'] };
    expect(await sync(c.id)).toMatchObject({ status: 200, body: { models: ['route-only'] } });
    expect(getModelSpecification('route-only')).toEqual(before);
    expect(db.select().from(models).where(eq(models.modelId, 'route-only')).get()?.isActive).toBe(0);
  });
  it('retains concurrent administrator changes instead of overwriting them after the HTTP response', async () => {
    const c = channel({ supportedModels: '["approved"]', modelMapping: '{"approved":"approved"}' });
    vi.stubGlobal('fetch', vi.fn(async () => {
      db.update(channels).set({ supportedModels: '["admin-new"]' }).where(eq(channels.id, c.id)).run();
      return Response.json({ data: ['approved'] });
    }));
    expect(await sync(c.id)).toMatchObject({ status: 409 });
    expect(ChannelService.getChannelRaw(c.id)?.supportedModels).toBe('["admin-new"]');
    expect(db.select().from(models).where(eq(models.modelId, 'approved')).get()).toBeUndefined();
  });
  it('filters new HM products even if the upstream labels them as video', async () => {
    const c = channel({ type: 'hmstudio' }); catalog = { data: ['DDLONG-SD2.5', { id: 'hm-new-video', type: 'video' }] };
    db.insert(channelApiKeys).values({ channelId: c.id, name: 'test', apiKey: 'test' }).run();
    expect(await sync(c.id)).toMatchObject({ status: 200, body: { models: ['sd2.5-933'] } });
    expect(db.select().from(models).where(eq(models.modelId, 'hm-new-video')).get()).toBeUndefined();
    const before = ChannelService.getChannelRaw(c.id); catalog = { data: ['hm-new-video'] };
    expect(await sync(c.id)).toMatchObject({ status: 200, body: { count: 0 } });
    expect(ChannelService.getChannelRaw(c.id)).toEqual(before);
  });
  it('filters arbitrary async models but permits the confirmed 2.0B product', async () => {
    const c = channel({ type: 'async-video' });
    catalog = { data: [{ name: '2.0B' }, { name: 'new-async-video' }] };
    const id = asyncVideoPublicModelId(c.id, '2.0B');
    expect(await sync(c.id)).toMatchObject({ status: 200, body: { models: [id] } });
    expect(db.select().from(models).where(eq(models.modelId, asyncVideoPublicModelId(c.id, 'new-async-video'))).get()).toBeUndefined();
  });
  it.each(['hmstudio', 'async-video'])('retains an explicitly bound custom public alias for %s', async type => {
    const c = channel({ type, supportedModels: '["custom-alias"]', modelMapping: '{"custom-alias":"configured-upstream"}' });
    if (type === 'hmstudio') db.insert(channelApiKeys).values({ channelId: c.id, name: 'test', apiKey: 'test' }).run();
    catalog = { data: type === 'hmstudio' ? ['configured-upstream', 'unapproved'] : [{ name: 'configured-upstream' }, { name: 'unapproved' }] };
    expect(await sync(c.id)).toMatchObject({ status: 200, body: { models: ['custom-alias'] } });
    expect(db.select().from(models).where(eq(models.modelId, 'custom-alias')).get()?.isActive).toBe(0);
    expect(JSON.parse(ChannelService.getChannelRaw(c.id)!.modelMapping)['custom-alias']).toBe('configured-upstream');
  });
  it('applies the allowlist to startup discovery too and does not delete previously configured Google models or prices', async () => {
    model('gemini-existing-tts', 'google');
    db.insert(modelPricing).values({ modelPattern: 'gemini-existing-tts', inputPrice: 1.23 }).run();
    env.GEMINI_API_KEY = 'test';
    catalog = { data: [{ id: 'gemini-future-tts' }, { id: 'gemini-2.5-flash' }] };
    await syncModelsFromAPI();
    expect(db.select().from(models).where(eq(models.modelId, 'gemini-future-tts')).get()).toBeUndefined();
    expect(db.select().from(models).where(eq(models.modelId, 'gemini-existing-tts')).get()).toMatchObject({ isActive: 0 });
    expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern, 'gemini-existing-tts')).get()?.inputPrice).toBe(1.23);
  });
});
