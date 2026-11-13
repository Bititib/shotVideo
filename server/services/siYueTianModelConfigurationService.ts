import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { channels, models } from '../db/schema.js';
import { defaultRoutingLimits, routingMismatches } from '../../shared/modelRouting.js';
import { isRetiredVideoModel } from '../../shared/retiredVideoModels.js';
import { isSiYueTianVideoHost } from '../../shared/siYueTianMinimax.js';
import { isSiYueTianManagedVideoModel } from '../../shared/siYueTianManagedVideo.js';
import type { V6kModelConfiguration, V6kModelDraft, V6kRequestSample } from '../../shared/v6kModelConfiguration.js';
import { getModelSpecifications, saveModelSpecification, validateLimits } from './modelRoutingService.js';
import { existingModelLimits } from './modelInputPresets.js';
import { rememberPublicModelNames, validatePublicModelName } from './publicModelNameService.js';
import { buildSiYueTianVideoPayload, siYueTianVideoOrigin } from './siYueTianMinimaxAdapter.js';
import { responseDiagnostic, transportDiagnostic, upstreamDiagnostic } from './upstreamDiagnostic.js';

const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });

function getChannel(id: number) {
  const channel = db.select().from(channels).where(eq(channels.id, id)).get();
  if (!channel || channel.type !== 'openai' || !isSiYueTianVideoHost(channel.baseUrl)) throw fail('请选择四月天渠道', 404);
  return channel;
}

function readConfiguration(channel: ReturnType<typeof getChannel>, modelId: string) {
  const model = db.select().from(models).where(eq(models.modelId, modelId)).get();
  const specs = getModelSpecifications(), spec = specs.find(item => item.modelId === modelId);
  const route = spec?.routes.find(item => item.channelId === channel.id && item.executionModel === modelId);
  const supported = JSON.parse(channel.supportedModels || '[]') as string[];
  const mapping = JSON.parse(channel.modelMapping || '{}') as Record<string, string>;
  const otherBinding = db.select().from(channels).all().some(other => other.id !== channel.id
    && (JSON.parse(other.supportedModels || '[]').includes(modelId) || Object.hasOwn(JSON.parse(other.modelMapping || '{}'), modelId)));
  let reason: string | undefined;
  if (isSiYueTianManagedVideoModel(modelId)) reason = '此型号使用已接入的专用规格，可在关联模型中设置售价与开关';
  else if (otherBinding || specs.some(item => item.modelId !== modelId &&
    (item.aliases.includes(modelId) || item.routes.some(itemRoute => itemRoute.executionModel === modelId))))
    reason = '该模型 ID 已被其他渠道或规格使用';
  else if (spec && (spec.routes.length !== 1 || !route?.siYueTianVideo || spec.kind !== 'video')
    || model && (model.provider !== 'siyuetian' || !route || !JSON.parse(model.capabilities).includes('video')))
    reason = '此模型使用已有接入配置';

  const version = createHash('sha256').update(JSON.stringify([channel.updatedAt, supported, mapping, model, spec])).digest('hex');
  const configuration: V6kModelConfiguration = {
    modelId, displayName: model?.displayName ?? '', upstreamModel: route?.upstreamModel ?? mapping[modelId] ?? modelId,
    enabled: spec?.enabled ?? model?.isActive === 1, routeEnabled: route?.enabled ?? true,
    limits: spec?.limits ?? existingModelLimits(modelId, 'video') ?? defaultRoutingLimits(), editable: !reason, reason, version,
  };
  return { model, spec, route, mapping, supported, configuration };
}

export function listSiYueTianModelConfigurations(channelId: number) {
  const channel = getChannel(channelId);
  const linked = new Set<string>(JSON.parse(channel.supportedModels || '[]'));
  const ids = db.select().from(models).all().filter(model => linked.has(model.modelId) && JSON.parse(model.capabilities).includes('video'))
    .map(model => model.modelId);
  for (const spec of getModelSpecifications()) {
    if (spec.kind === 'video' && spec.routes.some(route => route.channelId === channelId)) ids.push(spec.modelId);
  }
  return [...new Set(ids)].map(id => readConfiguration(channel, id).configuration);
}

