/** V6K model-square specifications checked on 2026-10-24. No retired-site models or prices. */
export const ZONGHENG_MODEL_PREFIX = 'ZH-';
export const LEGACY_ZONGHENG_MODEL_PREFIX = 'zongheng-';
/** Preserve old API/canvas IDs while publishing the new namespace. */
export function canonicalZonghengModelId(model: string): string {
  return model.startsWith(LEGACY_ZONGHENG_MODEL_PREFIX) ? ZONGHENG_MODEL_PREFIX + model.slice(LEGACY_ZONGHENG_MODEL_PREFIX.length) : model;
}
const SEEDANCE_25_REFERENCES = { images: 30, videos: 10, audios: 10 } as const;
const SEEDANCE_20_REFERENCES = { images: 9, videos: 3, audios: 3 } as const;
const seconds = (min: number, max: number) => Array.from({ length: max - min + 1 }, (_, i) => min + i);
export const ZONGHENG_VIDEO_MODELS = [
  ...['TTseadanco2.5-480', 'TTseadanco2.5-480YT'].map(id => ({ id, family: 'seedance', references: SEEDANCE_25_REFERENCES, resolution: '480p', seconds: seconds(5, 30) })),
  ...['TTseadanco2.5-720', 'TTseadanco2.5-720YT', 'TTseadanco2.5AT', 'JJsedanco2.54', 'JJseadanco2.52'].map(id => ({ id, family: 'seedance', references: SEEDANCE_25_REFERENCES, resolution: '720p', seconds: seconds(5, 30) })),
  ...['TTseadanco2.5-1080', 'TTseadanco2.5-1080YT'].map(id => ({ id, family: 'seedance', references: SEEDANCE_25_REFERENCES, resolution: '1080p', seconds: seconds(5, 30) })),
  ...['TTseadanco 2.0 Fast/480', 'TTseadanco2.0480'].map(id => ({ id, family: 'seedance', references: SEEDANCE_20_REFERENCES, resolution: '480p', seconds: seconds(5, 15) })),
  ...['TTseadanco 2.0 Fast/720', 'TTseadanco2.0-720', 'Asedanco2.05', 'Asedanco2.0', 'ASaedanco2.08', 'Aseadanco2.07'].map(id => ({ id, family: 'seedance', references: SEEDANCE_20_REFERENCES, resolution: '720p', seconds: seconds(5, 15) })),
  ...['XXsedanco2.0', 'JSadanco2.0'].map(id => ({ id, family: 'seedance', references: { images: 9, videos: 0, audios: 3 }, resolution: '720p', seconds: seconds(5, 15) })),
  { id: 'dola2.5', family: 'seedance', references: { images: 9, videos: 0, audios: 0 }, resolution: '720p', seconds: [5, 10, 15] },
  { id: 'dola2.0', family: 'seedance', references: { images: 9, videos: 0, audios: 0 }, resolution: '720p', seconds: [15] },
  ...['grok-imagine-1.5', 'grok--1.5'].map(id => ({ id, family: 'grok', references: { images: 5, videos: 0, audios: 0 }, resolution: '720p', seconds: seconds(5, 15), ratios: ['16:9', '9:16', '1:1'] })),
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
export function validateZonghengVideoRatio(model: string, ratio: string) {
  const spec = getZonghengVideoSpec(model);
  if (spec && 'ratios' in spec && !spec.ratios.includes(ratio)) throw new Error(spec.id + ' 仅支持比例 ' + spec.ratios.join('、'));
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
