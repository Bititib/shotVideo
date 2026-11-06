import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { channels, models } from '../db/schema.js';
import { fetchAsyncVideoModels, type AsyncVideoChannel, type AsyncVideoModel } from './asyncVideoAdapter.js';
import { VX_LE_SEEDANCE_MODEL, LEGACY_VX_LE_SEEDANCE_MODEL, asyncVideoConfirmedLimits, asyncVideoPublicModelId } from '../../shared/asyncVideo.js';
import { getModelSpecification, saveModelSpecification } from './modelRoutingService.js';
import { channelCatalogBindings } from './channelCatalogBindings.js';

type CatalogChannel = AsyncVideoChannel & { id: number; name: string; priority: number };

/** Register a user-confirmed model without requiring discovery credentials. */
export function ensureVxLeSeedanceModel(channel: CatalogChannel) {
  return registerAsyncVideoModels(channel, [{ name: VX_LE_SEEDANCE_MODEL, limits: asyncVideoConfirmedLimits(VX_LE_SEEDANCE_MODEL) }], false);
}

export async function syncAsyncVideoModels(channel: CatalogChannel) {
  const saved = db.select().from(channels).where(eq(channels.id, channel.id)).get();
  const configured = saved ? channelCatalogBindings(sqlite, saved) ?? new Map<string, string>() : new Map<string, string>();
  const allowed = new Set([VX_LE_SEEDANCE_MODEL, ...configured.values()]);
  const upstream = await fetchAsyncVideoModels(channel);
  const approved = upstream.filter(entry => allowed.has(entry.name));
  if (!approved.length) return { count: 0, added: 0, models: [], warnings: ['当前目录没有已接入型号，原配置未修改。'] };
  return { ...registerAsyncVideoModels(channel, approved, false),
    warnings: [`仅同步已接入或明确配置的型号，忽略其他型号 ${upstream.length - approved.length} 个。`] };
}

function registerAsyncVideoModels(channel: CatalogChannel, upstream: AsyncVideoModel[], replace: boolean) {
  let added = 0;
  return sqlite.transaction(() => {
    const saved = db.select().from(channels).where(eq(channels.id, channel.id)).get();
    const configured = saved ? channelCatalogBindings(sqlite, saved) ?? new Map<string, string>() : new Map<string, string>();
    const legacyModelId = asyncVideoPublicModelId(channel.id, LEGACY_VX_LE_SEEDANCE_MODEL);
    const legacyModel = db.select().from(models).where(eq(models.modelId, legacyModelId)).get();
    // Keep the existing public ID so saved access rules, prices and tasks retain their bindings.
    const entries = upstream.map(model => ({ ...model, modelId: model.name === VX_LE_SEEDANCE_MODEL && legacyModel
      ? legacyModelId : [...configured].find(([, upstream]) => upstream === model.name)?.[0] || asyncVideoPublicModelId(channel.id, model.name) }));
    for (const entry of entries) {
      if (!db.select().from(models).where(eq(models.modelId, entry.modelId)).get()) {
        db.insert(models).values({ provider: 'async-video', modelId: entry.modelId, displayName: channel.name + ' · ' + entry.name,
          description: entry.name === VX_LE_SEEDANCE_MODEL
            ? '最多 9 张参考图；不支持视频、音频和独立首尾帧；固定 15 秒；分辨率由上游决定。请配置售价后启用。'
            : '异步视频接口；分辨率由上游决定；参考图数量默认限制为 1，可在模型路由中调整。请配置售价后启用。',
          capabilities: '["video"]', isActive: 0 }).run();
        added++;
      }
      if (entry.name === VX_LE_SEEDANCE_MODEL && entry.modelId === legacyModelId
        && legacyModel?.displayName.endsWith(' · ' + LEGACY_VX_LE_SEEDANCE_MODEL)) {
        db.update(models).set({ displayName: legacyModel.displayName.slice(0, -LEGACY_VX_LE_SEEDANCE_MODEL.length) + VX_LE_SEEDANCE_MODEL })
          .where(eq(models.modelId, entry.modelId)).run();
      }
    }
    const savedChannel = db.select().from(channels).where(eq(channels.id, channel.id)).get();
    const supportedModels = replace ? entries.map(e => e.modelId)
      : [...new Set([...JSON.parse(savedChannel?.supportedModels || '[]'), ...entries.map(e => e.modelId)])];
    const mapping = { ...(replace ? {} : JSON.parse(savedChannel?.modelMapping || '{}')), ...Object.fromEntries(entries.map(e => [e.modelId, e.name])) };
    db.update(channels).set({ supportedModels: JSON.stringify(supportedModels),
      modelMapping: JSON.stringify(mapping), updatedAt: new Date().toISOString(),
    }).where(eq(channels.id, channel.id)).run();
    for (const entry of entries) {
      const existing = getModelSpecification(entry.modelId);
      if (existing?.routes.some(r => r.channelId === channel.id)) {
        if (entry.name === VX_LE_SEEDANCE_MODEL) {
          saveModelSpecification({ ...existing, limits: asyncVideoConfirmedLimits(entry.name, existing.limits),
            routes: existing.routes.map(route => route.channelId === channel.id && route.executionModel === entry.modelId
              ? { ...route, upstreamModel: route.upstreamModel === LEGACY_VX_LE_SEEDANCE_MODEL ? VX_LE_SEEDANCE_MODEL : route.upstreamModel,
                limits: asyncVideoConfirmedLimits(entry.name, route.limits) } : route) });
        }
        continue;
      }
      const route = { id: 'async-video-' + channel.id + '-' + (entries.indexOf(entry) + 1), channelId: channel.id,
        executionModel: entry.modelId, upstreamModel: entry.name, enabled: true, limits: structuredClone(entry.limits),
        cost: null, costUnit: 'unknown' as const, resolutionCosts: {}, priority: channel.priority };
      saveModelSpecification(existing ? { ...existing, routes: [...existing.routes, route] }
        : { modelId: entry.modelId, kind: 'video', enabled: true, aliases: [], limits: entry.limits, routes: [route] });
    }
    return { count: entries.length, added, models: entries.map(e => e.modelId) };
  })();
}