function originFor(channel: ReturnType<typeof getChannel>) {
  const origin = siYueTianVideoOrigin(channel.baseUrl);
  if (!origin) throw fail('请使用四月天 HTTPS 渠道地址', 409);
  if (!channel.apiKey.trim()) throw fail('请先保存四月天 API Key', 409);
  return origin;
}

async function readCatalog(url: string, stage: string, key?: string) {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'Cache-Control': 'no-cache', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
  } catch (error) { throw fail(transportDiagnostic('四月天', stage, error, key), 502); }
  if (!response.ok) throw fail(await responseDiagnostic('四月天', stage, response, key), 502);
  const payload = await response.json().catch(() => null);
  if (!payload || payload.error || payload.success === false)
    throw fail(upstreamDiagnostic('四月天', stage, payload, key, response.status), 502);
  return payload;
}

export async function listSiYueTianVideoCatalog(channelId: number): Promise<{ id: string }[]> {
  const channel = getChannel(channelId);
  const origin = originFor(channel);
  const [access, catalog] = await Promise.all([
    readCatalog(origin + '/v1/models', '查询 Key 已授权模型', channel.apiKey),
    readCatalog(origin + '/api/pricing', '读取模型接口目录'),
  ]);
  const available = Array.isArray(access) ? access : access.data ?? access.models;
  const endpoint = catalog.supported_endpoint?.['openai-video'];
  if (!Array.isArray(available) || !Array.isArray(catalog.data) || endpoint?.path !== '/v1/videos' || endpoint?.method !== 'POST')
    throw fail('四月天目录未返回可验证的异步视频接口和模型列表', 502);
  const authorized = new Set(available.map((item: any) => typeof item === 'string' ? item : item?.id));
  return [...new Set<string>(catalog.data.filter((item: any) => typeof item?.model_name === 'string'
    && Array.isArray(item.supported_endpoint_types) && item.supported_endpoint_types.includes('openai-video') && authorized.has(item.model_name))
    .map((item: any) => item.model_name))].sort().map(id => ({ id }));
}

function checkedDraft(value: V6kModelDraft): V6kModelDraft {
  if (!value || typeof value.modelId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/.test(value.modelId)
    || /^(siyuetian-|chre3-)/i.test(value.modelId) || typeof value.displayName !== 'string' || !value.displayName.trim()
    || value.displayName.length > 120 || typeof value.upstreamModel !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,239}$/.test(value.upstreamModel.trim())
    || typeof value.enabled !== 'boolean' || typeof value.routeEnabled !== 'boolean'
    || isRetiredVideoModel(value.modelId) || isRetiredVideoModel(value.upstreamModel.trim()))
    throw fail('请填写有效的本站模型 ID、显示名称和上游模型 ID');
  const { limits } = value;
  validateLimits(limits);
  const { duration } = limits;
  if (limits.maxOutputs !== 1 || limits.outputsPerTask !== undefined || limits.qualities.length
    || limits.resolutions.length !== 1 || !/^(?:[1-9]\d{2,3}p|[1248]k)$/i.test(limits.resolutions[0])
    || !limits.ratios.length || !limits.ratios.every(ratio => ratio === 'adaptive' || /^[1-9]\d{0,3}:[1-9]\d{0,3}$/.test(ratio))
    || ![duration.min, duration.max, duration.step, ...duration.values, limits.defaultSeconds ?? 1].every(Number.isSafeInteger)
    || limits.maxReferences !== undefined && limits.maxReferences < limits.minImages)
    throw fail('四月天异步视频需填写单一输出分辨率、整数秒、有效画幅和素材上限');
  return { modelId: value.modelId, displayName: value.displayName.trim(), upstreamModel: value.upstreamModel.trim(),
    enabled: value.enabled, routeEnabled: value.routeEnabled, limits };
}

