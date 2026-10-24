import type { ModelInputLimits } from './modelRouting.js';

// Public BB Seedance model identity. HUSS' /models response remains
// authoritative for actual submissions.
export const HUSS_BB_PUBLIC_MODEL = 'bb-2.5-301010';
export const HUSS_BB_MODEL = 'bb-seedance2.5-301010';
export function hussKnownModelId(name: string | undefined): string | null {
  return [HUSS_BB_PUBLIC_MODEL, HUSS_BB_MODEL].includes(name?.trim() || '') ? HUSS_BB_PUBLIC_MODEL : null;
}
export function hussBbModelLimits(): ModelInputLimits {
  return {
    maxImages: 30, maxVideos: 10, maxAudios: 10, maxOutputs: 1, minImages: 0,
    resolutions: ['720p'], ratios: ['16:9','9:16','1:1'],
    duration: { mode: 'range', min: 10, max: 30, step: 1, values: [] },
    firstFrame: false, lastFrame: false, qualities: [],
  };
}
