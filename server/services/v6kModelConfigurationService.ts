import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { channels, models } from '../db/schema.js';
import { defaultRoutingLimits, routingMismatches } from '../../shared/modelRouting.js';
import type { V6kModelConfiguration, V6kModelDraft, V6kRequestSample } from '../../shared/v6kModelConfiguration.js';
import { isRetiredVideoModel } from '../../shared/retiredVideoModels.js';
import { isBbHssKkEntry } from '../../shared/bbHssKk.js';
import { publicApiModelId } from '../../shared/publicApiModelId.js';
import { getModelSpecifications, saveModelSpecification, validateLimits } from './modelRoutingService.js';
import { existingModelLimits } from './modelInputPresets.js';
import { buildZonghengVideoPayload, zonghengBaseUrl, zonghengError } from './zonghengAdapter.js';
import { V6K_CHANNEL_TYPE } from './zonghengProtocol.js';
import { saveV6kManualBinding } from './v6kApprovedBindings.js';

const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });

function getChannel(channelId: number) {
  const channel = db.select().from(channels).where(eq(channels.id, channelId)).get();
  if (!channel || channel.type !== V6K_CHANNEL_TYPE) throw fail('请选择纵横 V6K 渠道', 404);
  return channel;
}

function readConfiguration(channel: ReturnType<typeof getChannel>, modelId: string) {
  const model = db.select().from(models).where(eq(models.modelId, modelId)).get();
  const specs = getModelSpecifications(), spec = specs.find(item => item.modelId === modelId);
  const supported = JSON.parse(channel.supportedModels || '[]') as string[];
  const mapping = JSON.parse(channel.modelMapping || '{}') as Record<string, string>;
  const route = spec?.routes.find(item => item.channelId === channel.id);
  const otherChannel = db.select({ id: channels.id, supported: channels.supportedModels }).from(channels).all()
    .some(row => row.id !== channel.id && (JSON.parse(row.supported || '[]') as string[]).includes(modelId));
  const upstreamModel = route?.upstreamModel ?? (Object.hasOwn(mapping, modelId) ? mapping[modelId] : modelId);
  let reason: string | undefined;
  if (spec?.kkRouting || isBbHssKkEntry(modelId)) reason = '此入口由专用分流或来源设置管理';
  else if (otherChannel || spec && (spec.kind !== 'video' || spec.routes.length > 1 || spec.routes.length === 1 && !route))
    reason = '此入口包含多条线路或属于其他渠道，请保留现有分流配置';
  else if (model && (model.provider !== V6K_CHANNEL_TYPE || !JSON.parse(model.capabilities).includes('video')))
    reason = '该模型 ID 已被其他产品使用';
  else if (specs.some(item => item.aliases.includes(modelId))) reason = '此 ID 是其他入口的兼容别名';
  else if (model && !route && !supported.includes(modelId)) reason = '该模型尚未关联此渠道';
  const version = createHash('sha256').update(JSON.stringify([
    model?.displayName, model?.isActive, model?.id, model?.provider, model?.capabilities, spec,
    channel.updatedAt, supported.includes(modelId), upstreamModel,
  ])).digest('hex');
  const configuration: V6kModelConfiguration = {
    modelId, displayName: model?.displayName ?? '', upstreamModel,
    enabled: spec?.enabled ?? model?.isActive === 1, routeEnabled: route?.enabled ?? true,
    limits: spec?.limits ?? existingModelLimits(modelId, 'video') ?? defaultRoutingLimits(),
    editable: !reason, reason, version,
  };
  return { model, spec, supported, mapping, route, configuration };
}

export function listV6kModelConfigurations(channelId: number) {
  const channel = getChannel(channelId);
  const supported = JSON.parse(channel.supportedModels || '[]') as string[];
  const routes = getModelSpecifications().filter(spec => spec.kind === 'video' && spec.routes.some(route => route.channelId === channel.id));
  const ids = [...new Set([...supported.filter(id => id !== '*'), ...routes.map(spec => spec.modelId)])];
  return ids.map(id => readConfiguration(channel, id).configuration);
}

