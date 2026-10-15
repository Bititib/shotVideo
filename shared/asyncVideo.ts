import { defaultRoutingLimits, type ModelInputLimits } from './modelRouting.js';

export const ASYNC_VIDEO_CHANNEL_TYPE = 'async-video';
export const ASYNC_VIDEO_BASE_URL = 'http://38.76.169.75:8080';
export const VX_LE_SEEDANCE_MODEL = 'b_seedance_v2.0';

/** Confirmed by the channel owner; overrides generic discovery defaults. */
export function asyncVideoConfirmedLimits(name: string, limits: ModelInputLimits = defaultRoutingLimits()): ModelInputLimits {
  if (name !== VX_LE_SEEDANCE_MODEL) return limits;
  return { ...limits, minImages: 0, maxImages: 9, maxVideos: 0, maxAudios: 0, maxOutputs: 1,
    firstFrame: false, lastFrame: false, resolutions: ['default'],
    duration: { mode: 'fixed', min: 15, max: 15, step: 1, values: [] } };
}
export const asyncVideoPublicModelId = (channelId: number, name: string) => 'async-video-' + channelId + '-' + encodeURIComponent(name);
