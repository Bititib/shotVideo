/** User confirmed on 2026-10-30: NSFW uses the standard snumom WAN3 parameters. */
export const SNUMOM_WAN_NSFW_MODEL = 'wan3.0-video-nsfw';
export const SNUMOM_OUTPUT_ONLY_MODELS = {
  'wan3.0-video-1080': { resolution:'1080p', seconds:Array.from({length:26},(_,i)=>i+5) },
  'wan3.0-video-prime-1080': { resolution:'1080p', seconds:[15,30] },
  'wan3.0-video-prime-720': { resolution:'720p', seconds:[15,30] },
} as const;
export function snumomOutputOnlySpec(model:string) {
  return Object.prototype.hasOwnProperty.call(SNUMOM_OUTPUT_ONLY_MODELS,model)
    ? SNUMOM_OUTPUT_ONLY_MODELS[model as keyof typeof SNUMOM_OUTPUT_ONLY_MODELS] : undefined;
}
export function isSnumomWanVideoModel(model: string): boolean {
  return model === SNUMOM_WAN_NSFW_MODEL || Boolean(snumomOutputOnlySpec(model));
}
export function supportsSnumomSmartDuration(model: string): boolean {
  return model === SNUMOM_WAN_NSFW_MODEL;
}
