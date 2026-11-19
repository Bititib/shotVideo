import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { ChannelModelDraft } from '../shared/channelModelConfiguration.js';
import { defaultRoutingLimits } from '../shared/modelRouting.js';
import { db, sqlite } from '../server/db/index.js';
import { channels, contents, models, modelPricing, users } from '../server/db/schema.js';
import { env } from '../server/config/env.js';
import channelRoutes from '../server/routes/channels.js';
import apiRoutes from '../server/routes/v1.js';
import videoRoutes from '../server/routes/video.js';
import { ChannelService } from '../server/services/channelService.js';
import { TokenService } from '../server/services/tokenService.js';
import { listChannelModelConfigurations, previewChannelModelRequest, saveChannelModelConfiguration } from '../server/services/channelModelConfigurationService.js';
import { pruneChannelCatalogBindings } from '../server/services/channelCatalogBindings.js';
import { getModelSpecification, routeUnavailableReason, selectModelRoutes } from '../server/services/modelRoutingService.js';
import { generateSpecificationImage, submitSpecificationVideo } from '../server/services/specificationAdapters.js';
import { handleSpecificationGeneration } from '../server/services/specificationGenerationService.js';

vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/services/videoLocalizationService.js', () => ({ downloadAndLocalizeVideo: vi.fn(async () => '/uploads/channel-config-result.mp4') }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => sqlite.close());

function addChannel(name: string, baseUrl = 'https://catalog.example.test', type = 'openai') {
  return Number(db.insert(channels).values({ name, type, baseUrl, apiKey: 'test-channel-key', status: 1 }).run().lastInsertRowid);
}

const makeDraft = (modelId: string, kind: ChannelModelDraft['kind'] = 'video'): ChannelModelDraft => ({
  modelId, kind, displayName: modelId, upstreamModel: 'actual-provider-model',
  limits: { ...defaultRoutingLimits(), resolutions: kind === 'image' ? ['1K'] : ['720p'], ratios: ['1:1'] },
});

it('snumom: administrator adds a disabled same-protocol model; edits and sync preserve prices, balances and bindings', async()=>{
  const id=addChannel('snumom configurable','https://snumom.com','snumom');
  const draft={...makeDraft('configurable-snumom-video'),upstreamModel:'configurable-snumom-video',snumom:{billingType:'per_second' as const,referenceVideoBilling:true}};
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({data:[{id:draft.modelId,type:'video'}]})));
  const beforePrices=db.select().from(modelPricing).all(),beforeUsers=db.select().from(users).all();
  const saved=await saveChannelModelConfiguration(id,draft,listChannelModelConfigurations(id).version);
  expect(saved.canAdd).toBe(true);
  expect(saved.models).toContainEqual(expect.objectContaining({modelId:draft.modelId,enabled:false,editable:true,snumom:draft.snumom}));
  const preview=previewChannelModelRequest(id,draft,{seconds:10});
  expect(preview).toMatchObject({method:'POST',path:'/v1/videos',body:{model:draft.modelId,seconds:'10',size:'720P'}});
  await ChannelService.syncModels(id);
  expect(getModelSpecification(draft.modelId)?.routes[0].snumom).toEqual(draft.snumom);
  const current=listChannelModelConfigurations(id);
  await saveChannelModelConfiguration(id,{...draft,limits:{...draft.limits,maxImages:8}},current.version);
  expect(db.select().from(modelPricing).all()).toEqual(beforePrices);
  expect(db.select().from(users).all()).toEqual(beforeUsers);
  await expect(saveChannelModelConfiguration(id,{...draft,snumom:{billingType:'per_call',referenceVideoBilling:true}},listChannelModelConfigurations(id).version)).rejects.toThrow('参考视频计费');
  await expect(saveChannelModelConfiguration(id,draft,saved.version)).rejects.toThrow('配置已变化');
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

