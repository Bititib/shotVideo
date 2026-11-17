import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sqlite } from '../server/db/index.js';
import { ChannelService } from '../server/services/channelService.js';
import { getModelSpecification, selectModelRoutes } from '../server/services/modelRoutingService.js';
import { listZhiyingCatalogOptions, listZhiyingModelConfigurations, previewZhiyingModelRequest, saveZhiyingModelConfiguration } from '../server/services/zhiyingModelConfigurationService.js';
import { getEnabledPublicModels } from '../server/services/modelCatalogService.js';
import { zhiyingBindings } from '../server/services/zhiyingModelBindings.js';
import { manualCatalogRow, manualDraft, manualId, manualUpstream, installManualZhiying } from './helpers/zhiyingManualModel.js';
import { documentedZhiyingRows } from './helpers/zhiyingDocumentedModels.js';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());

let channelId: number, catalog: any, wire: ReturnType<typeof vi.fn>;
beforeEach(() => {
  sqlite.exec('SAVEPOINT manual_zhiying');
  channelId = ChannelService.createChannel({ name: '智赢', type: 'zhiying', baseUrl: 'https://zhiyingai.xyz', apiKey: 'test-secret' });
  catalog = { data: [structuredClone(manualCatalogRow)] };
  wire = vi.fn(async () => Response.json(catalog)); vi.stubGlobal('fetch', wire);
});
afterEach(() => { vi.unstubAllGlobals(); sqlite.exec('ROLLBACK TO manual_zhiying; RELEASE manual_zhiying'); });
const input = { images: 0, videos: 0, audios: 0, outputs: 1, seconds: 5, resolution: '720p', ratio: '16:9', firstFrame: false, lastFrame: false };

it.each(documentedZhiyingRows)('registers documented $id without an endpoint field, preserving its own limits and upstream mapping', async row => {
  catalog = { data: [{ ...row, create_endpoint: undefined }] };
  const result = await listZhiyingCatalogOptions(channelId);
  expect(result.options[0].reason).toBeUndefined();
  const profile = result.options[0].profile!;
  const draft = { modelId: 'Lx-Test', upstreamModel: row.id, limits: profile.limits, enabled: true, routeEnabled: true };
  expect(profile.limits.maxImages).toBe(row.reference_limits.images);
  expect(profile.limits.maxVideos).toBe(row.reference_limits.videos);
  expect(profile.limits.maxAudios).toBe(row.reference_limits.audios);
  expect(profile.limits.defaultSeconds).toBe(row.default_duration);
  expect(profile.limits.resolutions).toEqual(expect.arrayContaining(Object.keys(row.resolutions)));
  expect(await previewZhiyingModelRequest(channelId, draft)).toMatchObject({ path: '/v1/generations', body: { model: row.id, duration: row.default_duration } });
  await saveZhiyingModelConfiguration(channelId, draft, null);
  expect(zhiyingBindings(sqlite)[0]).toMatchObject({ upstreamModel: row.id, profile });
  expect(sqlite.prepare('SELECT display_name,is_active FROM models WHERE model_id=?').get(draft.modelId)).toEqual({ display_name: draft.modelId, is_active: 0 });
  expect((await ChannelService.syncModels(channelId)).models).toContain(draft.modelId);
  expect(JSON.parse(ChannelService.getChannelRaw(channelId)!.modelMapping)[draft.modelId]).toBe(row.id);
});

it('does not use known-model exceptions to override a different explicit endpoint or authorize an unknown ID', async () => {
  const rows = [...documentedZhiyingRows, { ...manualCatalogRow, id: 'seedance-2.5-official' }, manualCatalogRow];
  catalog = { data: rows.map(row => ({ ...row, create_endpoint: '/v2/jobs' })) };
  expect((await listZhiyingCatalogOptions(channelId)).options.every(row => !row.profile && row.reason?.includes('协议'))).toBe(true);
  catalog = { data: [{ ...documentedZhiyingRows[0], id: 'unknown-dedicated', create_endpoint: undefined }] };
  expect((await listZhiyingCatalogOptions(channelId)).options[0].profile).toBeUndefined();
});

it('accepts zero byte limits only for unsupported media and rejects unsupported discount capabilities', async () => {
  const row = documentedZhiyingRows.find(row => row.id === 'seedance-2.5-discount')!;
  for (const change of [
    { reference_file_max_bytes: { image: 0, video: 0, audio: 0 } },
    { reference_limits: { images: 9, videos: 1, audios: 0 } },
    { reference_file_max_bytes: { image: 31457280, video: -1, audio: 0 } },
  ]) {
    catalog = { data: [{ ...row, ...change }] };
    expect((await listZhiyingCatalogOptions(channelId)).options[0].profile).toBeUndefined();
  }
});

