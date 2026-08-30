const OMNI_VIDEO_EDIT_MODELS = new Set([
  'omni-flash-vref',
  'veo-omni-flash-video-edit',
]);

export function isOmniVideoEditModel(modelId: string): boolean {
  return OMNI_VIDEO_EDIT_MODELS.has(modelId);
}
