import { PricingService } from './pricingService.js';
import { existingModelLimits } from './modelInputPresets.js';
import type { ModelSpecification, ModelInputLimits } from '../../shared/modelRouting.js';

export function createModelSalePriceResolver() {
  const quote = PricingService.createQuoteResolver(false);
  return (modelId: string, resolutions: string[]) => {
  const base = quote(modelId);
  return { configured: Boolean(base.billingType), billingType: base.billingType, rate: base.rate,
    resolutionPrices: Object.fromEntries(resolutions.map(resolution => [resolution, quote(modelId, { resolution }).rate])) };
  };
}
function limitsKey(l: ModelInputLimits) {
  return JSON.stringify([l.minImages,l.maxImages,l.maxVideos,l.maxAudios,l.firstFrame,l.lastFrame,
    [...l.resolutions].map(r=>r.toLowerCase()).sort(),[...l.ratios].sort(),[...l.qualities].sort(),
    l.duration.mode === 'fixed' ? ['fixed',l.duration.min] : l.duration.mode === 'options'
      ? ['options',[...l.duration.values].sort((a,b)=>a-b)] : ['range',l.duration.min,l.duration.max,l.duration.step]]);
}
/** A legacy sale ID may redirect only when its customer price and known service rules agree. */
export function createVideoAliasChecker() {
  const quote = PricingService.createQuoteResolver(false);
  return (spec: ModelSpecification, aliasId: string): string | null => {
    if (spec.kind !== 'video') return null;
    const original = existingModelLimits(aliasId, 'video');
    if (original && limitsKey(original) !== limitsKey(spec.limits)) return '输入能力或时长规则不同，应保留独立入口';
    const primary = quote(spec.modelId), alias = quote(aliasId);
    if (!primary.billingType || !alias.billingType) return '请先配置两个入口的用户售价，再确认是否可以合并';
    if (primary.billingType !== alias.billingType) return '用户计费单位不同，应保留独立入口';
    const resolutions = new Set([...spec.limits.resolutions, ...(original?.resolutions || [])]);
    if (primary.rate !== alias.rate || [...resolutions].some(resolution => quote(spec.modelId, { resolution }).rate !== quote(aliasId, { resolution }).rate))
      return '用户售价不同，应保留独立入口';
    return null;
  };
}