it('filters unrelated images and unopened products from a mixed catalog without warning or changing configured routes', async () => {
  await installManualZhiying(channelId);
  const before = listZhiyingModelConfigurations(channelId);
  catalog = { data: [manualCatalogRow, { id: 'gpt-image-2-line1', media_type: 'image', status: 'available' }],
    unavailable: [{ id: 'minimax-h3' }, { id: 'seedance-2.0' }] };
  const result = await listZhiyingCatalogOptions(channelId);
  expect(result.options.map(row => row.id)).toEqual([manualUpstream]);
  expect(result.options[0].profile).toBeDefined();
  expect(result.warnings).toEqual([]);
  const sync = await ChannelService.syncModels(channelId);
  expect(sync.models).toContain(manualId);
  expect(sync.warnings ?? []).toEqual([]);
  expect(listZhiyingModelConfigurations(channelId)[0].limits).toEqual(before[0].limits);
  expect(wire.mock.calls.every(([, init]: any) => !init.method || init.method === 'GET')).toBe(true);
});

it.each([
  { data: [{ ...manualCatalogRow, media_type: 'image' }], unavailable: [] },
  { data: [manualCatalogRow], unavailable: [{ id: manualUpstream }] },
  { data: [], unavailable: [{ id: manualUpstream }] },
])('retains actionable diagnostics for a configured model even when it changes type or availability %#', async value => {
  await installManualZhiying(channelId);
  catalog = value;
  const result = await listZhiyingCatalogOptions(channelId);
  expect(result.options).toEqual([]);
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toContain(manualUpstream);
  const sync = await ChannelService.syncModels(channelId);
  expect(sync.models).not.toContain(manualId);
  expect(sync.warnings?.join(' ')).toContain(manualUpstream);
  expect(zhiyingBindings(sqlite)[0].upstreamModel).toBe(manualUpstream);
  await expect(saveZhiyingModelConfiguration(channelId, { ...manualDraft(), modelId: 'Lx-Unavailable' }, null)).rejects.toThrow();
});

