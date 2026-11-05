import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { modelExample } from '../client/src/utils/apiModelExamples.js';
import { ZHIYING_BASE_URL, ZHIYING_VIDEO_MODELS, validateZhiyingVideoInput, zhiyingVideoSpec } from '../shared/zhiyingVideo.js';
import { sqlite } from '../server/db/index.js';
import { ensureUserModelTables } from '../server/db/userModelMigration.js';
import { ChannelService } from '../server/services/channelService.js';
import { getModelSpecification, saveModelSpecification, selectModelRoutes } from '../server/services/modelRoutingService.js';
import { quoteVideoRequest } from '../server/services/videoQuoteService.js';
import { getEnabledPublicModels } from '../server/services/modelCatalogService.js';
import { resolveApiModelId } from '../server/services/publicModelNameService.js';
import { recordPublicModelReview } from '../server/services/publicModelMetadataService.js';
import { getPublicDeveloperModels, getStandardDeveloperModels } from '../server/services/developerModelService.js';
import { TokenService } from '../server/services/tokenService.js';

vi.mock('../server/db/index.js', async () => {
  const { createMemoryDatabase } = await import('./helpers/memoryDatabase.js');
  return createMemoryDatabase();
});

const [line1, line2] = ZHIYING_VIDEO_MODELS;
const excluded = 'SD-特价';
const key = 'test-catalog-secret';
const request = { images: 0, videos: 0, audios: 0, outputs: 1, seconds: 30, resolution: '720p',
  ratio: '16:9', firstFrame: false, lastFrame: false };
const catalog = (ids: readonly string[] = ZHIYING_VIDEO_MODELS) =>
  ({ object: 'list', data: ids.map(id => ({ id, status: 'available', media_type: 'video' })) });
let channelId: number;
let fetchPage = vi.fn<typeof fetch>();
const localFetch = globalThis.fetch;

beforeAll(() => ensureUserModelTables(sqlite));
beforeEach(() => {
  sqlite.exec('SAVEPOINT zhiying_catalog_test');
  channelId = ChannelService.createChannel({ name: '智赢', type: 'zhiying', baseUrl: ZHIYING_BASE_URL + '/v1/', apiKey: key, maxRetries: 5 });
  fetchPage = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(catalog()));
  vi.stubGlobal('fetch', fetchPage);
});
afterEach(() => {
  sqlite.exec('ROLLBACK TO zhiying_catalog_test; RELEASE zhiying_catalog_test');
  vi.unstubAllGlobals();
});

