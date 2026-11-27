import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/services/videoLocalizationService.js', () => ({ downloadAndLocalizeVideo: vi.fn(async () => '/uploads/renamed-video.mp4') }));
import { eq } from 'drizzle-orm';
import express from 'express';
import jwt from 'jsonwebtoken';
import { db, sqlite } from '../server/db/index.js';
import { apiTokens, channels, contents, models, modelPricing, settings, tierModelAccess, users } from '../server/db/schema.js';
import { defaultRoutingLimits } from '../shared/modelRouting.js';
import type { V6kModelDraft } from '../shared/v6kModelConfiguration.js';
import { env } from '../server/config/env.js';
import channelRoutes from '../server/routes/channels.js';
import { ChannelService } from '../server/services/channelService.js';
import { listSiYueTianModelConfigurations, saveSiYueTianModelConfiguration } from '../server/services/siYueTianModelConfigurationService.js';
import { getModelSpecification, routeUnavailableReason, saveModelSpecification, selectModelRoutes } from '../server/services/modelRoutingService.js';
import { resolvePublicModelId } from '../server/services/publicModelNameService.js';
import { PricingService } from '../server/services/pricingService.js';
import { ensureUserModelTables } from '../server/db/userModelMigration.js';
import { assertUserModelAccess } from '../server/services/userModelAccessService.js';
import { handleSpecificationGeneration, resumeSpecificationTasks } from '../server/services/specificationGenerationService.js';
import { pruneSiYueTianCatalogBindings } from '../server/services/siYueTianApprovedBindings.js';

const oldId = 'seedance-2.0-mini-c8', newId = 'seedance-2.0-fast', baseUrl = 'https://llm.chre3.com';
const nativeFetch = fetch;
const draft: V6kModelDraft = { modelId: oldId, displayName: 'Mini video', upstreamModel: oldId,
  enabled: true, routeEnabled: true, limits: { ...defaultRoutingLimits(), ratios: ['16:9'], maxImages: 9, maxAudios: 3 } };
let channelId: number;
const input = { images: 0, videos: 0, audios: 0, outputs: 1, seconds: 5, resolution: '720p', ratio: '16:9', firstFrame: false, lastFrame: false };
const config = () => listSiYueTianModelConfigurations(channelId)[0];
const rename = (modelId = newId, originalModelId = oldId) => saveSiYueTianModelConfiguration(channelId,
  { ...draft, modelId }, config().version, originalModelId);
function response() {
  const res: any = { headersSent: false, writableEnded: false, destroyed: false };
  res.status = vi.fn(() => res); res.json = vi.fn(body => { res.body = body; return res; });
  res.setHeader = vi.fn(); res.flushHeaders = vi.fn(() => { res.headersSent = true; }); res.write = vi.fn();
  res.end = vi.fn(() => { res.writableEnded = true; });
  return res;
}
function catalog(url: string) {
  if (url.endsWith('/api/pricing')) return Response.json({
    supported_endpoint: { 'openai-video': { path: '/v1/videos', method: 'POST' } },
    data: [{ model_name: oldId, supported_endpoint_types: ['openai-video'] }],
  });
  return Response.json({ data: [{ id: oldId }] });
}
beforeEach(async () => {
  if (sqlite.prepare("SELECT name FROM sqlite_master WHERE name='video_submission_receipts'").get()) sqlite.exec('DELETE FROM video_submission_receipts');
  ensureUserModelTables(sqlite);
  sqlite.exec('DELETE FROM user_model_access; DELETE FROM user_model_pricing; DELETE FROM tier_model_access');
  db.delete(contents).run(); db.delete(apiTokens).run(); db.delete(settings).run();
  db.delete(modelPricing).run(); db.delete(models).run(); db.delete(channels).run(); db.delete(users).run();
  db.insert(users).values({ id: 1, email: 'rename@example.test', username: 'rename', passwordHash: 'unused', role: 'super_admin', balance: 100 }).run();
  channelId = ChannelService.createChannel({ name: '四月天', type: 'openai', baseUrl, apiKey: 'test-rename-key' });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => catalog(url)));
  await saveSiYueTianModelConfiguration(channelId, draft, null);
  db.update(models).set({ isActive: 1 }).where(eq(models.modelId, oldId)).run();
  db.insert(modelPricing).values({ modelPattern: oldId, billingType: 'per_call', inputPrice: 2.8,
    extraParams: JSON.stringify({ '720p': 2.8 }) }).run();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => sqlite.close());