it('previews without generating, saves the public name and real mapping disabled, then preserves pricing and switches on sync', async () => {
  expect(await previewZhiyingModelRequest(channelId, manualDraft())).toMatchObject({ path: '/v1/generations', body: { model: manualUpstream, duration: 5 } });
  const saved = await installManualZhiying(channelId);
  expect(saved).toMatchObject({ modelId: manualId, upstreamModel: manualUpstream, editable: true });
  expect(sqlite.prepare('SELECT display_name,is_active FROM models WHERE model_id=?').get(manualId)).toEqual({ display_name: manualId, is_active: 0 });
  expect(getEnabledPublicModels('video')).toEqual([]);
  sqlite.prepare('UPDATE models SET is_active=1 WHERE model_id=?').run(manualId);
  expect(getEnabledPublicModels('video')).toEqual([]);
  sqlite.prepare("INSERT INTO model_pricing(model_pattern,billing_type,input_price) VALUES(?,'per_call',2)").run(manualId);
  expect(getEnabledPublicModels('video')[0]).toMatchObject({ modelId: manualId, displayName: manualId });
  expect(selectModelRoutes(getModelSpecification(manualId)!, input)[0].route).toMatchObject({ executionModel: manualId, upstreamModel: manualUpstream });
  await saveZhiyingModelConfiguration(channelId, { ...manualDraft(), routeEnabled: false }, listZhiyingModelConfigurations(channelId)[0].version);
  await ChannelService.syncModels(channelId);
  expect(getModelSpecification(manualId)?.routes[0].enabled).toBe(false);
  expect(JSON.parse(ChannelService.getChannelRaw(channelId)!.modelMapping)[manualId]).toBe(manualUpstream);
  expect(sqlite.prepare('SELECT input_price FROM model_pricing WHERE model_pattern=?').get(manualId)).toEqual({ input_price: 2 });
  expect(sqlite.prepare('SELECT is_active FROM models WHERE model_id=?').get(manualId)).toEqual({ is_active: 1 });
  for (const [url, init] of wire.mock.calls as any[]) { expect(url).toBe('https://zhiyingai.xyz/v1/models'); expect(init.method || 'GET').toBe('GET'); }
});
it('withdraws unavailable models without deleting their approved mapping, then restores new routing on recovery', async () => {
  await installManualZhiying(channelId);
  catalog = { data: [], unavailable: [{ id: manualUpstream }] };
  expect((await ChannelService.syncModels(channelId)).models).not.toContain(manualId);
  expect(zhiyingBindings(sqlite)[0].upstreamModel).toBe(manualUpstream);
  expect(getModelSpecification(manualId)?.routes[0].upstreamModel).toBe(manualUpstream);
  catalog = { data: [manualCatalogRow] };
  expect((await ChannelService.syncModels(channelId)).models).toContain(manualId);
  expect(listZhiyingModelConfigurations(channelId)[0].upstreamModel).toBe(manualUpstream);
});
it('requires review after upstream limits shrink, without rewriting saved limits or pricing', async () => {
  await installManualZhiying(channelId);
  catalog.data[0].reference_limits.videos = 3;
  const result = await ChannelService.syncModels(channelId);
  expect(result.models).not.toContain(manualId); expect(result.warnings?.join(' ')).toContain('参数已变化');
  expect(getModelSpecification(manualId)?.limits.maxVideos).toBe(30);
});
it.each([
  { data: [] }, { data: [{ ...manualCatalogRow, status: 'unavailable' }] },
  { data: [{ ...manualCatalogRow, media_type: 'image' }] }, { data: [manualCatalogRow], unavailable: [{ id: manualUpstream }] },
  { data: [manualCatalogRow, manualCatalogRow] },
])('never registers unconfirmed or ambiguous authorization %#', async value => {
  catalog = value;
  await expect(installManualZhiying(channelId)).rejects.toThrow();
  expect(getModelSpecification(manualId)).toBeUndefined(); expect(zhiyingBindings(sqlite)).toEqual([]);
});
it('reports unknown contracts and mismatched resolution-duration combinations as unavailable for configuration', async () => {
  catalog = { data: [{ ...manualCatalogRow, id: 'future-video', create_endpoint: '/v2/jobs' },
    { ...manualCatalogRow, id: 'unequal-durations', resolutions: { '720p': { durations: [5] }, '1080p': { durations: [10] } } }] };
  const result = await listZhiyingCatalogOptions(channelId);
  expect(result.options).toHaveLength(2); expect(result.options.every(row => row.reason && !row.profile)).toBe(true);
});
it('rejects exceeding provider limits, naming conflicts and stale saves atomically', async () => {
  const draft = manualDraft();
  await expect(saveZhiyingModelConfiguration(channelId, { ...draft, limits: { ...draft.limits, maxVideos: 31 } }, null)).rejects.toThrow(/上游/);
  await expect(saveZhiyingModelConfiguration(channelId, { ...draft, modelId: '中文' }, null)).rejects.toThrow(/Lx-/);
  sqlite.prepare("INSERT INTO models(provider,model_id,display_name,capabilities) VALUES('other','other',?,'[\"video\"]')").run(manualId);
  await expect(installManualZhiying(channelId)).rejects.toThrow(/占用|其他模型/);
  expect(zhiyingBindings(sqlite)).toEqual([]);
  sqlite.prepare("DELETE FROM models WHERE model_id='other'").run();
  const saved = await installManualZhiying(channelId);
  await saveZhiyingModelConfiguration(channelId, { ...draft, enabled: false }, saved.version);
  await expect(saveZhiyingModelConfiguration(channelId, draft, saved.version)).rejects.toThrow(/变化/);
  expect(getModelSpecification(manualId)?.enabled).toBe(false);
});
it('rejects a credential change during authorization without writing models or mappings', async () => {
  wire.mockImplementationOnce(async () => { sqlite.prepare('UPDATE channels SET api_key=? WHERE id=?').run('changed-secret', channelId); return Response.json(catalog); });
  await expect(installManualZhiying(channelId)).rejects.toThrow(/变化/);
  expect(zhiyingBindings(sqlite)).toEqual([]); expect(getModelSpecification(manualId)).toBeUndefined();
});

it('preserves a manual draft validation failure without creating a model or overwriting existing configuration when DNS is down', async () => {
  await installManualZhiying(channelId);
  const original = listZhiyingModelConfigurations(channelId)[0];
  const before = ChannelService.getChannelRaw(channelId)!;
  wire.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND zhiyingai.xyz' } }));
  await expect(saveZhiyingModelConfiguration(channelId, { ...manualDraft(), modelId: 'Lx-Manual' }, null)).rejects.toThrow(/ENOTFOUND/);
  await expect(saveZhiyingModelConfiguration(channelId, { ...manualDraft(), upstreamModel: 'manual-upstream' }, original.version)).rejects.toThrow(/ENOTFOUND/);
  expect(listZhiyingModelConfigurations(channelId)).toEqual([original]);
  expect(ChannelService.getChannelRaw(channelId)!.modelMapping).toBe(before.modelMapping);
  expect(sqlite.prepare('SELECT model_id FROM models WHERE model_id=?').get('Lx-Manual')).toBeUndefined();
});
