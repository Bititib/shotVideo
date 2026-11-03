import { defaultRoutingLimits, routingMismatches, type RoutingInput } from './modelRouting.js';
import { SI_YUE_TIAN_MINIMAX_MODEL, SI_YUE_TIAN_MINIMAX_DESCRIPTION, SI_YUE_TIAN_MINIMAX_PRICE, siYueTianMinimaxLimits } from './siYueTianMinimax.js';

export const SI_YUE_TIAN_SEEDANCE_C4_MODEL = 'seedance-2.5-720p-c4';
export const SI_YUE_TIAN_MANAGED_VIDEO_MODELS = [SI_YUE_TIAN_MINIMAX_MODEL, SI_YUE_TIAN_SEEDANCE_C4_MODEL];
export function siYueTianManagedVideoSpec(model: string) {
  if (model === SI_YUE_TIAN_MINIMAX_MODEL) return { id: model, name: 'MiniMax H3 2K · 四月天',
    description: SI_YUE_TIAN_MINIMAX_DESCRIPTION, price: SI_YUE_TIAN_MINIMAX_PRICE, cost: 1,
    limits: siYueTianMinimaxLimits(), marker: 'catalog_siyuetian_minimax_h3_', route: 'siyuetian-minimax-', followImageRatio: true };
  // Four-month public /api/pricing catalog checked 2026-11-03; retail price confirmed by user.
  if (model === SI_YUE_TIAN_SEEDANCE_C4_MODEL) return { id: model, name: 'Seedance 2.5 720p C4 · 四月天',
    description: 'Seedance 2.5 C4 · 四月天；固定720p、有声、无水印、4–30秒；最多30图/10视频/10音频；首尾帧与参考素材二选一；支持自适应画幅；按条计费',
    price: 6, cost: 4, marker: 'catalog_siyuetian_seedance_c4_', route: 'siyuetian-seedance-c4-', followImageRatio: false,
    limits: { ...defaultRoutingLimits(), maxImages: 30, maxVideos: 10, maxAudios: 10, firstFrame: true, lastFrame: true,
      resolutions: ['720p'], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'],
      duration: { mode: 'range' as const, min: 4, max: 30, step: 1, values: [] } } };
  return null;
}
export function isSiYueTianManagedVideoModel(model: unknown): boolean {
  return typeof model === 'string' && SI_YUE_TIAN_MANAGED_VIDEO_MODELS.includes(model);
}
export function siYueTianManagedVideoInputErrors(model: string, input: RoutingInput): string[] {
  const spec = siYueTianManagedVideoSpec(model);
  if (!spec) return ['未配置此四月天视频型号'];
  const errors = routingMismatches(spec.limits, input, 'video');
  if ((input.firstFrame || input.lastFrame) && (input.images || input.videos || input.audios)) errors.push('首尾帧不能与参考图片、视频或音频混用');
  return errors;
}