export function previewSiYueTianModelRequest(channelId: number, value: V6kModelDraft, sample: V6kRequestSample = {}) {
  getChannel(channelId);
  const draft = checkedDraft(value), { limits } = draft;
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) throw fail('预览参数无效');
  const seconds = sample.seconds ?? limits.defaultSeconds ?? (limits.duration.mode === 'options' ? limits.duration.values[0] : limits.duration.min);
  const images = sample.images ?? limits.minImages, videos = sample.videos ?? 0, audios = sample.audios ?? 0;
  const resolution = sample.resolution ?? limits.resolutions[0], ratio = sample.ratio ?? limits.ratios[0];
  if (![images, videos, audios].every(count => Number.isSafeInteger(count) && count >= 0)
    || !Number.isSafeInteger(seconds) || typeof resolution !== 'string' || typeof ratio !== 'string') throw fail('预览参数无效');
  const input = { seconds, resolution, ratio, images, videos, audios, outputs: 1, firstFrame: false, lastFrame: false };
  const mismatches = routingMismatches(limits, input, 'video');
  if (mismatches.length) throw fail(mismatches.join('，'));
  const urls = (count: number, ext: string) => Array.from({ length: count }, (_, index) => `https://example.invalid/${index + 1}.${ext}`);
  return { method: 'POST', path: '/v1/videos', body: buildSiYueTianVideoPayload({
    input, prompt: '请求体预览示例', images: urls(images, 'jpg'), videos: urls(videos, 'mp4'),
    audios: urls(audios, 'mp3'), firstFrame: '', lastFrame: '', body: {}, publicBaseUrl: 'https://example.invalid',
  }, url => url, draft.upstreamModel) };
}

export async function saveSiYueTianModelConfiguration(channelId: number, value: V6kModelDraft, version: string | null) {
  const draft = checkedDraft(value);
  const channel = getChannel(channelId), original = readConfiguration(channel, draft.modelId);
  if (!original.configuration.editable) throw fail(original.configuration.reason!, 409);
  if (version !== (original.model ? original.configuration.version : null)) throw fail('模型配置已变化，请重新打开后保存', 409);
  const catalog = await listSiYueTianVideoCatalog(channelId);
  if (!catalog.some(item => item.id === draft.upstreamModel)) throw fail('此 Key 的目录中没有支持四月天异步视频协议的该型号', 409);

  return sqlite.transaction(() => {
    const live = getChannel(channelId), current = readConfiguration(live, draft.modelId);
    if (live.apiKey !== channel.apiKey || live.baseUrl !== channel.baseUrl || !current.configuration.editable
      || current.configuration.version !== original.configuration.version) throw fail('授权查询期间配置已变化，请重新打开后保存', 409);
    validatePublicModelName(draft.modelId, draft.displayName, current.model?.id);
    if (!current.model) db.insert(models).values({
      modelId: draft.modelId, displayName: draft.displayName, provider: 'siyuetian', capabilities: '["video"]', isActive: 0,
    }).run();
    else if (current.model.displayName !== draft.displayName) {
      rememberPublicModelNames(current.model);
      db.update(models).set({ displayName: draft.displayName }).where(eq(models.id, current.model.id)).run();
    }
    const originalCost = current.route?.upstreamModel === draft.upstreamModel ? current.route : undefined;
    saveModelSpecification({
      modelId: draft.modelId, kind: 'video', enabled: draft.enabled, limits: draft.limits, aliases: current.spec?.aliases ?? [],
      routes: [{
        id: current.route?.id ?? randomUUID(), channelId, executionModel: draft.modelId, upstreamModel: draft.upstreamModel,
        siYueTianVideo: true, enabled: draft.routeEnabled, limits: draft.limits, priority: current.route?.priority ?? 0,
        cost: originalCost?.cost ?? null, costUnit: originalCost?.costUnit ?? 'unknown', resolutionCosts: originalCost?.resolutionCosts ?? {},
      }],
    });
    db.update(channels).set({
      supportedModels: JSON.stringify([...new Set([...current.supported, draft.modelId])]),
      modelMapping: JSON.stringify({ ...current.mapping, [draft.modelId]: draft.upstreamModel }),
      updatedAt: new Date().toISOString(),
    }).where(eq(channels.id, channelId)).run();
    return readConfiguration(getChannel(channelId), draft.modelId).configuration;
  }).immediate();
}
