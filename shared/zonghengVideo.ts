/** Exact public IDs supplied by the user; durations/resolutions from the model cards. */
export const ZONGHENG_MODEL_PREFIX = 'ZH-';
export const LEGACY_ZONGHENG_MODEL_PREFIX = 'zongheng-';
/** Preserve old API/canvas IDs while publishing the new namespace. */
export function canonicalZonghengModelId(model: string): string {
  return model.startsWith(LEGACY_ZONGHENG_MODEL_PREFIX) ? ZONGHENG_MODEL_PREFIX + model.slice(LEGACY_ZONGHENG_MODEL_PREFIX.length) : model;
}
export const ZONGHENG_VIDEO_MODELS = [
  { id: 'Cseadanco2.5K', resolution: '720p', seconds: [10, 15, 20, 25, 30] },
  { id: 'Xminimex-h3', resolution: '2k', seconds: Array.from({ length: 11 }, (_, i) => i + 5) },
  { id: 'wan-1080', resolution: '1080p', seconds: [5, 10, 15, 20, 25, 30] },
  { id: 'A-SD2.0', resolution: '720p', seconds: [5, 10, 15] },
] as const;
export function getZonghengVideoSpec(model: string) {
  const canonical = canonicalZonghengModelId(model);
  const id = canonical.startsWith(ZONGHENG_MODEL_PREFIX) ? canonical.slice(ZONGHENG_MODEL_PREFIX.length) : canonical;
  return ZONGHENG_VIDEO_MODELS.find(spec => spec.id === id);
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
