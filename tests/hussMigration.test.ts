import { beforeEach, afterEach, afterAll, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
import { db, sqlite } from '../server/db/index.js';
import { channels, models, settings, modelPricing } from '../server/db/schema.js';
import { eq } from 'drizzle-orm';
import { retireBlobDrawChannels } from '../server/services/blobDrawRetirementMigration.js';
import { syncHussModels } from '../server/services/hussCatalogService.js';
import { getModelSpecification, saveModelSpecification } from '../server/services/modelRoutingService.js';
import { HUSS_BB_MODEL, HUSS_BB_PUBLIC_MODEL, hussBbModelLimits } from '../shared/hussBbVideo.js';
const channel = () => db.select().from(channels).where(eq(channels.id, 1)).get()!;
beforeEach(() => {
  db.delete(modelPricing).run(); db.delete(settings).run(); db.delete(models).run(); db.delete(channels).run();
  db.insert(channels).values({ id: 1, name: 'Original name', type: 'blobdraw', baseUrl: 'https://www.huss.top', apiKey: 'new-huss-key', status: 1 }).run();
  db.insert(models).values({ modelId: HUSS_BB_PUBLIC_MODEL, provider: 'blobdraw', displayName: 'BB', capabilities: '["video"]', isActive: 1 }).run();
  db.insert(modelPricing).values({ modelPattern: HUSS_BB_PUBLIC_MODEL, inputPrice: 6 }).run();
  saveModelSpecification({ modelId: HUSS_BB_PUBLIC_MODEL, kind: 'video', enabled: true, aliases: [], limits: hussBbModelLimits(), routes: [
    { id: 'original-route', channelId: 1, executionModel: HUSS_BB_PUBLIC_MODEL, upstreamModel: HUSS_BB_PUBLIC_MODEL, enabled: false, limits: hussBbModelLimits(), cost: 3, costUnit: 'per_call', resolutionCosts: {}, priority: 7 },
  ] });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => sqlite.close());
it('migrates already switched channels without destroying HUSS credentials, prices or route controls', () => {
  expect(retireBlobDrawChannels()).toBe(1);
  expect(channel()).toMatchObject({ type: 'huss', apiKey: 'new-huss-key', status: 1, name: 'Original name', maxRetries: 0 });
  expect(JSON.parse(channel().modelMapping)).toEqual({ [HUSS_BB_PUBLIC_MODEL]: HUSS_BB_MODEL });
  expect(getModelSpecification(HUSS_BB_PUBLIC_MODEL)?.routes[0]).toMatchObject({ id: 'original-route', upstreamModel: HUSS_BB_MODEL, cost: 3, enabled: false, priority: 7 });
  expect(db.select().from(models).get()).toMatchObject({ isActive: 1 });
  expect(db.select().from(modelPricing).get()).toMatchObject({ inputPrice: 6 });
  expect(retireBlobDrawChannels()).toBe(0);
});
it('never forwards an actual old provider key to HUSS', () => {
  db.update(channels).set({ baseUrl: 'https://www.iblob.cc/api/v1' }).where(eq(channels.id, 1)).run();
  retireBlobDrawChannels();
  expect(channel()).toMatchObject({ type: 'huss', apiKey: '', status: 0, baseUrl: 'https://www.huss.top' });
  expect(getModelSpecification(HUSS_BB_PUBLIC_MODEL)).toBeFalsy();
});
it('sync repairs existing stale routes and is repeatable without overriding price or enabled state', async () => {
  db.update(channels).set({ type: 'huss' }).where(eq(channels.id, 1)).run();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: HUSS_BB_MODEL }] })));
  await syncHussModels(channel()); await syncHussModels(channel());
  expect(getModelSpecification(HUSS_BB_PUBLIC_MODEL)?.routes).toHaveLength(1);
  expect(getModelSpecification(HUSS_BB_PUBLIC_MODEL)?.routes[0]).toMatchObject({ id: 'original-route', upstreamModel: HUSS_BB_MODEL, cost: 3, enabled: false, priority: 7 });
  expect(db.select().from(models).get()).toMatchObject({ isActive: 1 });
  expect(db.select().from(modelPricing).get()).toMatchObject({ inputPrice: 6 });
});


it('keeps an explicitly supplied HUSS key when an older admin form still sends blobdraw', async () => {
  const { ChannelService } = await import('../server/services/channelService.js');
  ChannelService.updateChannel(1, { type: 'blobdraw', baseUrl: 'https://www.huss.top', apiKey: 'replacement-huss-key' });
  expect(channel()).toMatchObject({ type: 'huss', apiKey: 'replacement-huss-key', maxRetries: 0 });
});

it('syncs HSS independently and preserves administrator pricing and enablement', async () => {
  const modelId = 'hss-2.5-301010';
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: modelId }] })));
  await syncHussModels(channel());
  expect(db.select().from(models).where(eq(models.modelId, modelId)).get()).toMatchObject({ isActive: 0 });
  expect(getModelSpecification(modelId)?.limits).toMatchObject({ resolutions: ['720p'], duration: { min: 4, max: 30 }, maxImages: 30 });
  db.update(models).set({ isActive: 1 }).where(eq(models.modelId, modelId)).run();
  db.insert(modelPricing).values({ modelPattern: modelId, inputPrice: 8.8 }).run();
  await syncHussModels(channel());
  expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern, modelId)).get()).toMatchObject({ inputPrice: 8.8 });
  expect(db.select().from(models).where(eq(models.modelId, modelId)).get()).toMatchObject({ isActive: 1 });
  expect(getModelSpecification(modelId)?.routes).toHaveLength(1);
  expect(JSON.parse(channel().modelMapping)).toEqual({ [modelId]: modelId });
});


it('switches the existing public HSS route to channel B without changing prices or adding a public model', async () => {
  const old='hss-2.5-301010', next=old+'-渠道B';
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({data:[{id:old}]})));
  await syncHussModels(channel());
  db.update(models).set({isActive:1}).where(eq(models.modelId,old)).run();
  db.insert(modelPricing).values({modelPattern:old,inputPrice:8.8}).run();
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({data:[{id:next},{id:old}]})));
  await syncHussModels(channel());
  await syncHussModels(channel());
  expect(JSON.parse(channel().modelMapping)).toEqual({[old]:next});
  expect(getModelSpecification(old)?.routes).toHaveLength(1);
  expect(getModelSpecification(old)?.routes[0].upstreamModel).toBe(next);
  expect(db.select().from(models).where(eq(models.modelId,next)).get()).toBeUndefined();
  expect(db.select().from(models).where(eq(models.modelId,old)).get()?.isActive).toBe(1);
  expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern,old)).get()?.inputPrice).toBe(8.8);
});
