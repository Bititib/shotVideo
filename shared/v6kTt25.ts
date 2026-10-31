import { defaultRoutingLimits, type ModelInputLimits } from './modelRouting.js';

/** Exact V6K IDs/capabilities verified on 2026-10-31; customer rates explicitly requested. */
export const V6K_TT25_PRODUCTS = [
  { id: 'TTseadanco2.5-480', resolution: '480p', saleRate: .28, costRate: .21 },
  { id: 'TTseadanco2.5-720', resolution: '720p', saleRate: .4, costRate: .31 },
  { id: 'TTseadanco2.5-1080', resolution: '1080p', saleRate: .9, costRate: .85 },
] as const;

export function v6kTt25Product(model: string) {
  const id = model.replace(/^(?:ZH-|zongheng-)/, '');
  return V6K_TT25_PRODUCTS.find(product => product.id === id);
}

export function v6kTt25Limits(model: string): ModelInputLimits | null {
  const product = v6kTt25Product(model);
  return product ? { ...defaultRoutingLimits(), maxImages: 30, maxVideos: 10, maxAudios: 10,
    resolutions: [product.resolution], duration: { mode: 'range', min: 5, max: 30, step: 1, values: [] } } : null;
}

export function v6kTt25Description(model: string) {
  const product = v6kTt25Product(model);
  return product ? `30图10音10视/${product.resolution.toUpperCase()}/5-30秒/按秒计费` : '';
}
