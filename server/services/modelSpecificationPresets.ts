import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { channels, models } from '../db/schema.js';
import { imageSpecificationId, type ModelSpecification } from '../../shared/modelRouting.js';
import { getHmStudioUpstreamVideoModel } from '../../shared/hmStudioVideo.js';
import { getModelSpecifications } from './modelRoutingService.js';

import { existingModelLimits } from './modelInputPresets.js';
export { existingModelLimits } from './modelInputPresets.js';

export function suggestedModelSpecifications() {
  const registry = db.select().from(models).all(), channelRows = db.select().from(channels).all();
  const existing = getModelSpecifications(), owned = new Set(existing.flatMap(s => [s.modelId,...(s.imageFamily ? [] : s.aliases)]));
  let drafts = registry.flatMap(model => {
    const capabilities = JSON.parse(model.capabilities), kind = capabilities.includes('video') ? 'video' : capabilities.includes('image') || capabilities.includes('image_gen') ? 'image' : null;
    if (!kind || owned.has(model.modelId)) return [];
    const limits = existingModelLimits(model.modelId, kind); if (!limits) return [];
    const routes = channelRows.filter(c => JSON.parse(c.supportedModels).includes(model.modelId)).map(c => ({
      id: randomUUID(), channelId: c.id, executionModel: model.modelId, upstreamModel: JSON.parse(c.modelMapping)[model.modelId] || (c.type === 'hmstudio' ? getHmStudioUpstreamVideoModel(model.modelId) : model.modelId === 'gpt-image-2-siyuetian' || model.modelId === 'gpt-image-2-mingfei' ? 'gpt-image-2' : model.modelId),
      enabled: Boolean(model.isActive), limits: structuredClone(limits), cost: null, costUnit: kind === 'image' ? 'per_image' as const : 'unknown' as const, resolutionCosts: {}, priority: c.priority,
    }));
    if (!routes.length) return [];
    const spec: ModelSpecification = { modelId: model.modelId, kind, enabled: Boolean(model.isActive), aliases: [], limits, routes };
    return [{ ...spec, displayName: model.displayName }];
  });
  const imageDrafts = drafts.filter(s => s.kind === 'image');
  drafts = drafts.filter(s => s.kind !== 'image');
  const imageGroups = new Map<string, typeof imageDrafts>();
  for (const source of imageDrafts) {
    const family = ['gpt-image-2-siyuetian','gpt-image-2-mingfei'].includes(source.modelId) ? 'gpt-image-2' : source.modelId;
    imageGroups.set(family,[...(imageGroups.get(family) || []),source]);
  }
  const names: Record<string,string> = { 'gpt-image-2':'GPT Image 2','gpt-image-2.5-flare':'GPT Image 2.5 Flare','gpt-image-2.5-sunburst':'GPT Image 2.5 Sunburst','nano-banana-2':'Nano Banana 2','nano-banana-2.1':'Nano Banana 2.1','nano-banana-2-lite':'Nano Banana 2 Lite','nano-banana-pro':'Nano Banana Pro' };
  for (const [family,sources] of imageGroups) {
    const resolutions = [...new Set(sources.flatMap(s => s.limits.resolutions))].sort((a,b) => Number.parseFloat(a) - Number.parseFloat(b) || a.localeCompare(b));
    for (const resolution of resolutions) {
      if (existing.some(s => s.imageFamily === family && s.limits.resolutions[0].toLowerCase() === resolution.toLowerCase())) continue;
      const routes = sources.flatMap(s => s.routes).filter(r => r.limits.resolutions.some(v => v.toLowerCase() === resolution.toLowerCase()));
      const limits = { ...structuredClone(sources[0].limits), resolutions:[resolution], maxImages:Math.max(...routes.map(r => r.limits.maxImages)),
        minImages:Math.min(...routes.map(r => r.limits.minImages)), maxOutputs:Math.max(...routes.map(r => r.limits.maxOutputs)), ratios:[...new Set(routes.flatMap(r => r.limits.ratios))] };
      drafts.push({ modelId:imageSpecificationId(family,resolution),imageFamily:family,displayName:(names[family] || family) + ' · ' + resolution,
        kind:'image', enabled:sources.some(s => s.enabled),aliases:sources.map(s => s.modelId),limits,routes:structuredClone(routes) });
    }
  }
  // Video sale IDs, names, prices and duration rules stay independent. Only channels
  // advertising the same sale ID are suggested together; cross-ID merging is explicit.
  return drafts;
}
