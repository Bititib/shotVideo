import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { channels, models, apipathChannelKeys } from '../db/schema.js';
import { APIPATH_MODELS } from '../../shared/apipathModels.js';
import { apipathRequest, type ApipathChannel } from './apipathAdapter.js';
import { getModelSpecification, saveModelSpecification } from './modelRoutingService.js';
import { apipathKeys } from './apipathKeyService.js';

export async function fetchApipathCatalog(channel: ApipathChannel & { id: number }) {
  const allKeys = apipathKeys(channel.id), keys = allKeys.filter(k => k.status === 1);
  const sources = allKeys.length ? keys : channel.apiKey ? [{ id: null, kind: 'legacy', apiKey: channel.apiKey }] : [];
  if (!sources.length) throw new Error('请先填写通联图片 API Key 或视频 API Key');
  const entries: typeof APIPATH_MODELS = [], summaries: string[] = [];
  const warnings: string[] = [];
  const bindings: { id: number; models: string[] }[] = [];
  // Resolve every configured key before mutating the catalog. One failed lookup leaves all bindings intact.
  for (const source of sources) {
    const label = source.kind === 'image' ? '图片 Key' : source.kind === 'video' ? '视频 Key' : '原有 Key';
    let raw: any;
    try { raw = await apipathRequest({ ...channel, apiKey: source.apiKey }, '/v1/models'); }
    catch (error: any) { throw new Error('通联' + label + '目录查询失败：' + error.message); }
    if (!Array.isArray(raw?.data) || raw.data.some((x: any) => typeof x?.id !== 'string')) throw new Error('通联' + label + '目录 data/id 格式无效');
    const names = new Set<string>(raw.data.map((x: any) => x.id));
    const allowed = APIPATH_MODELS.filter(x => names.has(x.upstreamModel || x.id) && (source.kind === 'legacy' || x.kind === source.kind));
    entries.push(...allowed);
    if (source.id !== null) bindings.push({ id: source.id, models: allowed.map(x => x.id) });
    summaries.push(label + '已核实规格 ' + allowed.length + ' 个');
    if (!allowed.length) warnings.push(label + '没有返回可接入的对应类型模型，请检查该 Key 的授权');
    const unknown = [...names].filter(id => !APIPATH_MODELS.some(x => (x.upstreamModel || x.id) === id));
    if (unknown.length) warnings.push(label + '未导入规格尚未核实或非图片/视频模型：' + unknown.join('、'));
  }
  return { entries, warnings, bindings, summaries, keyIds: keys.map(k => k.id) };
}

export async function syncApipathModels(channel: ApipathChannel & { id: number; priority: number }) {
  const { entries, warnings, bindings, keyIds } = await fetchApipathCatalog(channel);
  return sqlite.transaction(() => {
    if (JSON.stringify(apipathKeys(channel.id).filter(k => k.status === 1).map(k => k.id)) !== JSON.stringify(keyIds)) {
      throw new Error('同步期间通联 Key 已变更，请重新同步');
    }
    let added = 0;
    const imported: string[] = [];
    const upstreamMapping: Record<string, string> = {};
    for (const entry of entries) {
      const occupied = db.select().from(models).where(eq(models.modelId, entry.id)).get();
      if (occupied && occupied.provider !== 'apipath') {
        warnings.push('公开 ID 已被其他产品使用，未合并或改名：' + entry.id); continue;
      }
      const legacyDescription = entry.imageFamily ? `通联 Sunburst 图片 ${entry.limits.resolutions[0]}；最多 4 张参考图；尺寸按上游档位映射。配置售价后启用。` : entry.kind === 'image' ? '通联图片；默认输出规格；本站暂限 1 张参考图。配置售价后启用。' : '通联视频；规格按独立模型配置。配置售价后启用。';
      if (!occupied) {
        db.insert(models).values({ provider: 'apipath', modelId: entry.id, displayName: entry.name,
          description: entry.description || legacyDescription,
          capabilities: JSON.stringify([entry.kind]), isActive: 0 }).run(); added++;
      } else if (entry.description && (!occupied.description?.trim() || occupied.description === legacyDescription)) {
        // Upgrade only our placeholder copy; retain administrator-authored descriptions and all other model settings.
        db.update(models).set({ description: entry.description }).where(eq(models.id, occupied.id)).run();
      }
      imported.push(entry.id);
      upstreamMapping[entry.id] = entry.upstreamModel || entry.id;
      const existing = getModelSpecification(entry.id);
      if (existing?.routes.some(r => r.channelId === channel.id)) continue;
      const route = { id: 'apipath-' + channel.id + '-' + entry.id, channelId: channel.id, executionModel: entry.id,
        upstreamModel: entry.upstreamModel || entry.id, enabled: true, limits: structuredClone(entry.limits), cost: null,
        costUnit: 'unknown' as const, resolutionCosts: {}, priority: channel.priority };
      saveModelSpecification(existing ? { ...existing, routes: [...existing.routes, route] }
        : { modelId: entry.id, kind: entry.kind, ...(entry.imageFamily ? { imageFamily: entry.imageFamily } : {}), enabled: true, aliases: [], limits: entry.limits, routes: [route] });
    }
    const saved = db.select().from(channels).where(eq(channels.id, channel.id)).get();
    if (!saved || saved.type !== 'apipath' || saved.apiKey !== channel.apiKey || saved.baseUrl !== channel.baseUrl) throw new Error('同步期间通联渠道配置已变更，请重新同步');
    for (const binding of bindings) {
      db.update(apipathChannelKeys).set({ supportedModels: JSON.stringify(binding.models.filter(id => imported.includes(id))) })
        .where(eq(apipathChannelKeys.id, binding.id)).run();
    }
    const mapping = JSON.parse(saved?.modelMapping || '{}');
    db.update(channels).set({ supportedModels: JSON.stringify(imported),
      modelMapping: JSON.stringify(Object.fromEntries(imported.map(id => [id, mapping[id] || upstreamMapping[id]]))),
      maxRetries: 0, updatedAt: new Date().toISOString() }).where(eq(channels.id, channel.id)).run();
    return { count: imported.length, added, models: imported, warnings };
  })();
}
