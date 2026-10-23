import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { channels, models } from '../db/schema.js';
import { BLOB_DRAW_BB_MODEL } from '../../shared/blobDrawVideo.js';
import { fetchHussVideoModels, hussBbModelLimits, type HussChannel } from './hussVideoAdapter.js';
import { getModelSpecification, saveModelSpecification } from './modelRoutingService.js';

export async function syncHussModels(channel: HussChannel & { id: number; name: string; priority: number }) {
  const upstream = await fetchHussVideoModels(channel);
  const existing = db.select().from(models).where(eq(models.modelId, BLOB_DRAW_BB_MODEL)).get(); let added = 0;
  sqlite.transaction(() => {
    if (!existing) { db.insert(models).values({ provider: 'huss', modelId: BLOB_DRAW_BB_MODEL, displayName: BLOB_DRAW_BB_MODEL, description: '由 ' + channel.name + '（HUSS）同步；请配置本站售价后启用。', capabilities: '["video"]', isActive: 0 }).run(); added++; }
    db.update(channels).set({ type: 'huss', supportedModels: JSON.stringify([BLOB_DRAW_BB_MODEL]), modelMapping: JSON.stringify({ [BLOB_DRAW_BB_MODEL]: upstream[0].id }), updatedAt: new Date().toISOString() }).where(eq(channels.id, channel.id)).run();
    const limits = hussBbModelLimits(), spec = getModelSpecification(BLOB_DRAW_BB_MODEL), route = { id: 'huss-' + channel.id + '-' + upstream[0].id, channelId: channel.id, executionModel: BLOB_DRAW_BB_MODEL, upstreamModel: upstream[0].id, enabled: true, limits: structuredClone(limits), cost: null, costUnit: 'unknown' as const, resolutionCosts: {}, priority: channel.priority };
    if (!spec) saveModelSpecification({ modelId: BLOB_DRAW_BB_MODEL, kind: 'video', enabled: true, aliases: [], limits, routes: [route] });
    else if (!spec.routes.some(item => item.channelId === channel.id)) saveModelSpecification({ ...spec, limits, routes: [...spec.routes, route] });
  })();
  return { count: 1, added, models: [BLOB_DRAW_BB_MODEL] };
}
