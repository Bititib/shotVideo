import { desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { contents } from '../db/schema.js';
import type { DeveloperModelCatalog, DeveloperModelKind, DeveloperEndpoint } from '../../shared/developerModels.js';
import { TokenService } from './tokenService.js';
import { getAccessibleModels, callableModelId } from './modelAccessService.js';
import { getModelSpecification, specificationAvailable } from './modelRoutingService.js';
import { existingModelLimits } from './modelInputPresets.js';
import { PricingService } from './pricingService.js';
import { calculateVideoModelStatus } from './videoModelStatusService.js';
import { ChannelService } from './channelService.js';
import { hasHmStudioOverflowChannel } from './hmStudioOverflowChannelService.js';
import { HM_STUDIO_PRIMARY_VIDEO_MODEL } from './videoFailoverService.js';
import { publicApiModelMetadata } from './publicModelMetadataService.js';

export function getDeveloperModels(userId: number, tokenId: number): DeveloperModelCatalog {
  // Ownership is checked before looking up or validating any secret.
  const owned = TokenService.getTokenKeyForUser(tokenId, userId);
  const result = TokenService.validateToken(owned.tokenKey);
  if (!result.valid) throw Object.assign(new Error(result.error), { status: 403 });
  const token = result.token!;
  const models = getAccessibleModels(token);
  const activeChannels = ChannelService.getActiveChannels();
  const hmOverflow = hasHmStudioOverflowChannel(activeChannels);
  const prices = new Map(PricingService.getPublicPricingForModels(models.map(model => model.modelId), userId).map(price => [price.model, price]));
  return {
    token: { id: token.id, name: token.name || 'API Key', maskedKey: owned.tokenKey.slice(0, 6) + '****' + owned.tokenKey.slice(-4) },
    checkedAt: new Date().toISOString(),
    items: models.map(model => {
      let capabilities: string[] = [];
      try { const parsed = JSON.parse(model.capabilities); if (Array.isArray(parsed)) capabilities = parsed; } catch { /* unknown capability */ }
      const kinds: DeveloperModelKind[] = [...new Set(capabilities.map(value => value === 'image_gen' ? 'image' : value)
        .filter((value): value is DeveloperModelKind => ['text', 'image', 'video', 'tts'].includes(value)))];
      if (!kinds.length) kinds.push('other');
      const spec = getModelSpecification(model.modelId);
      const limits = spec?.limits || (kinds.includes('video') ? existingModelLimits(model.modelId, 'video')
        : kinds.includes('image') ? existingModelLimits(model.modelId, 'image') : null);
      const endpoints: DeveloperEndpoint[] = [];
      if (kinds.includes('text')) endpoints.push('/v1/chat/completions');
      if (kinds.includes('image')) {
        endpoints.push('/v1/images/generations');
        if (limits && limits.maxImages > 0) endpoints.push('/v1/images/edits');
      }
      if (kinds.includes('video')) endpoints.push('/v1/videos');
      const available = endpoints.length > 0 && (spec ? specificationAvailable(spec)
        : ChannelService.findChannelsForModel(model.modelId, activeChannels).some(channel => Boolean(channel.apiKey?.trim()) && (!kinds.includes('image') || channel.type !== 'hmstudio'))
          || (model.modelId === HM_STUDIO_PRIMARY_VIDEO_MODEL && hmOverflow));
      const price = prices.get(model.modelId);
      const recent = kinds.includes('video') ? db.select({ id: contents.id, status: contents.status, resultUrl: contents.resultUrl, createdAt: contents.createdAt })
        .from(contents).where(eq(contents.modelId, model.modelId)).orderBy(desc(contents.id)).limit(20).all() : [];
      return {
        ...publicApiModelMetadata(model, activeChannels.map(channel => channel.name || '')), canonicalId: callableModelId(model), kinds, endpoints, limits,
        // Explicit allowlist: never serialize upstream costs, routes or credentials.
        pricing: price ? { currency: price.currency, billing_type: price.billing_type, unit: price.unit,
          unit_price: price.unit_price, output_unit_price: price.output_unit_price, resolution_prices: price.resolution_prices } : null,
        available, health: kinds.includes('video') ? calculateVideoModelStatus(recent, available) : null,
      };
    }).filter(model => model.available),
  };
}
