/** Tombstones only: prevent old database records, aliases or wildcard routes reviving removed products. */
export const RETIRED_VIDEO_MODELS = ['wan3.0-video', 'wan3.0-video-prime'] as const;
export const RETIRED_VIDEO_MODEL_MESSAGE = '该视频模型已下架，不再接受新生成请求，本次未扣费';
export function isRetiredVideoModel(model: unknown): boolean {
  return typeof model === 'string' && (RETIRED_VIDEO_MODELS as readonly string[]).includes(model);
}