function checkedDraft(value: V6kModelDraft): V6kModelDraft {
  if (!value || typeof value.modelId !== 'string' || !value.modelId.trim() || value.modelId !== value.modelId.trim() || value.modelId.length > 120
      || typeof value.displayName !== 'string' || !value.displayName.trim() || value.displayName.length > 120
      || typeof value.upstreamModel !== 'string' || !value.upstreamModel.trim() || value.upstreamModel.length > 240
      || typeof value.enabled !== 'boolean' || typeof value.routeEnabled !== 'boolean'
      || /[\x00-\x1f\x7f]/.test(value.upstreamModel) || isRetiredVideoModel(value.modelId) || isRetiredVideoModel(value.upstreamModel))
    throw fail('请填写有效的本站模型 ID、显示名称和可用的上游模型 ID');
  validateLimits(value.limits);
  const { limits } = value, { duration } = limits;
  if (limits.maxOutputs !== 1 || limits.outputsPerTask !== undefined || limits.firstFrame || limits.lastFrame || limits.qualities.length)
    throw fail('V6K 每次生成一条，支持普通参考素材');
  if (![duration.min, duration.max, duration.step, ...duration.values].every(Number.isSafeInteger)
      || (limits.defaultSeconds !== undefined && !Number.isSafeInteger(limits.defaultSeconds))
      || !limits.ratios.every(ratio => /^[1-9][0-9]{0,3}:[1-9][0-9]{0,3}$/.test(ratio))
      || !limits.resolutions.every(resolution => /^[1-9]\d{2,3}p$/i.test(resolution)))
    throw fail('请填写整数秒、像素清晰度和有效宽高比');
  if (limits.maxReferences !== undefined && limits.maxReferences < limits.minImages)
    throw fail('素材合计上限不能小于最少参考图数量');
  return {
    modelId: value.modelId, displayName: value.displayName.trim(), upstreamModel: value.upstreamModel.trim(),
    enabled: value.enabled, routeEnabled: value.routeEnabled,
    limits: { ...limits, resolutions: [...new Set(limits.resolutions.map(r => r.toLowerCase()))], ratios: [...new Set(limits.ratios)] },
  };
}

export function previewV6kModelRequest(channelId: number, draft: V6kModelDraft, sample: V6kRequestSample = {}) {
  getChannel(channelId);
  return buildPreview(checkedDraft(draft), sample);
}

function buildPreview(draft: V6kModelDraft, sample: V6kRequestSample) {
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) throw fail('预览参数格式无效');
  const { limits } = draft;
  const seconds = sample.seconds ?? limits.defaultSeconds ?? (limits.duration.mode === 'options' ? limits.duration.values[0] : limits.duration.min);
  const resolution = sample.resolution ?? limits.resolutions[0], ratio = sample.ratio ?? limits.ratios[0];
  const images = sample.images ?? limits.minImages, videos = sample.videos ?? 0, audios = sample.audios ?? 0;
  if (![images, videos, audios].every(count => Number.isSafeInteger(count) && count >= 0)
    || !Number.isSafeInteger(seconds) || typeof resolution !== 'string' || typeof ratio !== 'string') throw fail('预览参数格式无效');
  const mismatches = routingMismatches(limits, { seconds, resolution, ratio, images, videos, audios,
    outputs: 1, firstFrame: false, lastFrame: false }, 'video');
  if (mismatches.length) throw fail(mismatches.join('，'));
  const urls = (count: number, type: string, extension: string) =>
    Array.from({ length: count }, (_, index) => 'https://example.invalid/' + type + '-' + (index + 1) + '.' + extension);
  try {
    return { method: 'POST', path: '/v1/videos', body: buildZonghengVideoPayload({
      model: draft.upstreamModel, prompt: '请求体预览示例', seconds, ratio, resolution: resolution.toLowerCase(),
      images: urls(images, 'image', 'jpg'), videos: urls(videos, 'video', 'mp4'), audios: urls(audios, 'audio', 'mp3'),
    }) };
  } catch (error) { throw fail((error as Error).message); }
}

