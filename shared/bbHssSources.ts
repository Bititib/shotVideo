import { bbHssKkLimits } from './bbHssKk.js';
import { HUSS_BB_A_MODEL, HUSS_HSS_B_MODEL, hussBbAModelLimits, hussHssModelLimits } from './hussBbVideo.js';
import { V6K_KK25_MODEL } from './zonghengVideo.js';

export const BB_HSS_SOURCE_KEY = 'bb_hss_video_sources_v1';
export const BB_HSS_SOURCES = {
  KK: { label: 'KK', type: 'zongheng-v6k', upstreamModel: V6K_KK25_MODEL, limits: bbHssKkLimits },
  A: { label: 'HUSS 渠道 A', type: 'huss', upstreamModel: HUSS_BB_A_MODEL, limits: hussBbAModelLimits },
  B: { label: 'HUSS 渠道 B', type: 'huss', upstreamModel: HUSS_HSS_B_MODEL, limits: hussHssModelLimits },
} as const;
export type BbHssSource = keyof typeof BB_HSS_SOURCES;
export type BbHssSourceSelection = { source: BbHssSource; channelId: number };
