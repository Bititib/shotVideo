import { isUpstreamCreditFailure, type ModelAvailability } from '../../shared/upstreamAvailability.js';
import { createVideoAliasChecker } from './modelSaleService.js';
import { MJ_OVERFLOW_VIDEO_MODEL } from './videoFailoverService.js';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { channels, models, settings } from '../db/schema.js';
import { ChannelService } from './channelService.js';
import { routingMismatches, routeRequestCost, canShareImageAliases, type ModelSpecification, type ModelRoute, type RoutingInput, type ModelInputLimits } from '../../shared/modelRouting.js';

const CONFIG_KEY = 'model_specification_routes_v1';
const HEALTH_KEY = 'model_specification_health_v1';
export type RouteHealth = { failures: number; successes: number; generationFailures: number; state: 'healthy' | 'cooldown' | 'blocked'; retryAt: number; probeUntil?: number; lastError: string; updatedAt: string };
export type RouteCandidate = { route: ModelRoute; channel: any; cost: number | null; healthKey: string };
const error = (message: string, status = 400) => Object.assign(new Error(message), { status });
function read<T>(key: string, fallback: T): T {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row ? JSON.parse(row.value) : fallback;
}
function write(key: string, value: unknown) {
  db.insert(settings).values({ key, value: JSON.stringify(value), label: key === CONFIG_KEY ? '模型规格与渠道线路' : '模型线路健康状态' })
    .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(value), updatedAt: new Date().toISOString() } }).run();
}
export function getModelSpecifications(): ModelSpecification[] { return read(CONFIG_KEY, []); }
export function getModelSpecification(modelId: string) { return getModelSpecifications().find(spec => spec.modelId === modelId); }
export function hiddenRouteModelIds(): Set<string> {
  const specs = getModelSpecifications(), publicIds = new Set(specs.map(spec => spec.modelId));
  const check = createVideoAliasChecker();
  return new Set(specs.flatMap(spec => spec.aliases.filter(id => !check(spec, id))).filter(id => !publicIds.has(id)));
}
function validateLimits(l: ModelInputLimits) {
  if (!l || typeof l !== 'object') throw error('必须填写输入限制');
  if (l.outputsPerTask !== undefined && (!Number.isInteger(l.outputsPerTask) || l.outputsPerTask < 1 || l.outputsPerTask > 4 || l.maxOutputs !== l.outputsPerTask)) throw error('原生图片任务的输出数量必须为 1–4，且与输出上限一致');
  for (const key of ['maxImages', 'maxVideos', 'maxAudios', 'maxOutputs', 'minImages'] as const) {
    if (!Number.isInteger(l[key]) || l[key] < 0 || l[key] > 100 || (key === 'maxOutputs' && l[key] < 1)) throw error(key + ' 必须是有效数量');
  }
  if (l.minImages > l.maxImages) throw error('最少图片数不能超过上限');
  for (const key of ['resolutions', 'ratios', 'qualities'] as const) {
    if (!Array.isArray(l[key]) || l[key].length > 50 || (key !== 'qualities' && !l[key].length) || !l[key].every(v => typeof v === 'string' && v.trim() && v.length <= 80)) throw error(key + ' 必须是文本数组');
  }
  if (typeof l.firstFrame !== 'boolean' || typeof l.lastFrame !== 'boolean') throw error('首尾帧选项必须是布尔值');
  const d = l.duration;
  if (!d || !['range', 'fixed', 'options'].includes(d.mode) || ![d.min, d.max, d.step].every(Number.isFinite)
    || (d.max - d.min) / d.step > 3600 || d.min <= 0 || d.max < d.min || d.max > 3600 || d.step <= 0 || !Array.isArray(d.values)
    || !d.values.every(v => Number.isFinite(v) && v > 0 && v <= 3600) || (d.mode === 'options' && !d.values.length)) throw error('时长规则无效');
}
export function saveModelSpecification(value: ModelSpecification): ModelSpecification {
  if (!value || typeof value.modelId !== 'string' || !['image', 'video'].includes(value.kind) || typeof value.enabled !== 'boolean') throw error('规格定义无效');
  const rows = db.select().from(models).all(), model = rows.find(m => m.modelId === value.modelId);
  if (!model || !JSON.parse(model.capabilities).some((cap: string) => cap === value.kind || (value.kind === 'image' && cap === 'image_gen'))) throw error('请先创建对应的图片或视频模型');
  validateLimits(value.limits);
  if (value.kind === 'image' && value.limits.resolutions.length !== 1) throw error('图片入口必须固定一个输出分辨率，请为不同分辨率分别创建规格');
  if (value.imageFamily !== undefined && (value.kind !== 'image' || typeof value.imageFamily !== 'string' || !value.imageFamily.trim() || value.imageFamily !== value.imageFamily.trim() || value.imageFamily.length > 100)) throw error('所属图片模型无效');
  if (value.limits.maxOutputs > (value.kind === 'image' ? 4 : 1)) throw error('图片每次最多 4 张，视频每次只支持 1 条');
  if (!Array.isArray(value.aliases) || !value.aliases.every(id => typeof id === 'string' && rows.some(m => m.modelId === id && JSON.parse(m.capabilities).includes(value.kind)))) throw error('关联的旧模型不存在或生成类型不一致');
  const checkAlias = createVideoAliasChecker();
  for (const id of value.aliases) { const reason = checkAlias(value, id); if (reason) throw error('旧入口 ' + id + '：' + reason); }
  if (!Array.isArray(value.routes) || value.routes.length > 100) throw error('线路列表无效');
  const specs = getModelSpecifications(), previous = specs.find(s => s.modelId === value.modelId), other = specs.filter(s => s.modelId !== value.modelId);
  if (previous?.imageFamily && (previous.imageFamily !== value.imageFamily || previous.limits.resolutions[0].toLowerCase() !== value.limits.resolutions[0].toLowerCase())) throw error('已保存图片规格的所属模型与输出分辨率不能修改，请创建另一规格');
  if (other.some(s => s.aliases.includes(value.modelId) || value.aliases.includes(s.modelId) || s.aliases.some(id => value.aliases.includes(id)) && !canShareImageAliases(s, value))) throw error('模型已被其他规格关联');
  if (value.imageFamily && other.some(s => s.imageFamily === value.imageFamily && s.limits.resolutions[0].toLowerCase() === value.limits.resolutions[0].toLowerCase())) throw error('该图片模型的此分辨率规格已存在');
  const channelRows = db.select().from(channels).all(), ids = new Set<string>();
  const routes = value.routes.map(r => {
    validateLimits(r.limits);
    const ch = channelRows.find(c => c.id === r.channelId);
    if (!ch || typeof r.executionModel !== 'string' || !r.executionModel.trim() || typeof r.upstreamModel !== 'string' || !r.upstreamModel.trim()) throw error('线路渠道、执行模型和上游模型不能为空');
    if (typeof r.enabled !== 'boolean' || !Number.isFinite(r.priority)) throw error('线路开关或顺序无效');
    if (!['per_call', 'per_second', 'per_image', 'unknown'].includes(r.costUnit) || (r.cost !== null && (!Number.isFinite(r.cost) || r.cost < 0))) throw error('线路成本无效');
    if (!r.resolutionCosts || typeof r.resolutionCosts !== 'object' || Array.isArray(r.resolutionCosts) || !Object.values(r.resolutionCosts).every(v => Number.isFinite(v) && v >= 0)) throw error('分辨率成本无效');
    if (value.kind === 'video' && r.costUnit === 'per_image' || value.kind === 'image' && r.costUnit === 'per_second') throw error('上游成本单位与生成类型不一致');
    if (r.costUnit === 'unknown' && (r.cost !== null || Object.keys(r.resolutionCosts).length)) throw error('请先确认上游成本单位，再填写成本金额');
    if (r.id && (typeof r.id !== 'string' || r.id.length > 100)) throw error('线路 ID 无效');
    const id = r.id || randomUUID();
    if (ids.has(id)) throw error('线路 ID 重复');
    ids.add(id); return { ...r, id };
  });
  const result: ModelSpecification = { ...(value.imageFamily ? { imageFamily: value.imageFamily.trim() } : {}), modelId: value.modelId, kind: value.kind, enabled: value.enabled, limits: value.limits, aliases: [...new Set(value.aliases)].filter(id => id !== value.modelId), routes };
  sqlite.transaction(() => write(CONFIG_KEY, [...other, result]))(); return result;
}
export function deleteModelSpecification(modelId: string) { write(CONFIG_KEY, getModelSpecifications().filter(s => s.modelId !== modelId)); }
export const CREDIT_COOLDOWN_MS = 60_000;
export function getRouteHealth() {
  const health = read<Record<string, RouteHealth>>(HEALTH_KEY, {});
  let changed = false;
  // Old credit locks become a bounded cooldown based on the original failure time.
  for (const item of Object.values(health)) if (item.state === 'blocked' && isUpstreamCreditFailure(item.lastError)) {
    item.state = 'cooldown';
    item.retryAt = (Date.parse(item.updatedAt) || Date.now()) + CREDIT_COOLDOWN_MS;
    changed = true;
  }
  if (changed) write(HEALTH_KEY, health);
  return health;
}
export function routeHealthKey(route: ModelRoute, apiKeyId?: number | null) { return route.channelId + ':' + (apiKeyId || 0) + ':' + route.upstreamModel; }
export function resetRouteHealth(key: string) { const health = getRouteHealth(); delete health[key]; write(HEALTH_KEY, health); }
export function noteRouteResult(key: string, ok: boolean, message = '', blocked = false, generation = false) {
  const health = getRouteHealth();
  const old = health[key] || { failures: 0, successes: 0, generationFailures: 0, state: 'healthy', retryAt: 0, lastError: '', updatedAt: '' };
  const failures = ok ? 0 : old.failures + 1;
  const credits = !ok && isUpstreamCreditFailure(message);
  health[key] = { ...old, failures, successes: old.successes + Number(ok), generationFailures: old.generationFailures + Number(generation && !ok),
    state: old.state === 'blocked' || blocked && !credits ? 'blocked' : ok ? 'healthy' : 'cooldown', retryAt: ok ? 0 : Date.now() + (credits ? CREDIT_COOLDOWN_MS : Math.min(15 * 60_000, 30_000 * 2 ** Math.min(failures - 1, 5))),
    probeUntil: 0, lastError: old.state === 'blocked' ? old.lastError : ok ? '' : message.replace(/sk-[\w-]+/g, '[REDACTED]').slice(0, 300), updatedAt: new Date().toISOString() };
  write(HEALTH_KEY, health);
}
export function claimRouteProbe(key: string): boolean {
  return sqlite.transaction(() => {
    const health = getRouteHealth(), item = health[key];
    if (!item || item.state === 'healthy') return true;
    if (item.state === 'blocked' || item.retryAt > Date.now() || (item.probeUntil || 0) > Date.now()) return false;
    item.probeUntil = Date.now() + 10 * 60_000; write(HEALTH_KEY, health); return true;
  })();
}
export function inspectModelRoutes(spec: ModelSpecification, input?: RoutingInput, activeChannels = ChannelService.getActiveChannels()) {
  const health = getRouteHealth(), registry = db.select().from(models).all(), model = registry.find(m => m.modelId === spec.modelId);
  return spec.routes.map(route => {
    const executions = activeChannels.filter(c => c.id === route.channelId && Boolean(String(c.apiKey || '').trim()) && (c.supportedModels.includes(route.executionModel) || c.supportedModels.includes('*')));
    const execution = registry.find(m => m.modelId === route.executionModel);
    const reason = execution?.isActive === 0 && execution.modelId !== MJ_OVERFLOW_VIDEO_MODEL ? ['执行模型已禁用'] : !spec.enabled || model?.isActive !== 1 ? ['规格已禁用'] : !route.enabled ? ['模型线路已禁用'] : !executions.length ? ['渠道或 Key 已禁用 / 未配置'] : [];
    const matches = input ? routingMismatches(route.limits, input, spec.kind) : [];
    const targets = executions.map(channel => ({ route, channel, cost: input ? routeRequestCost(route, input) : null, healthKey: routeHealthKey(route, channel.apiKeyId) }));
    const available = targets.filter(t => { const h = health[t.healthKey]; return !h || h.state === 'healthy' || (h.state === 'cooldown' && h.retryAt <= Date.now() && (h.probeUntil || 0) <= Date.now()); });
    return { route, reasons: [...reason, ...matches, ...(executions.length && !available.length ? ['线路故障或恢复试用中'] : [])],
      cost: input ? routeRequestCost(route, input) : null, health: targets.map(t => ({ key: t.healthKey, ...(health[t.healthKey] || { state: 'healthy' }) })), candidates: available };
  });
}
export function selectModelRoutes(spec: ModelSpecification, input: RoutingInput): RouteCandidate[] {
  const reasons = routingMismatches(spec.limits, input, spec.kind);
  if (reasons.length) throw error(reasons.join('；'));
  return inspectModelRoutes(spec, input).filter(item => !item.reasons.length).flatMap(item => item.candidates)
    .sort((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity) || a.route.priority - b.route.priority || a.channel.priority - b.channel.priority || a.channel.id - b.channel.id);
}
export function specificationAvailability(spec: ModelSpecification): ModelAvailability {
  const routes = inspectModelRoutes(spec);
  if (routes.some(item => !item.reasons.length)) return { available: true };
  // Ignore manual/configuration failures when determining the earliest eligible recovery.
  const eligible = routes.filter(item => item.reasons.every(reason => reason === '线路故障或恢复试用中'));
  const health = eligible.flatMap(item => item.health);
  const timed = health.filter(h => h.state === 'cooldown') as (RouteHealth & { key: string })[];
  if (timed.length) {
    const next = timed.sort((a, b) => Math.max(a.retryAt, a.probeUntil || 0) - Math.max(b.retryAt, b.probeUntil || 0))[0];
    return { available: false, unavailableReason: isUpstreamCreditFailure(next.lastError) ? 'credits' : 'cooldown', retryAt: Math.max(next.retryAt, next.probeUntil || 0) };
  }
  return { available: false, unavailableReason: health.some(h => h.state === 'blocked') ? 'credentials' : 'configuration' };
}
export function specificationAvailable(spec: ModelSpecification) { return specificationAvailability(spec).available; }


/** Re-check operator switches and capability edits after any queue wait, without releasing a claimed probe. */
export function routeStillEnabled(modelId: string, target: RouteCandidate, input: RoutingInput): boolean {
  const spec = getModelSpecification(modelId), route = spec?.routes.find(r => r.id === target.route.id);
  if (!spec?.enabled || !route?.enabled || JSON.stringify(route) !== JSON.stringify(target.route)
    || routingMismatches(spec.limits, input, spec.kind).length || routingMismatches(route.limits, input, spec.kind).length) return false;
  const registry = db.select().from(models).all();
  if (registry.find(m => m.modelId === modelId)?.isActive !== 1) return false;
  const execution = registry.find(m => m.modelId === route.executionModel);
  if (execution?.isActive === 0 && execution.modelId !== MJ_OVERFLOW_VIDEO_MODEL) return false;
  return ChannelService.getActiveChannels().some(c => c.id === target.channel.id && c.apiKeyId === target.channel.apiKeyId
    && c.apiKey === target.channel.apiKey && c.baseUrl === target.channel.baseUrl && Boolean(c.apiKey)
    && (c.supportedModels.includes(route.executionModel) || c.supportedModels.includes('*')));
}
