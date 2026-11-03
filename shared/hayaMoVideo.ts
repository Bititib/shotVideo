import { defaultRoutingLimits, type ModelInputLimits } from './modelRouting.js';

export const HAYA_MO_MODEL = 'Mo-Seedance-2.5-720p';
export const BB_HSS_MO_MIGRATION_KEY = 'bb_hss_mo_source_v1';
export const hayaMoLimits = (): ModelInputLimits => ({ ...defaultRoutingLimits(),
  maxImages: 30, maxVideos: 10, maxAudios: 10, maxReferences: 16,
  resolutions: ['720p'], ratios: ['auto', '1:1', '3:4', '4:3', '9:16', '16:9', '21:9'],
  duration: { mode: 'range', min: 5, max: 30, step: 1, values: [] },
});
