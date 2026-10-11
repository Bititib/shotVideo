import { blobDrawKnownModelId } from '../../shared/blobDrawVideo.js';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { channels, models } from '../db/schema.js';
import { fetchBlobDrawModels, blobDrawModelLimits, type BlobDrawChannel } from './blobDrawAdapter.js';
import { getModelSpecification, saveModelSpecification } from './modelRoutingService.js';

/** Known names use stable public IDs; numeric platform IDs are always channel-specific mappings. */
export async function syncBlobDrawModels(channel: BlobDrawChannel & { id: number; name: string; priority: number }) {
  const upstream = await fetchBlobDrawModels(channel);
  // Validate the complete response before changing any existing channel/model configuration.
  const entries = [...new Map(upstream.map(model => [String(model.id), model])).values()].map(model => ({
    model, modelId: blobDrawKnownModelId(model.name) || 'blobdraw-' + channel.id + '-' + encodeURIComponent(String(model.id)), limits: blobDrawModelLimits(model),
  }));
  if (new Set(entries.map(entry => entry.modelId)).size !== entries.length) throw new Error('BlobDraw 模型名称重复，请确认上游模型配置');
  const oldChannel = db.select().from(channels).where(eq(channels.id, channel.id)).get();
  const previousMapping: Record<string, string> = JSON.parse(oldChannel?.modelMapping || '{}');
  let added = 0;
  sqlite.transaction(() => {
    for (const entry of entries) {
      const existing = db.select().from(models).where(eq(models.modelId, entry.modelId)).get();
      if (!existing) {
        db.insert(models).values({ provider: 'blobdraw', modelId: entry.modelId,
          displayName: entry.model.name || '视频模型 ' + entry.model.id,
          description: '由 ' + channel.name + ' 同步；请配置本站售价后启用。', capabilities: '["video"]', isActive: 0 }).run();
        added++;
      }
    }
    db.update(channels).set({
      type: 'blobdraw', supportedModels: JSON.stringify(entries.map(e => e.modelId)),
      modelMapping: JSON.stringify(Object.fromEntries(entries.map(e => [e.modelId, String(e.model.id)]))),
      updatedAt: new Date().toISOString(),
    }).where(eq(channels.id, channel.id)).run();
    for (const entry of entries) {
      // Preserve administrator switches, prices, custom limits and additional routes on resync.
      const existingSpec = getModelSpecification(entry.modelId);
      if (existingSpec?.routes.some(route => route.channelId === channel.id)) {
        // Follow a changed platform ID only for the mapping previously owned by this sync.
        // Keep custom upstream overrides and every administrator switch/cost/limit intact.
        if (blobDrawKnownModelId(entry.model.name)) {
          const routes = existingSpec.routes.map(route => route.channelId === channel.id
            && route.executionModel === entry.modelId && route.upstreamModel === previousMapping[entry.modelId]
              ? { ...route, upstreamModel: String(entry.model.id) } : route);
          if (JSON.stringify(routes) !== JSON.stringify(existingSpec.routes)) saveModelSpecification({ ...existingSpec, routes });
        }
        continue;
      }
      const route = { id: 'blobdraw-' + channel.id + '-' + encodeURIComponent(String(entry.model.id)), channelId: channel.id,
        executionModel: entry.modelId, upstreamModel: String(entry.model.id), enabled: true, limits: structuredClone(entry.limits),
        cost: null, costUnit: 'unknown' as const, resolutionCosts: {}, priority: channel.priority };
      saveModelSpecification(existingSpec ? { ...existingSpec, routes: [...existingSpec.routes, route] }
        : { modelId: entry.modelId, kind: 'video', enabled: true, aliases: [], limits: entry.limits, routes: [route] });
    }
  })();
  return { count: entries.length, added, models: entries.map(e => e.modelId) };
}
