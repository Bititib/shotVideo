import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { ChannelModelDraft } from '../shared/channelModelConfiguration.js';
import { defaultRoutingLimits } from '../shared/modelRouting.js';
import { db, sqlite } from '../server/db/index.js';
import { channels, models, modelPricing, users } from '../server/db/schema.js';
import { env } from '../server/config/env.js';
import channelRoutes from '../server/routes/channels.js';
import apiRoutes from '../server/routes/v1.js';
import { ChannelService } from '../server/services/channelService.js';
import { TokenService } from '../server/services/tokenService.js';
import { listChannelModelConfigurations, saveChannelModelConfiguration } from '../server/services/channelModelConfigurationService.js';
import { getModelSpecification, routeUnavailableReason, selectModelRoutes } from '../server/services/modelRoutingService.js';
import { generateSpecificationImage, submitSpecificationVideo } from '../server/services/specificationAdapters.js';

vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => sqlite.close());

function addChannel(name: string, baseUrl = 'https://catalog.example.test', type = 'openai') {
  return Number(db.insert(channels).values({ name, type, baseUrl, apiKey: 'test-channel-key', status: 1 }).run().lastInsertRowid);
}

const makeDraft = (modelId: string, kind: ChannelModelDraft['kind'] = 'video'): ChannelModelDraft => ({
  modelId, kind, displayName: modelId, upstreamModel: 'actual-provider-model',
  limits: { ...defaultRoutingLimits(), resolutions: kind === 'image' ? ['1K'] : ['720p'], ratios: ['1:1'] },
});
const request = (resolution: string) => ({
  prompt: 'test', images: [], videos: [], audios: [], firstFrame: '', lastFrame: '', body: {}, publicBaseUrl: 'https://site.example.test',
  input: { images: 0, videos: 0, audios: 0, outputs: 1, seconds: 5, resolution, ratio: '1:1', firstFrame: false, lastFrame: false },
});

it('retains a manually added video through sync and submits its authorized mapping using standard video form data', async () => {
  const id = addChannel('标准视频线路', 'https://catalog.example.test/v1/');
  const draft = makeDraft('seedance-manual-test');
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ data: [
    { id: draft.upstreamModel, type: 'video' }, { id: 'unconfigured-video', type: 'video' },
  ] }));
  vi.stubGlobal('fetch', fetcher);
  const first = listChannelModelConfigurations(id);
  const added = await saveChannelModelConfiguration(id, draft, first.version);
  expect(added.models).toEqual([expect.objectContaining({ modelId: draft.modelId, enabled: false, editable: true })]);
  const spec = getModelSpecification(draft.modelId)!;
  expect(selectModelRoutes(spec, request('720p').input)).toEqual([]);
  await expect(saveChannelModelConfiguration(id, draft, first.version)).rejects.toMatchObject({ status: 409 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1]?.method).toBeUndefined();

  await expect(ChannelService.syncModels(id)).resolves.toMatchObject({ models: [draft.modelId], added: 0 });
  expect(fetcher.mock.calls.slice(0, 2).map(([url]) => url)).toEqual([
    'https://catalog.example.test/v1/models', 'https://catalog.example.test/v1/models',
  ]);
  expect(db.select().from(models).where(eq(models.modelId, 'unconfigured-video')).get()).toBeUndefined();
  db.update(models).set({ isActive: 1 }).where(eq(models.modelId, draft.modelId)).run();
  db.insert(modelPricing).values({ modelPattern: draft.modelId, billingType: 'per_call', inputPrice: 2 }).run();
  const input = request('720p');
  const [target] = selectModelRoutes(spec, input.input);
  expect(target.channel.id).toBe(id);
  const starting = vi.fn();
  fetcher.mockImplementationOnce(async () => Response.json({ id: 'task-test' }));
  await expect(submitSpecificationVideo(target, input, starting)).resolves.toBe('task-test');
  const [url, options] = fetcher.mock.calls.at(-1)!;
  expect(url).toBe('https://catalog.example.test/v1/videos');
  expect(options?.body).toBeInstanceOf(FormData);
  expect((options?.body as FormData).get('model')).toBe(draft.upstreamModel);
  expect(starting).toHaveBeenCalled();
  expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern, draft.modelId)).get()?.inputPrice).toBe(2);

  ChannelService.updateChannel(id, { modelMapping: { [draft.modelId]: 'other-upstream' } });
  expect(selectModelRoutes(spec, input.input)).toEqual([]);
  expect(routeUnavailableReason(draft.modelId, target, input.input)).toContain('映射已变更');
});

