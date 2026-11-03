import { defaultRoutingLimits, type ModelInputLimits } from './modelRouting.js';

export const V6K_STABLE_720_MODEL = 'wd-seedance2.5-720';
export const V6K_STABLE_720_UPSTREAM = '稳定seadanco2.5-720';
export const V6K_STABLE_720_DESCRIPTION = '30图10音10视/720P/5-30秒/10分钟出片/按条计费';
export function v6kStable720Limits(): ModelInputLimits {
  return { ...defaultRoutingLimits(), maxImages: 30, maxVideos: 10, maxAudios: 10, resolutions: ['720p'],
    duration: { mode: 'range', min: 5, max: 30, step: 1, values: [] } };
}
