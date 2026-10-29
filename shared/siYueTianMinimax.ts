import { defaultRoutingLimits, routingMismatches, type ModelInputLimits, type RoutingInput } from './modelRouting.js';

export const SI_YUE_TIAN_MINIMAX_MODEL = 'minimax-h3-2k';
export const SI_YUE_TIAN_MINIMAX_DESCRIPTION = 'MiniMax H3 · 四月天；固定2K、有声、4–15秒；最多9图/3视频/3音频，首尾帧与参考素材二选一；按条计费';
export const SI_YUE_TIAN_MINIMAX_PRICE = 2;
export function siYueTianMinimaxLimits(): ModelInputLimits {
  return { ...defaultRoutingLimits(), maxImages: 9, maxVideos: 3, maxAudios: 3,
    resolutions: ['2K'], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    duration: { mode: 'range', min: 4, max: 15, step: 1, values: [] }, firstFrame: true, lastFrame: true };
}
export function siYueTianMinimaxInputErrors(input: RoutingInput): string[] {
  const errors = routingMismatches(siYueTianMinimaxLimits(), input, 'video');
  if ((input.firstFrame || input.lastFrame) && (input.images || input.videos || input.audios))
    errors.push('首尾帧不能与参考图片、视频或音频混用');
  return errors;
}
export function isSiYueTianVideoHost(baseUrl: string): boolean {
  try { return ['llm.chre3.com', 'llm.domie.studio'].includes(new URL(baseUrl).hostname.toLowerCase()); }
  catch { return false; }
}