describe('智赢渠道目录', () => {
  it('tests credentials with GET only, then registers just the two supported models disabled', async () => {
    fetchPage.mockImplementation(async () => Response.json(catalog([...ZHIYING_VIDEO_MODELS, excluded, 'wan3.0', 'nano-banana-2.1'])));
    expect(await ChannelService.testChannel(channelId)).toMatchObject({ success: true });
    expect(sqlite.prepare('SELECT count(*) n FROM models').get()).toEqual({ n: 0 });
    const result = await ChannelService.syncModels(channelId);
    expect(result).toEqual({ count: 2, added: 2, models: [...ZHIYING_VIDEO_MODELS] });
    expect(sqlite.prepare('SELECT model_id FROM models ORDER BY model_id').all())
      .toEqual([{model_id:line1}, {model_id:line2}]);
    for (const [url, init] of fetchPage.mock.calls) {
      expect(url).toBe(ZHIYING_BASE_URL + '/v1/models');
      expect(init?.method || 'GET').toBe('GET');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ' + key);
    }
    expect(getEnabledPublicModels('video')).toEqual([]);
    expect(ChannelService.getChannelRaw(channelId)).toMatchObject({ baseUrl: ZHIYING_BASE_URL, maxRetries: 0 });
    expect(sqlite.prepare('SELECT count(*) n FROM model_pricing').get()).toEqual({ n: 0 });
    for (const id of ZHIYING_VIDEO_MODELS) {
      const { limits, displayName } = zhiyingVideoSpec(id);
      expect(resolveApiModelId(displayName)).toBe(id);
      expect(getModelSpecification(id)).toMatchObject({ limits, routes: [{ upstreamModel: id, executionModel: id, costUnit: 'unknown', cost: null, limits }] });
    }
  });

  it('requires explicit sale pricing before quote and preserves the configured sale and switches across syncs', async () => {
    await ChannelService.syncModels(channelId);
    sqlite.prepare('UPDATE models SET is_active=1,display_name=? WHERE model_id=?').run('运营专线一', line1);
    sqlite.prepare('INSERT INTO model_pricing(model_pattern,billing_type,input_price) VALUES(?,?,?)').run('*', 'per_call', 0);
    const quote = () => quoteVideoRequest({ model: line1, resolution: '720p', video_length: 30 });
    expect(quote).toThrow(/尚未配置/);
    expect(getEnabledPublicModels('video').some(m => m.modelId === line1)).toBe(false);
    sqlite.prepare('INSERT INTO model_pricing(model_pattern,billing_type,input_price) VALUES(?,?,?)').run(line1, 'per_call', 3.9);
    const spec = getModelSpecification(line1)!;
    spec.routes[0].enabled = false;
    saveModelSpecification(spec);
    expect((await ChannelService.syncModels(channelId)).added).toBe(0);
    expect(resolveApiModelId('运营专线一')).toBe(line1);
    expect(resolveApiModelId('Lx-Seedance2.5-1')).toBe(line1);
    expect(getEnabledPublicModels('video')).toEqual([
      expect.objectContaining({ modelId:line1, displayName:'Lx-Seedance2.5-1' }),
    ]);
    expect(quote()).toMatchObject({ model: line1, cost: 3.9, billingType: 'per_call' });
    expect(getModelSpecification(line1)?.routes).toEqual(spec.routes);
  });

  it('rolls back catalog, mappings and specifications on a public name conflict', async () => {
    sqlite.prepare("INSERT INTO models(provider,model_id,display_name,capabilities) VALUES('other',?,?,'[\"video\"]')")
      .run('existing-product', zhiyingVideoSpec(line2).displayName);
    await expect(ChannelService.syncModels(channelId)).rejects.toThrow(/已被其他模型/);
    expect(getModelSpecification(line1)).toBeUndefined();
    expect(ChannelService.getChannelRaw(channelId)?.modelMapping).toBe('{}');
    expect(sqlite.prepare('SELECT count(*) n FROM models').get()).toEqual({ n: 1 });
  });

  it('matches explicit per-user pricing without removing unpriced models of existing channels', async () => {
    await ChannelService.syncModels(channelId);
    sqlite.prepare('UPDATE models SET is_active=1 WHERE model_id=?').run(line1);
    sqlite.prepare("INSERT INTO models(provider,model_id,display_name,capabilities,is_active) VALUES('other','other-id','Other','[\"video\"]',1)").run();
    sqlite.prepare("INSERT INTO users(id,email,username,password_hash) VALUES(7,'test@example.invalid','test','hash')").run();
    sqlite.prepare("INSERT INTO user_model_pricing(user_id,model_id,billing_type,input_price,output_price,updated_by) SELECT 7,id,'per_call',0,0,7 FROM models WHERE model_id=?").run(line1);
    expect(getEnabledPublicModels('video').map(m => m.modelId)).toEqual(['other-id']);
    expect(getEnabledPublicModels('video', 7).map(m => m.modelId)).toEqual([line1, 'other-id']);
    expect(quoteVideoRequest({ model: line1, resolution: '720p', video_length: 30 }, 7)).toMatchObject({ cost: 0, billingType: 'per_call' });
    sqlite.prepare("UPDATE user_model_pricing SET billing_type='per_token' WHERE user_id=7").run();
    expect(getEnabledPublicModels('video', 7).map(m => m.modelId)).toEqual(['other-id']);
    expect(() => quoteVideoRequest({ model: line1, resolution: '720p', video_length: 30 }, 7)).toThrow(/售价/);
  });

  it('preserves unrelated bindings and withdraws only new routing to an unavailable model, keeping its original mapping', async () => {
    ChannelService.updateChannel(channelId, { supportedModels: ['manual'], modelMapping: { manual: 'unrelated' } });
    await ChannelService.syncModels(channelId);
    sqlite.prepare('UPDATE models SET is_active=1 WHERE model_id=?').run(line1);
    expect(selectModelRoutes(getModelSpecification(line1)!, request)).toHaveLength(1);
    fetchPage.mockImplementation(async () => Response.json({ ...catalog([line2, excluded]), unavailable: [{ id: line1 }] }));
    expect((await ChannelService.syncModels(channelId)).models).toEqual([line2]);
    const saved = ChannelService.getChannelRaw(channelId)!;
    expect(JSON.parse(saved.modelMapping)).toMatchObject({ manual: 'unrelated', [line1]: line1 });
    expect(JSON.parse(saved.supportedModels)).toEqual(['manual', line2]);
    expect(selectModelRoutes(getModelSpecification(line1)!, request)).toEqual([]);
    expect(ChannelService.findChannelsForModel('manual')).toEqual([]);
  });

  it('writes the confirmed line even if the other line has an inconsistent catalog entry, and restores it on a later sync', async () => {
    const inconsistent = catalog();
    inconsistent.data[1].status = 'unavailable';
    fetchPage.mockImplementationOnce(async () => Response.json(inconsistent, { headers: { 'x-request-id': 'req-line2' } }));

    const partial = await ChannelService.syncModels(channelId);
    expect(partial).toMatchObject({ count: 1, added: 1, models: [line1] });
    expect(partial.warnings?.join(' ')).toContain(`${line2} data 返回 media_type="video"、status="unavailable"`);
    expect(partial.warnings?.join(' ')).toContain('req-line2');
    expect(JSON.parse(ChannelService.getChannelRaw(channelId)!.modelMapping)).toEqual({ [line1]: line1 });
    expect(getModelSpecification(line2)).toBeUndefined();

    const complete = catalog();
    complete.data.push({ ...complete.data[1] });
    fetchPage.mockImplementationOnce(async () => Response.json(complete));
    expect(await ChannelService.syncModels(channelId)).toEqual({ count: 2, added: 1, models: [line1, line2] });
    expect(JSON.parse(ChannelService.getChannelRaw(channelId)!.modelMapping)).toEqual({ [line1]: line1, [line2]: line2 });
    expect(getModelSpecification(line2)?.routes[0].upstreamModel).toBe(line2);
  });

  it('blocks only the line present in both lists and accepts a documented video in data with no explicit status', async () => {
    fetchPage.mockImplementationOnce(async () => Response.json({
      data: [{ id: line1, media_type: 'video' }, ...catalog([line2]).data],
      unavailable: [{ id: line2 }],
    }));
    const result = await ChannelService.syncModels(channelId);
    expect(result.models).toEqual([line1]);
    expect(result.warnings?.join(' ')).toContain(`${line2} 同时出现在 data 和 unavailable`);
  });

  it('does not take over the public ID for a historical prefixed model', async () => {
    sqlite.prepare("INSERT INTO models(provider,model_id,display_name,capabilities) VALUES('funai',?,?,'[\"video\"]')")
      .run('funai-' + line2, '既有产品');
    expect(resolveApiModelId(line2)).toBe('funai-' + line2);
    await expect(ChannelService.syncModels(channelId)).rejects.toThrow(/别名或规格/);
    expect(resolveApiModelId(line2)).toBe('funai-' + line2);
    expect(getModelSpecification(line1)).toBeUndefined();
  });

  it('keeps the previous catalog on malformed data, a concurrent key edit or an upstream error', async () => {
    await ChannelService.syncModels(channelId);
    const before = ChannelService.getChannelRaw(channelId)!;
    fetchPage.mockImplementationOnce(async () => Response.json({ object: 'list' }));
    await expect(ChannelService.syncModels(channelId)).rejects.toThrow(/缺少 data/);
    fetchPage.mockImplementationOnce(async () => Response.json({ error: { code: 'invalid_api_key',
      message: 'Bad credential ' + key, type: 'auth', request_id: 'req-17' } }, { status: 401 }));
    const tested = await ChannelService.testChannel(channelId);
    expect(tested).toMatchObject({ success: false });
    expect(tested.message).toContain('invalid_api_key');
    expect(tested.message).toContain('req-17');
    expect(tested.message).not.toContain(key);
    fetchPage.mockImplementationOnce(async () => {
      ChannelService.updateChannel(channelId, { apiKey: 'replaced-key' });
      return Response.json(catalog([]));
    });
    await expect(ChannelService.syncModels(channelId)).rejects.toThrow(/配置已变更/);
    expect(ChannelService.getChannelRaw(channelId)).toMatchObject({ modelMapping: before.modelMapping, supportedModels: before.supportedModels });
  });

  it('uses each upstream model’s own prompt, resolution, ratio and media caps', () => {
    expect(validateZhiyingVideoInput(line1, '海', { ...request, resolution: '1080p', videos: 11 })).toEqual(expect.arrayContaining(['视频最多 10 个', '分辨率不匹配']));
    expect(validateZhiyingVideoInput(line1, '海'.repeat(20001), { ...request, ratio: '4:3' })).toEqual([expect.stringContaining('20000')]);
    expect(validateZhiyingVideoInput(line2, '海'.repeat(45000), { ...request, images: 30, videos: 10, audios: 10 })).toEqual([]);
    expect(validateZhiyingVideoInput(line2, '海', { ...request, ratio: '4:3' })).toEqual(['宽高比不匹配']);
  });

  it('publishes the sale ID, public limits and website task handle across the actual discovery and query endpoints', async () => {
    await ChannelService.syncModels(channelId);
    sqlite.prepare('UPDATE models SET is_active=1 WHERE model_id=?').run(line1);
    const row = sqlite.prepare('SELECT id FROM models WHERE model_id=?').get(line1) as { id: number };
    recordPublicModelReview(row.id, true);
    const upstreamId = 'zy-task-private-123';
    const token = { id: 17, userId: null, allowedModels: [] };
    const metadata = { zhiyingOrder: true, videoId: upstreamId, actualChannel: 'zhiying',
      tokenId: token.id, progressText: '智赢 QUERY_17 task_id=' + upstreamId, error: 'QUERY_17 task_id=' + upstreamId, upstreamStatus: 'failed' };
    const { lastInsertRowid } = sqlite.prepare('INSERT INTO contents(user_id,type,model_id,status,metadata) VALUES(1,?,?,?,?)')
      .run('video', line1, 'failed', JSON.stringify(metadata));
    const keySpy = vi.spyOn(TokenService, 'validateToken').mockReturnValue({ valid: true, token } as any);
    const app = express();
    let server: Server | undefined;
    try {
      app.use('/api/video', (await import('../server/routes/video.js')).default);
      app.use('/v1', (await import('../server/routes/v1.js')).default);
      server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
      const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
      const read = async (path: string) => {
        const response = await localFetch(origin + path, path.startsWith('/v1') ? { headers: { Authorization: 'Bearer local-key' } } : {});
        expect(response.status).toBe(200);
        return response.json();
      };
      sqlite.prepare('INSERT INTO model_pricing(model_pattern,billing_type,input_price) VALUES(?,?,?)').run('*', 'per_call', 0);
      expect(await read('/api/video/models')).not.toContainEqual(expect.objectContaining({ id: line1 }));
      expect((await read('/v1/models')).data).not.toContainEqual(expect.objectContaining({ id: 'Lx-Seedance2.5-1' }));
      expect(getPublicDeveloperModels().items).not.toContainEqual(expect.objectContaining({ id: 'Lx-Seedance2.5-1' }));
      sqlite.prepare('INSERT INTO model_pricing(model_pattern,billing_type,input_price) VALUES(?,?,?)').run(line1, 'per_second', 0.07);
      const publicId = 'Lx-Seedance2.5-1';
      const publicModel = getPublicDeveloperModels().items.find(item => item.id === publicId);
      expect(publicModel).toMatchObject({ name: 'Lx-Seedance2.5-1', pricing: null });
      const model = getStandardDeveloperModels().items.find(item => item.id === publicId)!;
      expect(model).toMatchObject({ name: publicId, canonicalId: publicId, limits: { maxImages: 30, defaultSeconds: 30 },
        pricing: { billing_type: 'per_second', unit_price: 0.07 } });
      expect(modelExample(model, '/v1/videos', 'https://platform.example', 'curl')).toContain(`"model": "${publicId}"`);
      const site = await read('/api/video/models'), api = await read('/v1/models');
      expect(site).toEqual(expect.arrayContaining([expect.objectContaining({ id: line1, name: 'Lx-Seedance2.5-1' })]));
      expect(api.data).toContainEqual(expect.objectContaining({ id: publicId, name: publicId, canonical_id: publicId }));
      expect(api.data).not.toContainEqual(expect.objectContaining({ id: line1 }));
      const price = { model: publicId, display_name: publicId, canonical_id: publicId, unit_price: 0.07 };
      expect((await read('/v1/pricing')).data).toContainEqual(expect.objectContaining(price));
      expect(await read('/v1/pricing/' + publicId)).toMatchObject(price);
      expect(await read('/v1/pricing/' + line1)).toMatchObject(price);
      const task = await read('/v1/videos/task_' + lastInsertRowid);
      expect(task).toMatchObject({ id: 'task_' + lastInsertRowid, status: 'failed', model: publicId });
      expect(task.error_message).toContain('QUERY_17');
      expect(JSON.stringify([site, api, task, model])).not.toMatch(/zhiying|智赢|zy-task-private|upstream_task_id|test-catalog-secret/);
    } finally {
      keySpy.mockRestore();
      if (server) {
        server.closeAllConnections();
        await new Promise<void>(resolve => server!.close(() => resolve()));
      }
    }
  });
});
