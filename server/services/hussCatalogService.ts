import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { channels, models } from '../db/schema.js';
import { HUSS_BB_PUBLIC_MODEL } from '../../shared/hussBbVideo.js';
import { fetchHussVideoModels, hussBbModelLimits, type HussChannel } from './hussVideoAdapter.js';
import { getModelSpecification, saveModelSpecification } from './modelRoutingService.js';

export async function syncHussModels(channel: HussChannel & { id: number; name: string; priority: number }) {
  const upstream = await fetchHussVideoModels(channel);
  const existing = db.select().from(models).where(eq(models.modelId, HUSS_BB_PUBLIC_MODEL)).get(); let added = 0;
  sqlite.transaction(() => {
    if (!existing) { db.insert(models).values({ provider: 'huss', modelId: HUSS_BB_PUBLIC_MODEL, displayName: HUSS_BB_PUBLIC_MODEL, description: '由 ' + channel.name + '（HUSS）同步；请配置本站售价后启用。', capabilities: '["video"]', isActive: 0 }).run(); added++; }
    else db.update(models).set({ provider: 'huss', description: '由 ' + channel.name + '（HUSS）同步；请配置本站售价后启用。' }).where(eq(models.modelId, HUSS_BB_PUBLIC_MODEL)).run();
    db.update(channels).set({ type: 'huss', supportedModels: JSON.stringify([HUSS_BB_PUBLIC_MODEL]), modelMapping: JSON.stringify({ [HUSS_BB_PUBLIC_MODEL]: upstream[0].id }), updatedAt: new Date().toISOString() }).where(eq(channels.id, channel.id)).run();
    const limits = hussBbModelLimits(), spec = getModelSpecification(HUSS_BB_PUBLIC_MODEL), route = { id: 'huss-' + channel.id + '-' + upstream[0].id, channelId: channel.id, executionModel: HUSS_BB_PUBLIC_MODEL, upstreamModel: upstream[0].id, enabled: true, limits: structuredClone(limits), cost: null, costUnit: 'unknown' as const, resolutionCosts: {}, priority: channel.priority };
    if (!spec) saveModelSpecification({ modelId: HUSS_BB_PUBLIC_MODEL, kind: 'video', enabled: true, aliases: [], limits, routes: [route] });
    else {
      const hasRoute = spec.routes.some(item => item.channelId === channel.id);
      const routes = hasRoute ? spec.routes.map(item => item.channelId !== channel.id ? item : {
        ...item,
        executionModel: HUSS_BB_PUBLIC_MODEL,
        upstreamModel: upstream[0].id,
        limits: item.upstreamModel === upstream[0].id ? item.limits : structuredClone(limits),
      }) : [...spec.routes, route];
      saveModelSpecification({ ...spec, routes });
    }
  })();
  return { count: 1, added, models: [HUSS_BB_PUBLIC_MODEL] };
}
