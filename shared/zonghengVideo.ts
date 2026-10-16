/** Exact public IDs supplied by the user; durations/resolutions from the model cards. */
export const ZONGHENG_MODEL_PREFIX = 'ZH-';
export const LEGACY_ZONGHENG_MODEL_PREFIX = 'zongheng-';
/** Preserve old API/canvas IDs while publishing the new namespace. */
export function canonicalZonghengModelId(model: string): string {
  return model.startsWith(LEGACY_ZONGHENG_MODEL_PREFIX) ? ZONGHENG_MODEL_PREFIX + model.slice(LEGACY_ZONGHENG_MODEL_PREFIX.length) : model;
}
const SEEDANCE_25_REFERENCES = { images: 30, videos: 10, audios: 10 } as const;
export const ZONGHENG_VIDEO_MODELS = [
  { id: 'Cseadanco2.5K', family: 'seedance', references: SEEDANCE_25_REFERENCES, resolution: '720p', seconds: [10, 15, 20, 25, 30] },
  { id: 'Xminimex-h3', family: 'minimax', resolution: '2k', seconds: Array.from({ length: 11 }, (_, i) => i + 5) },
  { id: 'wan-1080', family: 'wan', resolution: '1080p', seconds: [5, 10, 15, 20, 25, 30] },
  { id: 'sedanco2.0-300秒必出', family: 'seedance', references: { images: 9, videos: 0, audios: 3 }, resolution: '720p', seconds: [15] },
  { id: 'A-SD2.0', family: 'seedance', resolution: '720p', seconds: [5, 10, 15] },
  { id: 'kksedanco2.5', family: 'seedance', references: SEEDANCE_25_REFERENCES, resolution: '720p', seconds: Array.from({ length: 26 }, (_, i) => i + 5) },
  { id: 'LLseadanco2.51', family: 'seedance', references: SEEDANCE_25_REFERENCES, resolution: '720p', seconds: Array.from({ length: 25 }, (_, i) => i + 6) },
  { id: 'TTsedanco2.5-480', family: 'seedance', references: SEEDANCE_25_REFERENCES, resolution: '480p', seconds: Array.from({ length: 26 }, (_, i) => i + 5) },
  { id: 'TTseadanco2.5-720', family: 'seedance', references: SEEDANCE_25_REFERENCES, resolution: '720p', seconds: Array.from({ length: 26 }, (_, i) => i + 5) },
  { id: 'KKseadanco2.5X', family: 'seedance', references: SEEDANCE_25_REFERENCES, resolution: '720p', seconds: Array.from({ length: 26 }, (_, i) => i + 5) },
  { id: 'MMseadanco2.5-PRO', family: 'seedance', references: SEEDANCE_25_REFERENCES, resolution: '720p', seconds: Array.from({ length: 26 }, (_, i) => i + 5) },
] as const;
export function getZonghengVideoSpec(model: string) {
  const canonical = canonicalZonghengModelId(model);
  const id = canonical.startsWith(ZONGHENG_MODEL_PREFIX) ? canonical.slice(ZONGHENG_MODEL_PREFIX.length) : canonical;
  return ZONGHENG_VIDEO_MODELS.find(spec => spec.id === id);
}
/** Confirmed reference limits; other families retain their existing capabilities. */
export function getZonghengVideoReferenceLimits(model: string) {
  const spec = getZonghengVideoSpec(model);
  return spec && 'references' in spec ? spec.references : undefined;
}
export function validateZonghengVideoReferences(model: string, counts: { images: number; videos: number; audios: number }) {
  const limits = getZonghengVideoReferenceLimits(model);
  if (limits && (counts.images > limits.images || counts.videos > limits.videos || counts.audios > limits.audios)) {
    throw new Error(model + ' 最多支持 ' + limits.images + ' 张图片、' + limits.videos + ' 个视频、' + limits.audios + ' 段音频参考');
  }
}
export function normalizeZonghengVideoResolution(model: string, resolution: unknown): string | undefined {
  const spec = getZonghengVideoSpec(model);
  return spec ? String(resolution || spec.resolution).trim().toLowerCase() : undefined;
}
export function validateZonghengVideoSpec(model: string, seconds: number, resolution: string) {
  const spec = getZonghengVideoSpec(model);
  if (!spec) return;
  if (!(spec.seconds as readonly number[]).includes(seconds)) throw new Error(spec.id + ' 仅支持 ' + spec.seconds.join('、') + ' 秒');
  if (resolution.toLowerCase() !== spec.resolution) throw new Error(spec.id + ' 仅支持 ' + spec.resolution);
}
