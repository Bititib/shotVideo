import type { ModelInputLimits } from './modelRouting.js';

// Initial capability draft from the user-supplied BlobDraw model card.
// Authenticated /models remains authoritative for actual submissions.
export const BLOB_DRAW_BB_MODEL = 'bb-2.5-301010';
export const HUSS_BB_MODEL = 'bb-seedance2.5-301010';
export function blobDrawKnownModelId(name: string | undefined): string | null {
  return [BLOB_DRAW_BB_MODEL, HUSS_BB_MODEL].includes(name?.trim() || '') ? BLOB_DRAW_BB_MODEL : null;
}
export function blobDrawBbModelLimits(): ModelInputLimits {
  return {
    maxImages: 30, maxVideos: 10, maxAudios: 10, maxOutputs: 1, minImages: 0,
    resolutions: ['720p'], ratios: ['16:9','9:16','1:1','4:3','3:4','21:9'],
    duration: { mode: 'range', min: 4, max: 30, step: 1, values: [] },
    firstFrame: false, lastFrame: false, qualities: [],
  };
}