export async function saveV6kModelConfiguration(channelId: number, value: V6kModelDraft, version: string | null) {
  const draft = checkedDraft(value), channel = getChannel(channelId);
  const original = readConfiguration(channel, draft.modelId);
  if (!original.configuration.editable) throw fail(original.configuration.reason!, 409);
  if (original.model ? original.configuration.version !== version : version !== null)
    throw fail('模型配置已变化，请重新打开后再保存', 409);
  if (!original.model && (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/.test(draft.modelId)
    || publicApiModelId(draft.modelId) !== draft.modelId || /^(zh-|zongheng-)/i.test(draft.modelId)))
    throw fail('新建本站模型 ID 请使用不带渠道前缀的英文、数字或 . _ / -');

  // Check every configured value against any known adapter limits before writing it.
  const defaults = buildPreview(draft, {}).body;
  const adapterInput = { model: defaults.model, prompt: defaults.prompt, seconds: defaults.seconds, resolution: defaults.resolution,
    ratio: defaults.ratio, images: [], videos: [], audios: [] };
  const rule = draft.limits.duration;
  const durations = rule.mode === 'options' ? rule.values : rule.mode === 'fixed' ? [rule.min]
    : Array.from({ length: Math.floor((rule.max - rule.min) / rule.step) + 1 }, (_, index) => rule.min + index * rule.step);
  try {
    for (const seconds of durations) buildZonghengVideoPayload({ ...adapterInput, seconds });
    for (const resolution of draft.limits.resolutions) buildZonghengVideoPayload({ ...adapterInput, resolution });
    for (const ratio of draft.limits.ratios) buildZonghengVideoPayload({ ...adapterInput, ratio });
    buildZonghengVideoPayload({ ...adapterInput, images: Array(draft.limits.maxImages).fill('image'),
      videos: Array(draft.limits.maxVideos).fill('video'), audios: Array(draft.limits.maxAudios).fill('audio') });
  } catch (error) { throw fail((error as Error).message); }

  if (!channel.apiKey?.trim()) throw fail('此渠道尚未填写 API Key', 409);
  let base: URL;
  try { base = new URL(zonghengBaseUrl(channel.baseUrl)); }
  catch { throw fail('此渠道地址不属于纵横 V6K', 409); }
  if (base.protocol !== 'https:' || !['www.v6k.top', 'v6k.top'].includes(base.host)
      || base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw fail('此渠道地址不属于纵横 V6K', 409);
  let response: Response;
  try {
    response = await fetch(base.origin + '/v1/models', { headers: { Authorization: 'Bearer ' + channel.apiKey, 'Cache-Control': 'no-cache' },
      redirect: 'error', signal: AbortSignal.timeout(20_000) });
  } catch (error) { throw fail('V6K 模型授权查询连接失败（' + (error as Error).name + '）', 502); }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw fail('V6K 模型授权查询 HTTP ' + response.status + '，'
    + (payload ? zonghengError(payload).split(channel.apiKey).join('[密钥已隐藏]') : '上游未返回可读取的错误内容'), 502);
  const items = Array.isArray(payload) ? payload : payload?.data ?? payload?.models;
  if (!Array.isArray(items)) throw fail('V6K 未返回有效模型列表', 502);
  if (!items.some(item => (typeof item === 'string' ? item : item?.id ?? item?.model ?? item?.model_id) === draft.upstreamModel))
    throw fail('当前渠道 Key 的模型列表未返回该上游 ID', 409);

  return sqlite.transaction(() => {
    const live = getChannel(channelId), current = readConfiguration(live, draft.modelId);
    if (live.apiKey !== channel.apiKey || live.baseUrl !== channel.baseUrl
      || live.supportedModels !== channel.supportedModels || live.modelMapping !== channel.modelMapping || !current.configuration.editable
      || current.configuration.version !== original.configuration.version) throw fail('授权查询期间配置已变化，请重新打开后再保存', 409);
    if (current.model) db.update(models).set({ displayName: draft.displayName }).where(eq(models.id, current.model.id)).run();
    else db.insert(models).values({ modelId: draft.modelId, displayName: draft.displayName,
      provider: V6K_CHANNEL_TYPE, capabilities: '["video"]', isActive: 0 }).run();

    saveModelSpecification({ modelId: draft.modelId, kind: 'video', enabled: draft.enabled,
      aliases: current.spec?.aliases ?? [], limits: draft.limits, routes: [{
        id: current.route?.id ?? randomUUID(), channelId, executionModel: draft.modelId, upstreamModel: draft.upstreamModel,
        enabled: draft.routeEnabled, limits: draft.limits,
        cost: current.route?.upstreamModel === draft.upstreamModel ? current.route.cost : null,
        costUnit: current.route?.upstreamModel === draft.upstreamModel ? current.route.costUnit : 'unknown',
        resolutionCosts: current.route?.upstreamModel === draft.upstreamModel ? current.route.resolutionCosts : {},
        priority: current.route?.priority ?? 0,
      }] });
    saveV6kManualBinding(sqlite, { channelId, modelId: draft.modelId, upstreamModel: draft.upstreamModel });
    db.update(channels).set({
      supportedModels: JSON.stringify([...new Set([...current.supported, draft.modelId])]),
      modelMapping: JSON.stringify({ ...current.mapping, [draft.modelId]: draft.upstreamModel }),
      updatedAt: new Date().toISOString(),
    }).where(eq(channels.id, channelId)).run();
    return readConfiguration(getChannel(channelId), draft.modelId).configuration;
  }).immediate();
}
