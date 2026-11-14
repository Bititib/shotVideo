import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { CHANNEL_MODEL_ROUTE_PREFIX, STANDARD_CHANNEL_IMAGE_RATIOS, STANDARD_CHANNEL_VIDEO_RATIOS,
  type ChannelModelConfigurations, type ChannelModelDraft } from '../../shared/channelModelConfiguration.js';
import type { ModelRoute } from '../../shared/modelRouting.js';
import { isRetiredVideoModel, RETIRED_VIDEO_MODEL_MESSAGE } from '../../shared/retiredVideoModels.js';
import { isSupportedChannelType } from '../../shared/channelTypes.js';
import { db, sqlite } from '../db/index.js';
import { channels, models } from '../db/schema.js';
import { allowsStandardChannelModelConfiguration } from './channelCatalogBindings.js';
import { getModelSpecifications, saveModelSpecification, validateLimits } from './modelRoutingService.js';
import { existingModelLimits } from './modelInputPresets.js';
import { rememberPublicModelNames, resolvePublicModelId, validatePublicModelName } from './publicModelNameService.js';
import { diagnosticJson, responseDiagnostic, transportDiagnostic, upstreamDiagnostic } from './upstreamDiagnostic.js';

type Channel = typeof channels.$inferSelect;
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
const modelIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/;

function getChannel(id: number) {
  const channel = db.select().from(channels).where(eq(channels.id, id)).get();
  if (!channel) throw fail('渠道不存在', 404);
  return channel;
}

function readConfiguration(channel: Channel) {
  const specs = getModelSpecifications();
  const savedModels = new Map(db.select().from(models).all().map(model => [model.modelId, model]));
  const supported = JSON.parse(channel.supportedModels || '[]') as string[];
  const mapping = JSON.parse(channel.modelMapping || '{}') as Record<string, string>;
  const linkedSpecs = specs.filter(spec => spec.routes.some(route => route.channelId === channel.id));
  const ids = new Set([...supported, ...Object.keys(mapping), ...linkedSpecs.map(spec => spec.modelId)]);
  const canAdd = allowsStandardChannelModelConfiguration(sqlite, channel);
  const rows = [...ids].filter(id => id !== '*' && !isRetiredVideoModel(id)).map(modelId => {
    const model = savedModels.get(modelId);
    const spec = linkedSpecs.find(row => row.modelId === modelId);
    const routes = spec?.routes.filter(route => route.channelId === channel.id) ?? [];
    const capabilities: string[] = JSON.parse(model?.capabilities || '[]');
    const kind = capabilities.includes('video') ? 'video' : capabilities.some(capability => ['image', 'image_gen'].includes(capability)) ? 'image' : null;
    const editable = Boolean(canAdd && model && spec?.routes.length === 1 && routes[0]?.id.startsWith(CHANNEL_MODEL_ROUTE_PREFIX)
      && routes[0].executionModel === modelId);
    return {
      modelId, displayName: model?.displayName || modelId,
      upstreamModel: [...new Set(routes.map(route => route.upstreamModel))].join('、')
        || (Object.hasOwn(mapping, modelId) ? mapping[modelId] : modelId),
      capabilities, enabled: model?.isActive === 1 && spec?.enabled !== false,
      limits: spec?.limits ?? (kind ? existingModelLimits(modelId, kind) : null), editable,
    };
  });
  const version = createHash('sha256').update(JSON.stringify([
    channel.id, channel.updatedAt, channel.baseUrl, channel.type, supported, mapping, rows, linkedSpecs,
  ])).digest('hex');
  const canSync = isSupportedChannelType(channel.type);
  const result: ChannelModelConfigurations = { models: rows, version, canAdd, canSync };
  if (!canAdd) result.addUnavailableReason = canSync
    ? '此渠道使用专用协议。可同步已接入的型号并查看参数，新协议型号需完成适配后才能添加。'
    : '当前版本未接入此渠道类型的生成协议。可以查看已有配置。';
  return { result, specs, savedModels, supported, mapping };
}

export function listChannelModelConfigurations(channelId: number) {
  return readConfiguration(getChannel(channelId)).result;
}

async function fetchCatalog(channel: Channel) {
  if (!channel.apiKey.trim()) throw fail('请先在渠道配置中保存 API Key', 409);
  const url = channel.baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '') + '/v1/models';
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: 'Bearer ' + channel.apiKey, 'Cache-Control': 'no-cache' },
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
  } catch (error) { throw fail(transportDiagnostic(channel.type, '读取模型授权目录', error, channel.apiKey), 502); }
  if (!response.ok) throw fail(await responseDiagnostic(channel.type, '读取模型授权目录', response, channel.apiKey), 502);
  const payload = await diagnosticJson(channel.type, '读取模型授权目录', response, channel.apiKey);
  if (payload?.error) throw fail(upstreamDiagnostic(channel.type, '读取模型授权目录', payload, channel.apiKey, response.status), 502);
  const entries = Array.isArray(payload) ? payload : payload?.data ?? payload?.models;
  if (!Array.isArray(entries)) throw fail('上游未返回可识别的授权模型目录', 502);
  return [...new Set<string>(entries.map((row: any) => typeof row === 'string' ? row : row?.id ?? row?.model ?? row?.model_id)
    .filter((id: unknown): id is string => typeof id === 'string' && Boolean(id.trim())))].sort();
}

export function listAuthorizedChannelModels(channelId: number) {
  const channel = getChannel(channelId);
  if (!allowsStandardChannelModelConfiguration(sqlite, channel)) throw fail('请使用该渠道的专用同步或配置入口', 409);
  return fetchCatalog(channel);
}