it('moves the real ID, mapping, price and token permissions while retaining numeric identity and history', async () => {
  const original = db.select().from(models).where(eq(models.modelId, oldId)).get()!;
  const originalPrice = db.select().from(modelPricing).get()!;
  db.insert(apiTokens).values({ tokenKey: 'rename-token', allowedModels: JSON.stringify([oldId, 'another-model']), balance: 5, userId: 1 }).run();
  db.insert(tierModelAccess).values({ tierId: 1, modelId: original.id }).run();
  sqlite.prepare("INSERT INTO user_model_access(user_id,model_id,access_mode) VALUES(1,?,'allow')").run(original.id);
  sqlite.prepare("INSERT INTO user_model_pricing(user_id,model_id,billing_type,input_price,output_price,extra_params) VALUES(1,?,'per_call',2.5,0,'{}')").run(original.id);
  db.insert(contents).values({ userId: 1, type: 'video', modelId: oldId, title: 'original task', status: 'completed', resultUrl: '/uploads/original.mp4', cost: 2.8,
    metadata: JSON.stringify({ actualModel: oldId, upstreamModel: oldId, upstreamTaskId: 'task-original', billingStatus: 'settled' }) }).run();
  const history = db.select().from(contents).get();
  const result = await rename();
  expect(result.modelId).toBe(newId);
  expect(db.select().from(models).get()).toMatchObject({ id: original.id, modelId: newId, isActive: 1 });
  expect(db.select().from(modelPricing).get()).toEqual({ ...originalPrice, modelPattern: newId });
  expect(JSON.parse(ChannelService.getChannelRaw(channelId)!.modelMapping)).toEqual({ [newId]: oldId });
  expect(JSON.parse(db.select().from(apiTokens).get()!.allowedModels)).toEqual([newId, 'another-model']);
  expect(db.select().from(tierModelAccess).get()?.modelId).toBe(original.id);
  expect(resolvePublicModelId(oldId)).toBe(newId);
  expect(getModelSpecification(oldId)?.modelId).toBe(newId);
  expect(PricingService.quote(oldId, {}, false).cost).toBe(2.8);
  expect(PricingService.createQuoteResolver(false)(oldId).rate).toBe(2.8);
  expect(PricingService.quote(oldId, {}, false, 1).cost).toBe(2.5);
  sqlite.prepare("UPDATE user_model_access SET access_mode='deny' WHERE user_id=1 AND model_id=?").run(original.id);
  expect(() => assertUserModelAccess(1, oldId)).toThrow('禁止');
  expect(db.select().from(contents).get()).toEqual(history);
  expect(pruneSiYueTianCatalogBindings(sqlite, channelId)).toEqual([]);
  expect((await ChannelService.syncModels(channelId)).models).toEqual([newId]);
  expect(config().modelId).toBe(newId);
  await rename('seedance-second-name', newId);
  expect(resolvePublicModelId(oldId)).toBe('seedance-second-name');
  expect(PricingService.quote(oldId, {}, false).cost).toBe(2.8);
});

