const OMNI_VIDEO_EDIT_MODELS = new Set([
  'omni-flash-vref',
  'veo-omni-flash-video-edit',
]);

export const SNUMOM_GROK_IMAGINE_VIDEO_MODEL = 'grok-imagine-video-1.5（按次）';
export const SNUMOM_SD_MINI_MODEL = 'sd-mini';
export const WX_HAIDIYUE_FACE_SPLIT_MODEL = 'sd2.5-haidiyue-face';

export function isOmniVideoEditModel(modelId: string): boolean {
  return OMNI_VIDEO_EDIT_MODELS.has(modelId);
}

export function isSnumomGrokImagineVideoModel(modelId: string): boolean {
  return modelId === SNUMOM_GROK_IMAGINE_VIDEO_MODEL;
}

export function snumomSdMiniSecondsForResolution(resolution: string): 10 | 15 {
  return String(resolution).toLowerCase() === '480p' ? 15 : 10;
}