function validateDraft(draft: ChannelModelDraft) {
  if (!draft || typeof draft.modelId !== 'string' || !modelIdPattern.test(draft.modelId)
    || typeof draft.displayName !== 'string' || !draft.displayName.trim() || draft.displayName.length > 120
    || typeof draft.upstreamModel !== 'string' || !draft.upstreamModel.trim()
    || draft.upstreamModel !== draft.upstreamModel.trim() || draft.upstreamModel.length > 160 || draft.upstreamModel === '*'
    || !['image', 'video'].includes(draft.kind)) throw fail('请填写有效的本站模型 ID、名称和上游型号');
  if (isRetiredVideoModel(draft.modelId) || isRetiredVideoModel(draft.upstreamModel)) throw fail(RETIRED_VIDEO_MODEL_MESSAGE, 409);
  validateLimits(draft.limits);
  if (draft.limits.maxVideos || draft.limits.maxAudios || draft.limits.firstFrame || draft.limits.lastFrame) {
    throw fail('通用配置只支持参考图，音视频参考和首尾帧需使用对应渠道的专用配置');
  }
  const ratios: readonly string[] = draft.kind === 'image' ? STANDARD_CHANNEL_IMAGE_RATIOS : STANDARD_CHANNEL_VIDEO_RATIOS;
  if (draft.limits.ratios.some(ratio => !ratios.includes(ratio))) throw fail('通用接口支持的比例为 ' + ratios.join('、'));
  if (draft.kind === 'image' && (draft.limits.resolutions.length !== 1 || draft.limits.resolutions[0] !== '1K')) {
    throw fail('通用图片接口仅支持 1K。其他分辨率需使用对应渠道的专用配置。');
  }
}

export async function saveChannelModelConfiguration(channelId: number, draft: ChannelModelDraft, version: string) {
  validateDraft(draft);
  const channel = getChannel(channelId);
  const original = readConfiguration(channel);
  const assertVersion = (current: typeof original) => {
    if (!current.result.canAdd) throw fail(current.result.addUnavailableReason!, 409);
    if (current.result.version !== version) throw fail('渠道模型配置已变化，请重新打开后保存', 409);
    const existing = current.result.models.find(row => row.modelId === draft.modelId);
    if (existing && (!existing.editable || !existing.capabilities.includes(draft.kind))) throw fail('此模型使用已有接入配置，不能通过通用入口更换协议或能力', 409);
    const occupied = current.savedModels.get(draft.modelId);
    if (!existing && (occupied || current.specs.some(spec => spec.modelId === draft.modelId
      || spec.aliases.includes(draft.modelId) || spec.routes.some(route => route.executionModel === draft.modelId))
      || resolvePublicModelId(draft.modelId) !== draft.modelId
      || db.select().from(channels).all().some(other => other.id !== channelId
        && (JSON.parse(other.supportedModels || '[]').includes(draft.modelId)
          || Object.hasOwn(JSON.parse(other.modelMapping || '{}'), draft.modelId))))) {
      throw fail('本站模型 ID 已被其他模型或渠道占用', 409);
    }
    validatePublicModelName(draft.modelId, draft.displayName.trim(), occupied?.id);
    return occupied;
  };
  assertVersion(original);
  const authorized = await fetchCatalog(channel);
  if (!authorized.includes(draft.upstreamModel)) throw fail('该上游型号未出现在此 Key 的授权目录中', 409);

  return sqlite.transaction(() => {
    const live = getChannel(channelId);
    if (live.apiKey !== channel.apiKey) throw fail('核对授权期间渠道 Key 已修改，请重新打开后保存', 409);
    const current = readConfiguration(live);
    const model = assertVersion(current);
    if (!model) db.insert(models).values({
      provider: live.type, modelId: draft.modelId, displayName: draft.displayName.trim(),
      capabilities: JSON.stringify([draft.kind]), isActive: 0,
    }).run();
    else if (model.displayName !== draft.displayName.trim()) {
      rememberPublicModelNames(model);
      db.update(models).set({ displayName: draft.displayName.trim() }).where(eq(models.id, model.id)).run();
    }
    const spec = current.specs.find(row => row.modelId === draft.modelId);
    const originalRoute = spec?.routes[0];
    const cost = originalRoute?.upstreamModel === draft.upstreamModel ? originalRoute : undefined;
    const route: ModelRoute = {
      id: originalRoute?.id ?? CHANNEL_MODEL_ROUTE_PREFIX + randomUUID(), channelId, executionModel: draft.modelId,
      upstreamModel: draft.upstreamModel, enabled: originalRoute?.enabled ?? true, limits: draft.limits,
      cost: cost?.cost ?? null, costUnit: cost?.costUnit ?? 'unknown',
      resolutionCosts: cost?.resolutionCosts ?? {}, priority: originalRoute?.priority ?? live.priority,
    };
    saveModelSpecification({
      modelId: draft.modelId, kind: draft.kind, enabled: spec?.enabled ?? true,
      aliases: spec?.aliases ?? [], limits: draft.limits, routes: [route],
    });
    db.update(channels).set({
      supportedModels: JSON.stringify([...new Set([...current.supported, draft.modelId])]),
      modelMapping: JSON.stringify({ ...current.mapping, [draft.modelId]: draft.upstreamModel }),
      updatedAt: new Date().toISOString(),
    }).where(eq(channels.id, channelId)).run();
    return readConfiguration(getChannel(channelId)).result;
  }).immediate();
}
