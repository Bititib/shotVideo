import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { channels, models } from '../db/schema.js';
import { MJ_FAMILY, MJ_MODEL_ID, MJ_UPSTREAM_MODEL, mjLimits } from '../../shared/mj.js';
import { fetchMjModels, type MjChannel } from './mjAdapter.js';
import { getModelSpecification, saveModelSpecification } from './modelRoutingService.js';

/** Only the requested MJ model is imported, even when the key exposes other models. */
export async function syncMjModels(channel: MjChannel & { id: number; name: string; priority: number }) {
  const available = (await fetchMjModels(channel)).includes(MJ_UPSTREAM_MODEL);
  const ids = available ? [MJ_MODEL_ID] : [];
  let added = 0;
  sqlite.transaction(() => {
    if (available && !db.select().from(models).where(eq(models.modelId, MJ_MODEL_ID)).get()) {
      db.insert(models).values({ provider: 'mj', modelId: MJ_MODEL_ID, displayName: 'MJ · 1K',
        capabilities: '["image"]', isActive: 0,
        description: 'MJ 图片生成；1K，完整保留上游图片，按次计费，最多 6 张参考图。请配置按次售价后启用。' }).run();
      added++;
    }
    db.update(channels).set({ supportedModels: JSON.stringify(ids),
      modelMapping: JSON.stringify(available ? { [MJ_MODEL_ID]: MJ_UPSTREAM_MODEL } : {}),
      updatedAt: new Date().toISOString() }).where(eq(channels.id, channel.id)).run();
    if (!available) return;
    const existing = getModelSpecification(MJ_MODEL_ID);
    if (existing?.routes.some(route => route.channelId === channel.id)) {
      saveModelSpecification({ ...existing, limits: { ...existing.limits, maxOutputs: 4, outputsPerTask: 4 },
        routes: existing.routes.map(route => route.channelId === channel.id
          ? { ...route, limits: { ...route.limits, maxOutputs: 4, outputsPerTask: 4 } } : route) });
      return;
    }
    const limits = mjLimits();
    const route = { id: 'mj-' + channel.id, channelId: channel.id,
      executionModel: MJ_MODEL_ID, upstreamModel: MJ_UPSTREAM_MODEL,
      enabled: true, limits: structuredClone(limits), cost: null, costUnit: 'unknown' as const,
      resolutionCosts: {}, priority: channel.priority };
    saveModelSpecification(existing ? { ...existing, limits: { ...existing.limits, maxOutputs: 4, outputsPerTask: 4 }, routes: [...existing.routes, route] }
      : { modelId: MJ_MODEL_ID, imageFamily: MJ_FAMILY, kind: 'image', enabled: true,
        aliases: [], limits, routes: [route] });
  })();
  return { count: ids.length, added, models: ids };
}
