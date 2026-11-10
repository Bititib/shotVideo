import { eq } from 'drizzle-orm';
import {
  isZhiyingVideoModel, ZHIYING_CHANNEL_TYPE, ZHIYING_VIDEO_MODELS, zhiyingApiBase, zhiyingVideoSpec,
} from '../../shared/zhiyingVideo.js';
import { db, sqlite } from '../db/index.js';
import { channels, models } from '../db/schema.js';
import { getModelSpecification, saveModelSpecification } from './modelRoutingService.js';
import { resolveApiModelId, validatePublicModelName } from './publicModelNameService.js';
import { transportDiagnostic, upstreamDiagnostic } from './upstreamDiagnostic.js';

import { zhiyingBindings } from './zhiyingModelBindings.js';
import { zhiyingCatalogProfile } from './zhiyingCatalogProfile.js';
import { allowsDuration } from '../../shared/modelRouting.js';

type Channel = typeof channels.$inferSelect;
const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });

export async function fetchZhiyingVideoModels(channel: Pick<Channel, 'baseUrl' | 'apiKey' | 'timeout'>, includeAll = false) {
  const url = zhiyingApiBase(channel.baseUrl) + '/v1/models';
  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: 'Bearer ' + channel.apiKey },
      redirect: 'error', signal: AbortSignal.timeout(channel.timeout || 30_000) });
  } catch (error) {
    throw Object.assign(new Error(transportDiagnostic('智赢', '读取模型目录', error, channel.apiKey)), { status: 502 });
  }
  const failure = (detail: unknown, requestId?: string) => Object.assign(new Error(upstreamDiagnostic('智赢',
    '读取模型目录', detail, channel.apiKey, response.status, requestId || response.headers.get('x-request-id') || undefined)), { status: 502 });
  const raw = await response.json().catch(() => { throw failure('响应不是完整的 JSON 模型目录'); });
  if (!response.ok || raw?.error) {
    const error = raw?.error;
    throw failure({ code: error?.code, message: typeof error?.message === 'string' ? error.message : '上游未提供错误详情',
      detail: typeof error?.type === 'string' ? error.type : undefined }, error?.request_id);
  }
  if (!Array.isArray(raw?.data)) throw failure('响应缺少 data 模型列表，原配置未修改');
  if (raw.unavailable !== undefined && !Array.isArray(raw.unavailable)) {
    throw failure('unavailable 不是列表，原配置未修改');
  }
  const available = new Set<string>();
  const blocked = new Map<string, string>();
  for (const row of raw.data) {
    if (typeof row?.id !== 'string' || !row.id.trim()) throw failure('模型目录含无效 ID，原配置未修改');
    if (!includeAll && !isZhiyingVideoModel(row.id)) continue;
    // The provider defines data as the available list. An explicit non-available
    // status or a mismatched media type overrides membership in that list.
    if (row.media_type !== 'video' || row.available === false || (row.status !== undefined && row.status !== 'available')) {
      const field = (value: unknown) => typeof value === 'string' ? JSON.stringify(value.slice(0, 80)) : '缺失或格式异常';
      blocked.set(row.id, `data 返回 media_type=${field(row.media_type)}、status=${field(row.status)}`);
      continue;
    }
    available.add(row.id);
  }
  for (const row of raw.unavailable ?? []) {
    if (typeof row?.id !== 'string' || !includeAll && !isZhiyingVideoModel(row.id)) continue;
    blocked.set(row.id, available.has(row.id) ? '同时出现在 data 和 unavailable' : '出现在 unavailable 列表');
  }
  const warnings = [...blocked].map(([id, reason]) => failure(`${id} ${reason}，暂不接收该线路的新任务`).message);
  return { available: (includeAll ? [...available] : [...ZHIYING_VIDEO_MODELS]).filter(id => available.has(id) && !blocked.has(id)), warnings, rows: raw.data as Record<string, any>[] };
}

