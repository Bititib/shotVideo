/** Confirmed by snumom /api/pricing on 2026-11-03, not inferred from WAN. */
export const SNUMOM_MUSE_MODEL = 'muse-video';
export const SNUMOM_MUSE_CATALOG = {
  modelId: SNUMOM_MUSE_MODEL,
  provider: 'snumom',
  displayName: 'Muse Video',
  description: '720P；固定10秒；最多8张参考图；按次计费，售价由管理员配置。',
  capabilities: JSON.stringify(['video']),
  isActive: 0,
} as const;

// User confirmed the existing snumom request/query protocol on 2026-11-03.
export const SNUMOM_MUSE_CONFIRMED = {
  resolution: '720p', seconds: 10, maxImages: 8, billingType: 'per_call',
  endpointType: 'openai-video',
} as const;
export const SNUMOM_MUSE_RATIOS = ['16:9','9:16','1:1','4:3','3:4','21:9','adaptive'];
