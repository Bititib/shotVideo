import { publicApiModelId } from '../../shared/funAi.js';
import { resolvePublicModelId } from './publicModelNameService.js';
import { ChannelService } from './channelService.js';
import { filterUserModels } from './userModelAccessService.js';
import { getEnabledPublicModels } from './modelCatalogService.js';
import { getModelSpecifications, inspectModelRoutes } from './modelRoutingService.js';
import { createVideoAliasChecker } from './modelSaleService.js';
import { isReviewedPublicModel, reviewedPublicModelIds } from './publicModelMetadataService.js';
import { hasHmStudioOverflowChannel } from './hmStudioOverflowChannelService.js';
import { HM_STUDIO_PRIMARY_VIDEO_MODEL } from './videoFailoverService.js';

export function filterRoutableModels(modelIds: string[], activeChannels: Array<{ supportedModels: string[] }>): string[] {
  if (activeChannels.some(channel => channel.supportedModels.includes('*'))) return modelIds;
  const routable = new Set(activeChannels.flatMap(channel => channel.supportedModels));
  return modelIds.filter(id => routable.has(id));
}

/** Shared discovery policy for external API clients and the developer catalog. */
export function getAccessibleModels(token: { allowedModels: string[]; userId?: number | null }, includeLegacy = false) {
  const registeredModels = filterUserModels(token.userId, getEnabledPublicModels());
  const activeChannels = ChannelService.getActiveChannels().filter(channel => Boolean(channel.apiKey?.trim()));
  const specs = getModelSpecifications();
  const specMap = new Map(specs.map(spec => [spec.modelId, spec]));
  const routingChannels: Array<{ supportedModels: string[] }> = [...activeChannels];
  if (hasHmStudioOverflowChannel(activeChannels)) routingChannels.push({ supportedModels: [HM_STUDIO_PRIMARY_VIDEO_MODEL] });
  const checkAlias = createVideoAliasChecker();
  const routable = new Set(filterRoutableModels(registeredModels.map(model => model.modelId), routingChannels));
  const reviewed = reviewedPublicModelIds();
  return registeredModels.filter(model => isReviewedPublicModel(model, reviewed))
    .filter(model => {
      const publicId = publicApiModelId(model.modelId);
      if (includeLegacy || publicId === model.modelId) return true;
      try { return resolvePublicModelId(publicId) === model.modelId; } catch { return false; }
    })
    .filter(model => {
      const spec = specMap.get(model.modelId);
      return spec ? inspectModelRoutes(spec, undefined, activeChannels).some(route => !route.reasons.length) : routable.has(model.modelId);
    })
    .filter(model => (token.allowedModels.length === 0 || token.allowedModels.includes(model.modelId)
      || specMap.get(model.modelId)?.aliases.some(alias => token.allowedModels.includes(alias) && !checkAlias(specMap.get(model.modelId)!, alias))));
}

export function getAccessibleModelIds(token: { allowedModels: string[]; userId?: number | null }): string[] {
  return getAccessibleModels(token, true).map(model => model.modelId);
}

export function callableModelId(model: { modelId: string }): string {
  return publicApiModelId(model.modelId);
}
