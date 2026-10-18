import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { channels, models } from '../db/schema.js';
import { KMAI_MJ_FAMILY, KMAI_MJ_MODEL_ID, KMAI_MJ_UPSTREAM_MODEL, kmaiMjLimits } from '../../shared/kmai.js';
import { fetchKmaiMjModels, type KmaiChannel } from './kmaiAdapter.js';
import { getModelSpecification, saveModelSpecification } from './modelRoutingService.js';

/** Only the requested MJ model is imported, even when the key exposes other models. */
export async function syncKmaiMjModels(channel: KmaiChannel & { id: number; name: string; priority: number }) {
  const available = (await fetchKmaiMjModels(channel)).includes(KMAI_MJ_UPSTREAM_MODEL);
  const ids = available ? [KMAI_MJ_MODEL_ID] : [];
  let added = 0;
  sqlite.transaction(() => {
    if (available && !db.select().from(models).where(eq(models.modelId, KMAI_MJ_MODEL_ID)).get()) {
      db.insert(models).values({ provider: 'kmai', modelId: KMAI_MJ_MODEL_ID, displayName: 'MJ · 1K（KMAI）',
        capabilities: '["image"]', isActive: 0,
        description: 'MJ 图片生成；1K，每次任务返回 4 张，最多 6 张参考图。请配置按次售价后启用。' }).run();
      added++;
    }
    db.update(channels).set({ supportedModels: JSON.stringify(ids),
      modelMapping: JSON.stringify(available ? { [KMAI_MJ_MODEL_ID]: KMAI_MJ_UPSTREAM_MODEL } : {}),
      updatedAt: new Date().toISOString() }).where(eq(channels.id, channel.id)).run();
    if (!available) return;
    const existing = getModelSpecification(KMAI_MJ_MODEL_ID);
    if (existing?.routes.some(route => route.channelId === channel.id)) {
      saveModelSpecification({ ...existing, limits: { ...existing.limits, maxOutputs: 4, outputsPerTask: 4 },
        routes: existing.routes.map(route => route.channelId === channel.id
          ? { ...route, limits: { ...route.limits, maxOutputs: 4, outputsPerTask: 4 } } : route) });
      return;
    }
    const limits = kmaiMjLimits();
    const route = { id: 'kmai-mj-' + channel.id, channelId: channel.id,
      executionModel: KMAI_MJ_MODEL_ID, upstreamModel: KMAI_MJ_UPSTREAM_MODEL,
      enabled: true, limits: structuredClone(limits), cost: null, costUnit: 'unknown' as const,
      resolutionCosts: {}, priority: channel.priority };
    saveModelSpecification(existing ? { ...existing, limits: { ...existing.limits, maxOutputs: 4, outputsPerTask: 4 }, routes: [...existing.routes, route] }
      : { modelId: KMAI_MJ_MODEL_ID, imageFamily: KMAI_MJ_FAMILY, kind: 'image', enabled: true,
        aliases: [], limits, routes: [route] });
  })();
  return { count: ids.length, added, models: ids };
}
