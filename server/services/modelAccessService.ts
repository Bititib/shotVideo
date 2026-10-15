import { ChannelService } from './channelService.js';
import { getEnabledPublicModels } from './modelCatalogService.js';
import { getModelSpecifications, getModelSpecification } from './modelRoutingService.js';
import { createVideoAliasChecker } from './modelSaleService.js';
import { publicModelName } from './publicModelNameService.js';
import { hasHmStudioOverflowChannel } from './hmStudioOverflowChannelService.js';
import { HM_STUDIO_PRIMARY_VIDEO_MODEL } from './videoFailoverService.js';

export function filterRoutableModels(modelIds: string[], activeChannels: Array<{ supportedModels: string[] }>): string[] {
  if (activeChannels.some(channel => channel.supportedModels.includes('*'))) return modelIds;
  const routable = new Set(activeChannels.flatMap(channel => channel.supportedModels));
  return modelIds.filter(id => routable.has(id));
}

/** Shared discovery policy for external API clients and the developer catalog. */
export function getAccessibleModels(token: { allowedModels: string[] }) {
  const registeredModels = getEnabledPublicModels();
  const activeChannels = ChannelService.getActiveChannels();
  const specs = getModelSpecifications();
  const routingChannels: Array<{ supportedModels: string[] }> = [...activeChannels, ...specs.map(spec => ({ supportedModels: [spec.modelId] }))];
  if (hasHmStudioOverflowChannel(activeChannels)) routingChannels.push({ supportedModels: [HM_STUDIO_PRIMARY_VIDEO_MODEL] });
  const checkAlias = createVideoAliasChecker();
  const routable = new Set(filterRoutableModels(registeredModels.map(model => model.modelId), routingChannels));
  const specMap = new Map(specs.map(spec => [spec.modelId, spec]));
  return registeredModels.filter(model => routable.has(model.modelId)
    && (token.allowedModels.length === 0 || token.allowedModels.includes(model.modelId)
      || specMap.get(model.modelId)?.aliases.some(alias => token.allowedModels.includes(alias) && !checkAlias(specMap.get(model.modelId)!, alias))));
}

export function getAccessibleModelIds(token: { allowedModels: string[] }): string[] {
  return getAccessibleModels(token).map(model => model.modelId);
}

export function callableModelId(model: Parameters<typeof publicModelName>[0]): string {
  return getModelSpecification(model.modelId) ? model.modelId : publicModelName(model);
}