it.each(['registry', 'price', 'channel', 'version'])('rejects %s conflicts without moving any configuration', async mode => {
  const original = config();
  if (mode === 'registry') db.insert(models).values({ modelId: newId, displayName: 'occupied', provider: 'other', capabilities: '["video"]' }).run();
  if (mode === 'price') db.insert(modelPricing).values({ modelPattern: newId, billingType: 'per_call', inputPrice: 100 }).run();
  if (mode === 'channel') ChannelService.createChannel({ name: 'other', type: 'custom', baseUrl: 'https://other.example.test', modelMapping: { [newId]: 'foreign' }, supportedModels: [newId] });
  const snapshot = {
    models: db.select().from(models).all(), channels: db.select().from(channels).all(),
    prices: db.select().from(modelPricing).all(), settings: db.select().from(settings).all(),
  };
  await expect(saveSiYueTianModelConfiguration(channelId, { ...draft, modelId: newId }, mode === 'version' ? 'stale-version' : original.version, oldId)).rejects.toMatchObject({ status: 409 });
  expect({ models: db.select().from(models).all(), channels: db.select().from(channels).all(),
    prices: db.select().from(modelPricing).all(), settings: db.select().from(settings).all() }).toEqual(snapshot);
});

it('allows an already captured route after an ID-only change and still rejects actual parameter changes', async () => {
  const target = selectModelRoutes(getModelSpecification(oldId)!, input)[0];
  await rename();
  expect(routeUnavailableReason(oldId, target, input)).toBe('');
  const spec = getModelSpecification(newId)!;
  saveModelSpecification({ ...spec, routes: spec.routes.map(route => ({ ...route, upstreamModel: 'other-upstream' })) });
  expect(routeUnavailableReason(oldId, target, input)).toContain('配置已变更');
});

it('rolls back the entire rename if a later permission update cannot be completed', async () => {
  db.insert(apiTokens).values({ tokenKey: 'malformed-permissions', allowedModels: 'invalid-json' }).run();
  const originalModel = db.select().from(models).all(), originalSettings = db.select().from(settings).all();
  const originalChannel = ChannelService.getChannelRaw(channelId), originalPrice = db.select().from(modelPricing).all();
  await expect(rename()).rejects.toThrow();
  expect(db.select().from(models).all()).toEqual(originalModel);
  expect(db.select().from(settings).all()).toEqual(originalSettings);
  expect(ChannelService.getChannelRaw(channelId)).toEqual(originalChannel);
  expect(db.select().from(modelPricing).all()).toEqual(originalPrice);
});

