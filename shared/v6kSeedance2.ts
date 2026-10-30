import { defaultRoutingLimits, type ModelInputLimits } from './modelRouting.js';

/** User-approved sale IDs and prices; upstream capabilities checked on 2026-10-30. */
export const V6K_SEEDANCE_20_MODEL = 'zh-seedance.2.0';
export const V6K_XX_SEEDANCE_20_MODEL = 'XXsedanco2.0';
export const V6K_SEEDANCE_20_PRODUCTS = [
  { id: V6K_SEEDANCE_20_MODEL, description: '9图3音3视/720P/5-15秒/按条计费', maxVideos: 3,
    upstreamModels: [{ id: 'Asedanco2.0', cost: 2.5 }, { id: 'Asedanco2.05', cost: 3 }] },
  { id: V6K_XX_SEEDANCE_20_MODEL, description: '9图3音/720P/5-15秒/不支持参考视频/按条计费', maxVideos: 0,
    upstreamModels: [{ id: 'XXsedanco2.0', cost: 3 }] },
] as const;

export function v6kSeedance20Product(upstreamModel: string) {
  return V6K_SEEDANCE_20_PRODUCTS.find(product => product.upstreamModels.some(model => model.id === upstreamModel));
}

export function v6kSeedance20Limits(model: string): ModelInputLimits | null {
  const product = V6K_SEEDANCE_20_PRODUCTS.find(product => product.id === model) || v6kSeedance20Product(model);
  return product ? { ...defaultRoutingLimits(), maxImages: 9, maxAudios: 3, maxVideos: product.maxVideos,
    resolutions: ['720p'], duration: { mode: 'range', min: 5, max: 15, step: 1, values: [] } } : null;
}
