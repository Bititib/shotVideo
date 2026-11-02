import { v6kTt25Product } from './v6kTt25.js';

/** Exact IDs requested by the administrator; do not substitute BBseadanco2.5-480 (no video references). */
export const V6K_TT_BB_FALLBACKS = [
  { primary: 'TTseadanco2.5-480', upstream: 'BBseadanco-480', resolution: '480p', costRate: 0.25 },
  { primary: 'TTseadanco2.5-720', upstream: 'BBseadanco-720', resolution: '720p', costRate: 0.35 },
] as const;
export const ttBbFallbackProduct = (model: string) => V6K_TT_BB_FALLBACKS.find(p => p.primary === v6kTt25Product(model)?.id);
export function isTtBbFallbackRoute(route: { executionModel: string; upstreamModel: string }) {
  return ttBbFallbackProduct(route.executionModel)?.upstream === route.upstreamModel;
}
