import { getModelSpecifications, hiddenRouteModelIds } from './modelRoutingService.js';
import { isRetiredVideoModel } from '../../shared/retiredVideoModels.js';
import { isZhiyingVideoModel, ZHIYING_CHANNEL_TYPE, zhiyingVideoSpec } from '../../shared/zhiyingVideo.js';
import { configuredZhiyingProfile } from './zhiyingModelRegistry.js';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { models } from '../db/schema.js';
import { MJ_OVERFLOW_VIDEO_MODEL } from './videoFailoverService.js';
import { PricingService } from './pricingService.js';

/** The admin-managed registry is authoritative for every public model list. */
export function getEnabledPublicModels(capability?: string, userId?: number | null) {
  const specs = getModelSpecifications(), hidden = hiddenRouteModelIds(), disabled = new Set(specs.filter(s => !s.enabled).map(s => s.modelId));
  let exactPrice: ReturnType<typeof PricingService.createQuoteResolver> | undefined;
  return db.select().from(models).where(eq(models.isActive, 1)).all()
    .filter(model => !isRetiredVideoModel(model.modelId))
    .filter(model => model.modelId !== MJ_OVERFLOW_VIDEO_MODEL && !hidden.has(model.modelId) && !disabled.has(model.modelId))
    .filter(model => {
      if (!capability) return true;
      try {
        const capabilities = JSON.parse(model.capabilities || '[]');
        return Array.isArray(capabilities) && (capabilities.includes(capability) || capability === 'image' && capabilities.includes('image_gen'));
      } catch { return false; }
    })
    .filter(model => {
      if (model.provider !== ZHIYING_CHANNEL_TYPE) return true;
      const profile = configuredZhiyingProfile(model.modelId);
      if (!profile) return false;
      exactPrice ??= PricingService.createQuoteResolver(false, userId);
      const { limits } = profile;
      const defaultDuration = limits.defaultSeconds;
      const quote = exactPrice(model.modelId, { count: 1, resolution: limits.resolutions[0], seconds: defaultDuration });
      return (quote.billingType === 'per_call' || quote.billingType === 'per_second') && Number.isFinite(quote.cost) && quote.cost >= 0;
    })
    .map(model => model.provider === ZHIYING_CHANNEL_TYPE && isZhiyingVideoModel(model.modelId)
      ? { ...model, displayName: zhiyingVideoSpec(model.modelId).displayName } : model);
}
