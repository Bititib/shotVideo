import { defaultRoutingLimits, type ModelInputLimits } from './modelRouting.js';

export const KMAI_BASE_URL = 'https://kmai.us.ci';
export const KMAI_CHANNEL_TYPE = 'kmai';
export const KMAI_MJ_UPSTREAM_MODEL = 'mj_imagine';
export const KMAI_MJ_FAMILY = 'kmai-mj-imagine';
export const KMAI_MJ_MODEL_ID = KMAI_MJ_FAMILY + '-1k';

/** Documented 1K sizes; their long edge must stay below 1800 pixels. */
export const KMAI_MJ_SIZES: Record<string, string> = {
  '1:1': '1024x1024', '16:9': '1280x720', '9:16': '720x1280',
  '5:4': '1280x1024', '4:5': '1024x1280', '4:3': '1024x768', '3:4': '768x1024',
  '3:2': '1200x800', '2:3': '800x1200', '2:1': '1440x720', '21:9': '1680x720',
  '3:1': '1536x512', '1:3': '512x1536', '4:1': '1728x432', '1:4': '432x1728',
  '8:1': '1728x216', '1:8': '216x1728',
};

export function kmaiMjLimits(): ModelInputLimits {
  return { ...defaultRoutingLimits(), maxImages: 6, maxOutputs: 4, outputsPerTask: 4,
    resolutions: ['1K'], ratios: Object.keys(KMAI_MJ_SIZES) };
}
