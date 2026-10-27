/** Initial catalog from the supplied Haya model cards, not a permanent upstream catalog. */
export const HAYA_BASE_URL = 'https://hayaai.fun';
export const HAYA_XG_SEEDANCE_20_MODEL = 'Seedance-2.0-720';
export const HAYA_XG_SEEDANCE_20_UPSTREAM_MODEL = 'XG-Seedance-2.0-720';
export function hayaPublicModelId(id: string): string {
  return id === HAYA_XG_SEEDANCE_20_UPSTREAM_MODEL ? HAYA_XG_SEEDANCE_20_MODEL : id;
}
export function hayaUpstreamModelId(id: string): string {
  return id === HAYA_XG_SEEDANCE_20_MODEL ? HAYA_XG_SEEDANCE_20_UPSTREAM_MODEL : id;
}
export const HAYA_XG_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const;
// For F/XG, 30/10/10 are application intake caps, not verified upstream capabilities.
// Y cards say "free duration"; 4–30 seconds is the current application range.
export const HAYA_VIDEO_MODELS = [
  { id: 'bz-seedance2.5-720p', resolution: '720p', price: 6.5, billingType: 'per_call', maxImages: 30, maxVideos: 10, maxAudios: 10, confirmedMediaLimits: true },
  { id: 'F-seedance-2.5-480p', resolution: '480p', price: 5, billingType: 'per_call', maxImages: 30, maxVideos: 10, maxAudios: 10, confirmedMediaLimits: false },
  { id: 'F-seedance-2.5-720p', resolution: '720p', price: 5, billingType: 'per_call', maxImages: 30, maxVideos: 10, maxAudios: 10, confirmedMediaLimits: false },
  { id: 'XG-seedance-2.5-720', resolution: '720p', price: 0.5, billingType: 'per_second', maxImages: 30, maxVideos: 10, maxAudios: 10, confirmedMediaLimits: false },
  { id: 'y-seedance-2.5-1080p', resolution: '1080p', price: 13, billingType: 'per_call', maxImages: 30, maxVideos: 0, maxAudios: 10, confirmedMediaLimits: true },
  { id: 'y-seedance-2.5-480p', resolution: '480p', price: 5, billingType: 'per_call', maxImages: 30, maxVideos: 0, maxAudios: 10, confirmedMediaLimits: true },
  { id: 'y-seedance-2.5-720p', resolution: '720p', price: 7, billingType: 'per_call', maxImages: 30, maxVideos: 0, maxAudios: 10, confirmedMediaLimits: true },
  // Media counts confirmed by the user; the API tab's no-video note conflicts with the model card.
  { id: HAYA_XG_SEEDANCE_20_MODEL, resolution: '720p', price: 4, billingType: 'per_call', maxImages: 9, maxVideos: 3, maxAudios: 3, confirmedMediaLimits: true },
] as const;

export const HAYA_MODEL_IDS: readonly string[] = HAYA_VIDEO_MODELS.map(spec => spec.id);
export const HAYA_SECONDS = Array.from({ length: 27 }, (_, index) => index + 4);
export function getHayaVideoSpec(id: string) { return HAYA_VIDEO_MODELS.find(spec => spec.id === hayaPublicModelId(id)); }
export function hayaVideoSeconds(id: string): number[] {
  return hayaPublicModelId(id) === HAYA_XG_SEEDANCE_20_MODEL ? Array.from({ length: 11 }, (_, index) => index + 5) : HAYA_SECONDS;
}

export function validateHayaVideoInput(model: string, input: {
  seconds: number; resolution: string; ratio: string; imageCount: number; videoCount: number; audioCount: number;
  firstFrame?: unknown; lastFrame?: unknown; metadata?: Record<string, unknown>;
}): string | null {
  const spec = getHayaVideoSpec(model);
  if (!spec) return 'Haya 模型尚未配置能力，请先核对模型 ID';
  model = spec.id;
  const seconds = hayaVideoSeconds(model);
  if (!seconds.includes(input.seconds)) return `${model} 支持 ${seconds[0]}–${seconds.at(-1)} 秒整数时长`;
  if (model === HAYA_XG_SEEDANCE_20_MODEL) {
    if (!(HAYA_XG_RATIOS as readonly string[]).includes(input.ratio)) return `${model} 支持比例 ${HAYA_XG_RATIOS.join('、')}`;
    if (input.metadata?.content !== undefined) return '此模型的参考素材不能放在 metadata.content，请使用参考图片、视频和音频参数';
  }
  if (input.resolution !== spec.resolution) return `${model} 仅支持 ${spec.resolution}`;
  if (!/^\d+:\d+$/.test(input.ratio) || input.ratio.split(':').some(n => Number(n) <= 0)) return '视频比例格式不正确';
  if (input.firstFrame || input.lastFrame) return 'Haya 通用协议未定义首尾帧，请使用普通参考图片';
  if (input.videoCount && !spec.maxVideos) return `${model} 不支持参考视频`;
  if (input.imageCount > spec.maxImages || input.videoCount > spec.maxVideos || input.audioCount > spec.maxAudios) {
    return `本站最多接收 ${spec.maxImages} 张图片、${spec.maxVideos} 个视频、${spec.maxAudios} 段音频，实际能力以模型详情为准`;
  }
  return null;
}