it.each([
  { name: 'MJNewAPI', protocol: 'mjnewapi', baseUrl: 'https://mjnewapi.diwdiw.cn', model: 'mj-custom-seedance', fields: ['images', 'videos', 'audios'] },
  { name: 'NewToken', protocol: 'newtoken', baseUrl: 'https://newtoken.club/v1', model: 'nd-seedance-variant', fields: ['image_refs', 'video_refs', 'audio_refs'] },
])('registers a new $name model and uses its actual submission protocol', async ({ name, protocol, baseUrl, model, fields }) => {
  const id = addChannel(name, baseUrl);
  const draft = { ...makeDraft(model), upstreamModel: model, routeEnabled: false,
    limits: { ...makeDraft(model).limits, ratios: ['16:9'], maxImages: 2, maxVideos: 1, maxAudios: 1 } };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ data: [{ id: model }, { id: 'other-seedance' }, { id: 'some-chat' }] }));
  vi.stubGlobal('fetch', fetcher);
  const first = listChannelModelConfigurations(id);
  expect(first).toMatchObject({ protocol, canAdd: true });
  const preview = previewChannelModelRequest(id, draft, { seconds: 5, images: 1, videos: 1, audios: 1 });
  expect(preview).toMatchObject({ path: '/v1/videos', body: { model, duration: 5, aspect_ratio: '16:9' } });
  expect(fetcher).not.toHaveBeenCalled();
  const saved = await saveChannelModelConfiguration(id, draft, first.version);
  expect(saved.models).toEqual([expect.objectContaining({ modelId: model, enabled: false, routeEnabled: false })]);
  expect(pruneChannelCatalogBindings(sqlite, ChannelService.getChannelRaw(id)!)).toEqual([]);
  await expect(ChannelService.syncModels(id)).resolves.toMatchObject({ models: [model], added: 0 });
  expect(getModelSpecification('other-seedance')).toBeUndefined();
  await saveChannelModelConfiguration(id, { ...draft, routeEnabled: true }, listChannelModelConfigurations(id).version);
  db.update(models).set({ isActive: 1 }).where(eq(models.modelId, model)).run();
  const input = request('720p');
  const [target] = selectModelRoutes(getModelSpecification(model)!, { ...input.input, ratio: '16:9' });
  fetcher.mockImplementationOnce(async () => Response.json({ task_id: 'channel-new-task' }));
  await expect(submitSpecificationVideo(target, {
    ...input, input: { ...input.input, ratio: '16:9', images: 1, videos: 1, audios: 1 },
    images: ['https://example.invalid/jpg-1.jpg'], videos: ['https://example.invalid/mp4-1.mp4'], audios: ['https://example.invalid/wav-1.wav'],
  }, vi.fn())).resolves.toBe('channel-new-task');
  const [url, options] = fetcher.mock.calls.at(-1)!;
  const body = JSON.parse(String(options?.body));
  expect(url).toBe(baseUrl.replace(/\/v1$/, '') + preview.path);
  expect(fields.map(field => body[field])).toEqual(fields.map(field => preview.body[field]));
  expect(body.model).toBe(model);
  db.insert(modelPricing).values({ modelPattern: model, billingType: 'per_call', inputPrice: 2 }).run();
  const userId = Number(db.insert(users).values({ username: protocol, email: protocol + '@site.example', passwordHash: 'unused', balance: 10 }).run().lastInsertRowid);
  fetcher.mockImplementation(async (_url, init) => Response.json(init?.method === 'POST' ? { task_id: protocol + '-website' }
    : { status: 'completed', video_url: 'https://example.invalid/finished.mp4' }));
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn() };
  await handleSpecificationGeneration({ userId, headers: {}, protocol: 'https', get: () => 'site.example',
    body: { model, prompt: 'website test', video_length: 5, aspect_ratio: '16:9' } } as any, res as any, 'video');
  expect(db.select().from(contents).where(eq(contents.modelId, model)).get()).toMatchObject({ status: 'completed', cost: 2 });
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

it('saves a disabled model through the admin route and describes its configured limits once enabled', async () => {
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
  app.use('/api/video', videoRoutes);
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
    const preview = await localFetch(url + '/preview', {
      method: 'POST', headers: { Authorization: admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ draft }),
    });
    expect(await preview.json()).toMatchObject({ path: '/v1/videos', body: { model: draft.upstreamModel, resolution_name: '720p' } });
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

    async function listedModel() {
      const response = await localFetch(origin + '/api/video/models');
      expect(response.status).toBe(200);
      return (await response.json() as { id: string; description: string }[]).find(model => model.id === draft.modelId);
    }
    expect(await listedModel()).toBeUndefined();
    db.update(models).set({ isActive: 1 }).where(eq(models.modelId, draft.modelId)).run();
    expect((await listedModel())?.description).toBe('720p · 4–30 秒 · 画幅 1:1');

    const current = listChannelModelConfigurations(channelId);
    const updated = await localFetch(url, {
      method: 'PUT', headers: { Authorization: admin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: current.version, draft: { ...draft, limits: { ...draft.limits,
        ratios: ['16:9', '9:16'], resolutions: ['720p', '1080p'], maxImages: 3,
        duration: { mode: 'options', min: 5, max: 15, step: 1, values: [5, 10, 15] },
      } } }),
    });
    expect(updated.status).toBe(200);
    db.update(models).set({ description: 'AI 视频生成服务' }).where(eq(models.modelId, draft.modelId)).run();
    expect((await listedModel())?.description).toBe('720p / 1080p · 5 / 10 / 15 秒 · 画幅 16:9 / 9:16 · 参考最多 3 图');

    db.update(models).set({ description: '管理员填写的模型说明' }).where(eq(models.modelId, draft.modelId)).run();
    expect((await listedModel())?.description).toBe('管理员填写的模型说明');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
