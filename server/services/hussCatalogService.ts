import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { channels, models } from '../db/schema.js';
import { isHussHssModel, HUSS_BB_PUBLIC_MODEL, HUSS_HSS_MODEL, hussHssModelLimits } from '../../shared/hussBbVideo.js';
import { fetchHussVideoModels, hussBbModelLimits, type HussChannel } from './hussVideoAdapter.js';
import { getModelSpecification, saveModelSpecification } from './modelRoutingService.js';

export async function syncHussModels(channel: HussChannel & { id: number; name: string; priority: number }) {
  const upstream = await fetchHussVideoModels(channel);
  let added = 0;
  const mapping = Object.fromEntries(upstream.map(item => [isHussHssModel(item.id) ? HUSS_HSS_MODEL : HUSS_BB_PUBLIC_MODEL, item.id]));
  sqlite.transaction(() => {
    for (const [publicId, upstreamId] of Object.entries(mapping)) {
      const existing = db.select().from(models).where(eq(models.modelId, publicId)).get();
      if (!existing) { db.insert(models).values({ provider: 'huss', modelId: publicId, displayName: publicId, description: '由 ' + channel.name + '（HUSS）同步；请配置本站售价后启用。', capabilities: '["video"]', isActive: 0 }).run(); added++; }
      else db.update(models).set({ provider: 'huss', description: '由 ' + channel.name + '（HUSS）同步；请配置本站售价后启用。' }).where(eq(models.modelId, publicId)).run();
      const limits = isHussHssModel(upstreamId) ? hussHssModelLimits() : hussBbModelLimits(), spec = getModelSpecification(publicId), route = { id: 'huss-' + channel.id + '-' + upstreamId, channelId: channel.id, executionModel: publicId, upstreamModel: upstreamId, enabled: true, limits: structuredClone(limits), cost: null, costUnit: 'unknown' as const, resolutionCosts: {}, priority: channel.priority };
      if (!spec) saveModelSpecification({ modelId: publicId, kind: 'video', enabled: true, aliases: [], limits, routes: [route] });
      else {
        const hasRoute = spec.routes.some(item => item.channelId === channel.id);
        const routes = hasRoute ? spec.routes.map(item => item.channelId !== channel.id ? item : {
          ...item,
          executionModel: publicId,
          upstreamModel: upstreamId,
          limits: item.upstreamModel === upstreamId ? item.limits : structuredClone(limits),
        }) : [...spec.routes, route];
        saveModelSpecification({ ...spec, routes });
      }
    }
    db.update(channels).set({ type: 'huss', supportedModels: JSON.stringify(Object.keys(mapping)), modelMapping: JSON.stringify(mapping), updatedAt: new Date().toISOString() }).where(eq(channels.id, channel.id)).run();
  })();
  return { count: upstream.length, added, models: Object.keys(mapping) };
}
