import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { channels, models } from '../db/schema.js';
import { allowsDuration, type ModelInputLimits } from '../../shared/modelRouting.js';
import { isZhiyingVideoModel } from '../../shared/zhiyingVideo.js';
import type { ZhiyingCatalogOption, ZhiyingModelConfiguration, ZhiyingModelDraft } from '../../shared/zhiyingModelConfiguration.js';
import { fetchZhiyingVideoModels } from './zhiyingCatalogService.js';
import { zhiyingCatalogProfile } from './zhiyingCatalogProfile.js';
import { getModelSpecification, getModelSpecifications, saveModelSpecification, validateLimits } from './modelRoutingService.js';
import { resolveApiModelId, validatePublicModelName } from './publicModelNameService.js';
import { saveZhiyingBinding, zhiyingBindings } from './zhiyingModelBindings.js';

const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
function getChannel(id: number) {
  const channel = db.select().from(channels).where(eq(channels.id, id)).get();
  if (!channel || channel.type !== 'zhiying') throw fail('请选择智赢渠道', 404);
  return channel;
}
function configuration(channel: ReturnType<typeof getChannel>, modelId: string) {
  const model = db.select().from(models).where(eq(models.modelId, modelId)).get();
  const spec = getModelSpecification(modelId), route = spec?.routes.find(r => r.channelId === channel.id);
  const binding = zhiyingBindings(sqlite).find(row => row.channelId === channel.id && row.modelId === modelId);
  const reason = isZhiyingVideoModel(modelId) ? '原有两条专线由同步管理，请在关联模型中配置售价和开关'
    : model && (model.provider !== 'zhiying' || !binding || !route || spec?.routes.length !== 1) ? '此模型包含其他关联，请保留原配置' : undefined;
  const version = createHash('sha256').update(JSON.stringify([channel.updatedAt, channel.supportedModels, channel.modelMapping, model, spec, binding])).digest('hex');
  return { model, spec, route, binding, version, reason };
}
export function listZhiyingModelConfigurations(channelId: number): ZhiyingModelConfiguration[] {
  const channel = getChannel(channelId);
  return getModelSpecifications().filter(spec => spec.routes.some(r => r.channelId === channelId)).map(spec => {
    const current = configuration(channel, spec.modelId), route = current.route!;
    return { modelId: spec.modelId, upstreamModel: route.upstreamModel, limits: spec.limits,
      enabled: spec.enabled, routeEnabled: route.enabled, version: current.version, editable: !current.reason, reason: current.reason };
  });
}
export async function listZhiyingCatalogOptions(channelId: number): Promise<{ options: ZhiyingCatalogOption[]; warnings: string[] }> {
  const channel = getChannel(channelId);
  if (!channel.apiKey?.trim()) throw fail('请先保存智赢 API Key');
  const catalog = await fetchZhiyingVideoModels(channel, true);
  const options = [...new Set(catalog.available)].map(id => {
    const rows = catalog.rows.filter(row => row.id === id);
    try {
      if (rows.length !== 1) throw fail('目录存在重复 ID，请上游确认后再添加');
      return { id, profile: zhiyingCatalogProfile(rows[0]) };
    } catch (error) { return { id, reason: (error as Error).message }; }
  });
  return { options, warnings: catalog.warnings };
}
function checkDraft(draft: ZhiyingModelDraft) {
  if (!draft || typeof draft.modelId !== 'string' || !/^Lx-[A-Za-z0-9][A-Za-z0-9._-]{0,115}$/.test(draft.modelId)
    || typeof draft.upstreamModel !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/.test(draft.upstreamModel)
    || typeof draft.enabled !== 'boolean' || typeof draft.routeEnabled !== 'boolean') throw fail('本站名称须为 Lx- 开头的英文型号，并选择有效上游模型');
  validateLimits(draft.limits);
  if (draft.limits.firstFrame || draft.limits.lastFrame || draft.limits.maxOutputs !== 1 || draft.limits.outputsPerTask !== undefined || draft.limits.qualities.length)
    throw fail('此协议支持普通参考素材，每次生成一条视频');
  return draft;
}
function checkSubset(limits: ModelInputLimits, upstream: ModelInputLimits) {
  const duration = limits.duration;
  const seconds = duration.mode === 'options' ? duration.values : duration.mode === 'fixed' ? [duration.min]
    : Array.from({ length: Math.floor((duration.max - duration.min) / duration.step) + 1 }, (_, i) => duration.min + i * duration.step);
  if (seconds.some(n => !Number.isSafeInteger(n) || !allowsDuration(upstream.duration, n))
    || !limits.resolutions.every(r => upstream.resolutions.includes(r)) || !limits.ratios.every(r => upstream.ratios.includes(r))
    || ['maxImages', 'maxVideos', 'maxAudios'].some(k => limits[k as 'maxImages'] > upstream[k as 'maxImages'])
    || limits.maxReferences === undefined || limits.maxReferences > upstream.maxReferences!
    || limits.maxReferences < limits.minImages || limits.defaultSeconds === undefined) throw fail('本站参数必须在当前上游目录允许范围内，且填写默认时长和素材合计上限');
}
async function checkedProfile(channelId: number, draft: ZhiyingModelDraft) {
  checkDraft(draft);
  const { options } = await listZhiyingCatalogOptions(channelId);
  const option = options.find(row => row.id === draft.upstreamModel);
  if (!option?.profile) throw fail(option?.reason || '当前 Key 可用目录未返回该上游模型', 409);
  checkSubset(draft.limits, option.profile.limits);
  return { ...option.profile, limits: draft.limits };
}
export async function previewZhiyingModelRequest(channelId: number, draft: ZhiyingModelDraft) {
  const profile = await checkedProfile(channelId, draft);
  return { method: 'POST', path: '/v1/generations', body: { model: draft.upstreamModel, prompt: 'A calm ocean at sunrise.',
    resolution: profile.limits.resolutions[0], duration: profile.limits.defaultSeconds, aspect_ratio: profile.limits.ratios[0] } };
}
export async function saveZhiyingModelConfiguration(channelId: number, value: ZhiyingModelDraft, version: string | null) {
  // Freeze administrator input before any network wait.
  const draft = checkDraft(structuredClone(value)), channel = getChannel(channelId), original = configuration(channel, draft.modelId);
  if (original.reason) throw fail(original.reason, 409);
  if (original.model ? version !== original.version : version !== null) throw fail('配置已变化，请重新打开后保存', 409);
  const profile = await checkedProfile(channelId, draft);
  return sqlite.transaction(() => {
    const live = getChannel(channelId), current = configuration(live, draft.modelId);
    if (live.apiKey !== channel.apiKey || live.baseUrl !== channel.baseUrl || current.version !== original.version || current.reason)
      throw fail('授权查询期间配置已变化，请重新打开后保存', 409);
    validatePublicModelName(draft.modelId, draft.modelId, current.model?.id);
    if (!current.model && (resolveApiModelId(draft.modelId) !== draft.modelId || current.spec
      || getModelSpecifications().some(s => s.aliases.includes(draft.modelId)))) throw fail('本站名称已被其他产品或别名占用', 409);
    if (!current.model) db.insert(models).values({ modelId: draft.modelId, displayName: draft.modelId, provider: 'zhiying',
      capabilities: '["video"]', isActive: 0, description: '后台添加的智赢视频模型，请配置本站售价后启用。' }).run();
    else db.update(models).set({ displayName: draft.modelId }).where(eq(models.id, current.model.id)).run();
    const same = current.route?.upstreamModel === draft.upstreamModel;
    saveModelSpecification({ modelId: draft.modelId, kind: 'video', enabled: draft.enabled, aliases: current.spec?.aliases ?? [], limits: draft.limits,
      routes: [{ id: current.route?.id ?? randomUUID(), channelId, executionModel: draft.modelId, upstreamModel: draft.upstreamModel,
        enabled: draft.routeEnabled, limits: draft.limits, cost: same ? current.route!.cost : null,
        costUnit: same ? current.route!.costUnit : 'unknown', resolutionCosts: same ? current.route!.resolutionCosts : {}, priority: current.route?.priority ?? 0 }] });
    saveZhiyingBinding(sqlite, { channelId, modelId: draft.modelId, upstreamModel: draft.upstreamModel, profile });
    db.update(channels).set({ supportedModels: JSON.stringify([...new Set([...JSON.parse(live.supportedModels || '[]'), draft.modelId])]),
      modelMapping: JSON.stringify({ ...JSON.parse(live.modelMapping || '{}'), [draft.modelId]: draft.upstreamModel }), updatedAt: new Date().toISOString() })
      .where(eq(channels.id, channelId)).run();
    return listZhiyingModelConfigurations(channelId).find(row => row.modelId === draft.modelId)!;
  }).immediate();
}
