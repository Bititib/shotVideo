import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { channels, models } from '../db/schema.js';
import { FUNAI_MODEL_PREFIX, funAiModelKind, funAiModelLimits } from '../../shared/funAi.js';
import { imageSpecificationId, type ModelSpecification } from '../../shared/modelRouting.js';
import { fetchFunAiModels, type FunAiChannel } from './funAiAdapter.js';
import { getModelSpecification, saveModelSpecification } from './modelRoutingService.js';

export async function syncFunAiModels(channel: FunAiChannel & { id: number; name: string; priority: number }) {
  const discovered = await fetchFunAiModels(channel);
  const entries = discovered.filter(id => funAiModelKind(id)).map(upstream => ({ upstream, execution: FUNAI_MODEL_PREFIX + upstream,
    kind: funAiModelKind(upstream)!, limits: funAiModelLimits(upstream) }));
  const saleEntries = entries.flatMap(entry => (entry.kind === 'image' ? entry.limits.resolutions : ['']).map(resolution => ({ ...entry, resolution,
    saleId: resolution ? imageSpecificationId(entry.execution, resolution) : entry.execution })));
  let added = 0;
  sqlite.transaction(() => {
    for (const entry of saleEntries) {
      if (!db.select().from(models).where(eq(models.modelId, entry.saleId)).get()) {
        db.insert(models).values({ provider: 'funai', modelId: entry.saleId, displayName: 'FunAI · ' + entry.upstream + (entry.resolution ? ' · ' + entry.resolution : ''),
          capabilities: JSON.stringify([entry.kind]), description: '由 ' + channel.name + ' 同步；请配置售价后启用。',
          isActive: 0 }).run(); added++;
      }
    }
    db.update(channels).set({ type: 'funai', supportedModels: JSON.stringify(saleEntries.map(e => e.saleId)),
      modelMapping: JSON.stringify(Object.fromEntries(saleEntries.map(e => [e.saleId, e.upstream]))),
      updatedAt: new Date().toISOString() }).where(eq(channels.id, channel.id)).run();
    for (const entry of saleEntries) {
        const { saleId, resolution } = entry;
        const existing = getModelSpecification(saleId);
        // Never overwrite administrator limits, switches, custom mappings or costs.
        if (existing?.routes.some(route => route.channelId === channel.id)) continue;
        const limits = { ...structuredClone(entry.limits), ...(resolution ? { resolutions: [resolution] } : {}) };
        const route = { id: 'funai-' + channel.id + '-' + entry.upstream + (resolution ? '-' + resolution.toLowerCase() : ''),
          channelId: channel.id, executionModel: saleId, upstreamModel: entry.upstream, enabled: true,
          limits: structuredClone(limits), cost: null, costUnit: 'unknown' as const, resolutionCosts: {}, priority: channel.priority };
        const spec: ModelSpecification = existing ? { ...existing, routes: [...existing.routes, route] }
          : { modelId: saleId, kind: entry.kind, enabled: true, aliases: [], limits, routes: [route],
            ...(resolution ? { imageFamily: entry.execution } : {}) };
        saveModelSpecification(spec);
    }
  })();
  return { count: saleEntries.length, added, models: saleEntries.map(e => e.saleId), skipped: discovered.filter(id => !funAiModelKind(id)).length };
}