it('uses image generation rather than chat for a standard image mapping with a Banana-style ID', async () => {
  const id = addChannel('标准图片线路');
  const draft = makeDraft('banana-manual-test', 'image');
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ data: [{ id: draft.upstreamModel }] }));
  vi.stubGlobal('fetch', fetcher);
  await saveChannelModelConfiguration(id, draft, listChannelModelConfigurations(id).version);
  db.update(models).set({ isActive: 1 }).where(eq(models.modelId, draft.modelId)).run();
  const input = request('1K');
  const [target] = selectModelRoutes(getModelSpecification(draft.modelId)!, input.input);
  fetcher.mockImplementationOnce(async () => Response.json({ data: [{ url: 'https://result.example.test/image.png' }] }));
  await expect(generateSpecificationImage(target, input, vi.fn(), vi.fn())).resolves.toMatchObject({
    imageUrl: 'https://result.example.test/image.png',
  });
  const [url, options] = fetcher.mock.calls.at(-1)!;
  expect(url).toBe('https://catalog.example.test/v1/images/generations');
  expect(JSON.parse(String(options?.body))).toMatchObject({ model: draft.upstreamModel, size: '1024x1024' });
});

it('exposes fixed and removed channels for inspection and rejects unsupported additions without making a request', async () => {
  const fixed = addChannel('Pidoi 图片渠道', 'https://pidoi.com');
  const removed = addChannel('已停用旧渠道', 'https://removed.example.test', 'apipath');
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  for (const [id, canSync] of [[fixed, true], [removed, false]] as const) {
    const current = listChannelModelConfigurations(id);
    expect(current).toMatchObject({ canAdd: false, canSync });
    await expect(saveChannelModelConfiguration(id, makeDraft('unverified-model'), current.version)).rejects.toMatchObject({ status: 409 });
  }
  expect(fetcher).not.toHaveBeenCalled();
  expect(getModelSpecification('unverified-model')).toBeUndefined();
});

it('does not create a model or mapping when the key has no authorization or changes during the check', async () => {
  const id = addChannel('授权校验线路');
  const draft = makeDraft('private-test-model');
  const version = listChannelModelConfigurations(id).version;
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => Response.json({ data: [] }))
    .mockImplementationOnce(async () => {
      ChannelService.updateChannel(id, { apiKey: 'new-key' });
      return Response.json({ data: [{ id: draft.upstreamModel }] });
    });
  vi.stubGlobal('fetch', fetcher);
  await expect(saveChannelModelConfiguration(id, draft, version)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('授权目录') });
  await expect(saveChannelModelConfiguration(id, draft, version)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Key 已修改') });
  expect(getModelSpecification(draft.modelId)).toBeUndefined();
  expect(listChannelModelConfigurations(id).models).toEqual([]);
});

it('exposes the channel config API only to administrators and saves a disabled model through the real route', async () => {
  const channelId = addChannel('后台接口线路');
  const createUser = (role: string) => Number(db.insert(users).values({
    username: role, email: role + '@example.test', role, passwordHash: 'unused',
  }).run().lastInsertRowid);
  const auth = (id: number) => 'Bearer ' + jwt.sign({ userId: id }, env.JWT_SECRET);
  const admin = auth(createUser('super_admin'));
  const member = auth(createUser('user'));
  const draft = makeDraft('admin-route-model');
  const app = express();
  app.use(express.json());
  app.use('/api/admin/channels', channelRoutes);
  app.use('/v1', apiRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address() as import('node:net').AddressInfo;
  const origin = 'http://127.0.0.1:' + address.port;
  const url = origin + '/api/admin/channels/' + channelId + '/model-configurations';
  const localFetch = globalThis.fetch;
  const upstream = vi.fn().mockImplementation(async () => Response.json({ data: [{ id: draft.upstreamModel }] }));
  vi.stubGlobal('fetch', upstream);
  try {
    expect((await localFetch(url)).status).toBe(401);
    const initial = await localFetch(url, { headers: { Authorization: admin } });
    expect(initial.status).toBe(200);
    const configuration = await initial.json() as { version: string };
    expect(JSON.stringify(configuration)).not.toContain('test-channel-key');
    const put = (Authorization: string) => localFetch(url, {
      method: 'PUT', headers: { Authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft, version: configuration.version }),
    });
    expect((await put(member)).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    const saved = await put(admin);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ models: [{ modelId: draft.modelId, enabled: false }] });

    vi.spyOn(TokenService, 'validateToken').mockReturnValue({ valid: true, token: { id: 1, allowedModels: [], balance: 10 } });
    const post = (path: string, body: object) => localFetch(origin + '/v1/' + path, {
      method: 'POST', headers: { Authorization: 'Bearer api-test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: draft.modelId, ...body }),
    });
    expect((await post('videos', { prompt: 'test' })).status).toBe(404);
    expect((await post('chat/completions', { messages: [{ role: 'user', content: 'test' }] })).status).toBe(400);
    expect(upstream).toHaveBeenCalledOnce();
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
