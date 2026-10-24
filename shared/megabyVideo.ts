import { defaultRoutingLimits, type ModelInputLimits } from './modelRouting.js';

export const MEGABY_CHANNEL_TYPE = 'megaby';
export const MEGABY_BASE_URL = 'https://newapi.megabyai.cc';
export const MEGABY_VIDEO_MODELS = ['videos-standard', 'videos-fast', 'videos-mini'] as const;
export const megabyPublicModelId = (name: string) => name;

export function megabyVideoLimits(): ModelInputLimits {
  return { ...defaultRoutingLimits(), maxImages: 9, maxVideos: 3, maxAudios: 3,
    resolutions: ['720p', '480p'], duration: { mode: 'range', min: 4, max: 15, step: 1, values: [] } };
}