it('allows one concurrent rename and rejects the stale editor without creating another model', async () => {
  const results = await Promise.allSettled([rename(), rename('another-new-id')]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
  expect(db.select().from(models).all()).toHaveLength(1);
  expect(resolvePublicModelId(oldId)).toBe(config().modelId);
});

it('finishes an in-flight original task through its stored upstream ID after renaming', async () => {
  let releasePost!: (value: Response) => void;
  let reportSubmission!: () => void;
  const submissionStarted = new Promise<void>(resolve => { reportSubmission = resolve; });
  const upstream = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      expect(JSON.parse(String(init.body)).model).toBe(oldId);
      reportSubmission();
      return new Promise<Response>(resolve => { releasePost = resolve; });
    }
    if (url.endsWith('/task_before_rename')) return Response.json({ id: 'task_before_rename', status: 'completed' });
    return catalog(url);
  });
  vi.stubGlobal('fetch', upstream);
  const pending = handleSpecificationGeneration({ userId: 1, headers: {}, protocol: 'https', get: () => 'site.example.test',
    body: { model: oldId, prompt: 'original prompt', video_length: 5, aspect_ratio: '16:9' } } as any, response(), 'video');
  await submissionStarted;
  await rename();
  releasePost(Response.json({ id: 'task_before_rename', status: 'queued' }));
  await pending;
  const history = db.select().from(contents).get()!;
  expect(history).toMatchObject({ modelId: oldId, status: 'completed', cost: 2.8, resultUrl: '/uploads/renamed-video.mp4' });
  expect(JSON.parse(history.metadata).upstreamTaskId).toBe('task_before_rename');
  expect(db.select().from(users).get()?.balance).toBe(97.2);
  resumeSpecificationTasks();
  expect(upstream.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

it('accepts both the old and new IDs for new requests at the migrated price', async () => {
  await rename();
  const upstream = vi.fn(async (_url: string, init?: RequestInit) => Response.json(init?.method === 'POST'
    ? { id: 'task_after_rename' } : { id: 'task_after_rename', status: 'completed' }));
  vi.stubGlobal('fetch', upstream);
  for (const model of [oldId, newId]) {
    await handleSpecificationGeneration({ userId: 1, headers: {}, protocol: 'https', get: () => 'site.example.test',
      body: { model, prompt: 'test', video_length: 5, aspect_ratio: '16:9' } } as any, response(), 'video');
  }
  expect(db.select().from(contents).all()).toEqual([expect.objectContaining({ modelId: newId, status: 'completed', cost: 2.8 }),
    expect.objectContaining({ modelId: newId, status: 'completed', cost: 2.8 })]);
  expect(db.select().from(users).get()?.balance).toBe(94.4);
});

it('refunds a renamed model task only once when the upstream confirms failure', async () => {
  await rename();
  const upstream = vi.fn(async () => Response.json({ id: 'task_rename_failed', status: 'failed', error: { message: '原任务明确失败' } }));
  vi.stubGlobal('fetch', upstream);
  await handleSpecificationGeneration({ userId: 1, headers: {}, protocol: 'https', get: () => 'site.example.test',
    body: { model: oldId, prompt: 'test', video_length: 5, aspect_ratio: '16:9' } } as any, response(), 'video');
  expect(db.select().from(contents).get()).toMatchObject({ modelId: newId, status: 'failed', cost: 0 });
  expect(db.select().from(users).get()?.balance).toBe(100);
  resumeSpecificationTasks(); resumeSpecificationTasks();
  expect(upstream).toHaveBeenCalledOnce();
  expect(db.select().from(users).get()?.balance).toBe(100);
});

it('keeps an unknown original submission on its existing reservation after rename without replaying it', async () => {
  const upstream = vi.fn(async () => Response.json({ status: 'queued' }));
  vi.stubGlobal('fetch', upstream);
  await handleSpecificationGeneration({ userId: 1, headers: {}, protocol: 'https', get: () => 'site.example.test',
    body: { model: oldId, prompt: 'test', video_length: 5, aspect_ratio: '16:9' } } as any, response(), 'video');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => catalog(url)));
  await rename();
  vi.stubGlobal('fetch', upstream);
  resumeSpecificationTasks(); resumeSpecificationTasks();
  expect(upstream).toHaveBeenCalledOnce();
  const row = db.select().from(contents).get()!;
  expect(row.status).toBe('processing');
  expect(JSON.parse(row.metadata)).toMatchObject({ requestedModel: oldId, requiresReview: true, billingStatus: 'review', reservedCost: 2.8 });
  expect(db.select().from(users).get()?.balance).toBe(97.2);
});

it('renames through the administrator API using the original version and ID', async () => {
  const app = express(); app.use(express.json()); app.use('/channels', channelRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as import('node:net').AddressInfo;
  try {
    const url = `http://127.0.0.1:${port}/channels/${channelId}/siyuetian-models`;
    const body = JSON.stringify({ draft: { ...draft, modelId: newId }, version: config().version, originalModelId: oldId });
    expect((await nativeFetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })).status).toBe(401);
    const result = await nativeFetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json',
      Authorization: 'Bearer ' + jwt.sign({ userId: 1 }, env.JWT_SECRET) }, body });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ modelId: newId, editable: true });
    const stale = await nativeFetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json',
      Authorization: 'Bearer ' + jwt.sign({ userId: 1 }, env.JWT_SECRET) }, body });
    expect(stale.status).toBe(409);
    expect(db.select().from(models).all()).toHaveLength(1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
