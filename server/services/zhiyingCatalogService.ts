import { eq } from 'drizzle-orm';
import {
  isZhiyingVideoModel, ZHIYING_CHANNEL_TYPE, ZHIYING_VIDEO_MODELS, zhiyingApiBase, zhiyingVideoSpec,
  type ZhiyingVideoModel,
} from '../../shared/zhiyingVideo.js';
import { db, sqlite } from '../db/index.js';
import { channels, models } from '../db/schema.js';
import { getModelSpecification, saveModelSpecification } from './modelRoutingService.js';
import { resolveApiModelId, validatePublicModelName } from './publicModelNameService.js';
import { transportDiagnostic, upstreamDiagnostic } from './upstreamDiagnostic.js';

type Channel = typeof channels.$inferSelect;
const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });

export async function fetchZhiyingVideoModels(channel: Pick<Channel, 'baseUrl' | 'apiKey' | 'timeout'>): Promise<ZhiyingVideoModel[]> {
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
  const available = new Set<ZhiyingVideoModel>();
  for (const row of raw.data) {
    if (typeof row?.id !== 'string' || !row.id.trim()) throw failure('模型目录含无效 ID，原配置未修改');
    if (!isZhiyingVideoModel(row.id)) continue;
    if (row.media_type !== 'video' || row.status !== 'available' || available.has(row.id)) {
      throw failure(`data 中 ${row.id} 的类型、状态或唯一性与可用视频目录不符，原配置未修改`);
    }
    available.add(row.id);
  }
  if (raw.unavailable !== undefined && (!Array.isArray(raw.unavailable)
    || raw.unavailable.some((item: { id?: unknown } | null) => isZhiyingVideoModel(item?.id) && available.has(item.id)))) {
    throw failure('不可用列表与模型目录矛盾，原配置未修改');
  }
  return ZHIYING_VIDEO_MODELS.filter(id => available.has(id));
}

export async function syncZhiyingModels(channel: Channel) {
  const available = await fetchZhiyingVideoModels(channel);
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
      validatePublicModelName(id, existing?.displayName || displayName, existing?.id);
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
    // Only available IDs may receive new work. Keep the mapping and original route for already accepted tasks.
    const supported = [...new Set([...previous.filter(id => !isZhiyingVideoModel(id)), ...available])];
    db.update(channels).set({ supportedModels: JSON.stringify(supported), modelMapping: JSON.stringify(mapping),
      updatedAt: new Date().toISOString() }).where(eq(channels.id, current.id)).run();
    return { count: available.length, added, models: available };
  })();
}
