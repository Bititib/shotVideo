import { sqlite } from '../db/index.js';
import { isZhiyingVideoModel, zhiyingVideoSpec } from '../../shared/zhiyingVideo.js';
import type { ZhiyingModelProfile } from '../../shared/zhiyingModelConfiguration.js';
import { zhiyingBindings } from './zhiyingModelBindings.js';

export function isConfiguredZhiyingModel(id: unknown): id is string {
  return isZhiyingVideoModel(id) || typeof id === 'string' && id.startsWith('Lx-') && zhiyingBindings(sqlite).some(row => row.modelId === id);
}
export function builtinZhiyingProfile(id: string): ZhiyingModelProfile | undefined {
  if (!isZhiyingVideoModel(id)) return;
  const { limits, promptMax } = zhiyingVideoSpec(id);
  return { limits, promptMax, videoDurationTotal: id === 'sd-2.5-fullblood',
    fileMaxBytes: { image: 20 * 1024 ** 2, video: 100 * 1024 ** 2, audio: 100 * 1024 ** 2 },
    referenceMode: true, directProcessing: true };
}
export function configuredZhiyingProfile(modelId: string, channelId?: number, upstreamModel?: string) {
  if (isZhiyingVideoModel(modelId)) return upstreamModel === undefined || upstreamModel === modelId ? builtinZhiyingProfile(modelId) : undefined;
  // Administrator-created IDs are validated as Lx- at registration. Other channels do not consult this registry.
  if (typeof modelId !== 'string' || !modelId.startsWith('Lx-')) return;
  const binding = zhiyingBindings(sqlite).find(row => row.modelId === modelId
    && (channelId === undefined || row.channelId === channelId));
  if (binding) return upstreamModel === undefined || upstreamModel === binding.upstreamModel ? binding.profile : undefined;
  return undefined;
}