export async function syncZhiyingModels(channel: Channel) {
  const { available: upstreamAvailable, warnings, rows } = await fetchZhiyingVideoModels(channel, true);
  const bindings = zhiyingBindings(sqlite).filter(row => row.channelId === channel.id);
  const available = ZHIYING_VIDEO_MODELS.filter(id => upstreamAvailable.includes(id));
  return sqlite.transaction(() => {
    const current = db.select().from(channels).where(eq(channels.id, channel.id)).get();
    if (!current || current.type !== ZHIYING_CHANNEL_TYPE || current.apiKey !== channel.apiKey || current.baseUrl !== channel.baseUrl
      || current.modelMapping !== channel.modelMapping || current.supportedModels !== channel.supportedModels) {
      throw conflict('读取智赢目录期间渠道配置已变更，请重新同步');
    }
    const mapping: Record<string, string> = JSON.parse(current.modelMapping || '{}');
    const previous: string[] = JSON.parse(current.supportedModels || '[]');
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || Object.values(mapping).some(v => typeof v !== 'string')
      || !Array.isArray(previous) || previous.some(v => typeof v !== 'string')) throw conflict('渠道模型关联格式无效，原配置未修改');
    let added = 0;
    for (const id of available) {
      const { displayName, limits } = zhiyingVideoSpec(id);
      const existing = db.select().from(models).where(eq(models.modelId, id)).get();
      if (existing && (existing.provider !== ZHIYING_CHANNEL_TYPE || !JSON.parse(existing.capabilities).includes('video'))) {
        throw conflict(`公开模型 ID ${id} 已被其他产品占用，原配置未修改`);
      }
      validatePublicModelName(id, displayName, existing?.id);
      if (!existing && (resolveApiModelId(id) !== id || resolveApiModelId(displayName) !== displayName || getModelSpecification(id))) {
        throw conflict(`公开模型 ID ${id} 已由原有别名或规格使用，原配置未修改`);
      }
      if (Object.hasOwn(mapping, id) && mapping[id] !== id) throw conflict(`${id} 已有不同的上游映射，原配置未修改`);
      if (!existing) {
        db.insert(models).values({ provider: ZHIYING_CHANNEL_TYPE, modelId: id, displayName, capabilities: '["video"]',
          description: `由 ${current.name} 同步；请配置本站售价后启用。`, isActive: 0 }).run();
        added++;
      }
      mapping[id] = id;
      const spec = getModelSpecification(id);
      const routes = spec?.routes.filter(r => r.channelId === channel.id) || [];
      if (routes.some(r => r.upstreamModel !== id || r.executionModel !== id)) throw conflict(`${id} 已有不同线路映射，原配置未修改`);
      if (routes.length) continue;
      const route = { id: `zhiying-${channel.id}-${id}`, channelId: channel.id, executionModel: id, upstreamModel: id,
        enabled: true, limits, cost: null, costUnit: 'unknown' as const, resolutionCosts: {}, priority: current.priority };
      saveModelSpecification(spec ? { ...spec, routes: [...spec.routes, route] }
        : { kind: 'video', modelId: id, enabled: true, aliases: [], limits, routes: [route] });
    }
    const manualAvailable = bindings.filter(binding => {
      if (!upstreamAvailable.includes(binding.upstreamModel)) return false;
      try {
        const matches = rows.filter(row => row.id === binding.upstreamModel);
        if (matches.length !== 1) throw new Error('目录存在重复 ID');
        const live = zhiyingCatalogProfile(matches[0]), saved = binding.profile;
        const d = saved.limits.duration;
        const seconds = d.mode === 'options' ? d.values : d.mode === 'fixed' ? [d.min]
          : Array.from({ length: Math.floor((d.max - d.min) / d.step) + 1 }, (_, i) => d.min + i * d.step);
        if (seconds.some(n => !allowsDuration(live.limits.duration, n)) || saved.promptMax > live.promptMax
          || !saved.limits.resolutions.every(r => live.limits.resolutions.includes(r)) || !saved.limits.ratios.every(r => live.limits.ratios.includes(r))
          || (['maxImages', 'maxVideos', 'maxAudios', 'maxReferences'] as const).some(k => saved.limits[k]! > live.limits[k]!)
          || (['image', 'video', 'audio'] as const).some(k => saved.fileMaxBytes[k] > live.fileMaxBytes[k])
          || live.avDurationMax !== undefined && (saved.avDurationMax === undefined || saved.avDurationMax > live.avDurationMax)
          || saved.videoDurationTotal !== live.videoDurationTotal || saved.referenceMode && !live.referenceMode || saved.directProcessing && !live.directProcessing)
          throw new Error('上游参数已变化，请重新核对并保存模型配置');
        return true;
      } catch (error) {
        warnings.push(`${binding.modelId}：${(error as Error).message}，保留配置并暂停接收新任务`); return false;
      }
    }).map(row => row.modelId);
    const managedIds = new Set([...ZHIYING_VIDEO_MODELS, ...bindings.map(row => row.modelId)]);
    // Only available IDs may receive new work. Keep the mapping and original route for already accepted tasks.
    const supported = [...new Set([...previous.filter(id => !managedIds.has(id)), ...available, ...manualAvailable])];
    db.update(channels).set({ supportedModels: JSON.stringify(supported), modelMapping: JSON.stringify(mapping),
      updatedAt: new Date().toISOString() }).where(eq(channels.id, current.id)).run();
    const synced = [...new Set([...available, ...manualAvailable])];
    return { count: synced.length, added, models: synced, ...(warnings.length ? { warnings } : {}) };
  })();
}
