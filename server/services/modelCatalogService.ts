import { getModelSpecifications, hiddenRouteModelIds } from './modelRoutingService.js';
import { isRetiredVideoModel } from '../../shared/retiredVideoModels.js';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { models } from '../db/schema.js';
import { MJ_OVERFLOW_VIDEO_MODEL } from './videoFailoverService.js';

/** The admin-managed registry is authoritative for every public model list. */
export function getEnabledPublicModels(capability?: string) {
  const specs = getModelSpecifications(), hidden = hiddenRouteModelIds(), disabled = new Set(specs.filter(s => !s.enabled).map(s => s.modelId));
  return db.select().from(models).where(eq(models.isActive, 1)).all()
    .filter(model => !isRetiredVideoModel(model.modelId))
    .filter(model => model.modelId !== MJ_OVERFLOW_VIDEO_MODEL && !hidden.has(model.modelId) && !disabled.has(model.modelId))
    .filter(model => {
      if (!capability) return true;
      try {
        const capabilities = JSON.parse(model.capabilities || '[]');
        return Array.isArray(capabilities) && capabilities.includes(capability);
      } catch { return false; }
    });
}
