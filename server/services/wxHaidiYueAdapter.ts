export const WX_HAIDIYUE_CHANNEL_TYPE = 'wx-haidiyue';
export const WX_HAIDIYUE_CHANNEL_NAME = 'wx-海底月渠道';
export const WX_HAIDIYUE_UPSTREAM_MODEL = 'sd2.5';
export const WX_HAIDIYUE_FACE_SPLIT_MODEL = 'sd2.5';
export const WX_HAIDIYUE_FACE_SPLIT_MODEL_NAME = WX_HAIDIYUE_FACE_SPLIT_MODEL;
export const WX_HAIDIYUE_FACE_SPLIT_PRICE = 2;
export const WX_HAIDIYUE_MULTIMODAL_MODEL = '2.5-s';
export const WX_HAIDIYUE_MULTIMODAL_MODEL_NAME = WX_HAIDIYUE_MULTIMODAL_MODEL;
export const WX_HAIDIYUE_MULTIMODAL_PRICE = 6;
export const WX_HAIDIYUE_MULTIMODAL_SECONDS = 30;
export const WX_HAIDIYUE_MULTIMODAL_MAX_IMAGES = 30;
export const WX_HAIDIYUE_MULTIMODAL_MAX_VIDEOS = 10;
export const WX_HAIDIYUE_MULTIMODAL_MAX_AUDIOS = 10;
export const WX_HAIDIYUE_MODELS = [
  WX_HAIDIYUE_FACE_SPLIT_MODEL,
  WX_HAIDIYUE_MULTIMODAL_MODEL,
] as const;

export type WxHaidiYueVideoPayloadInput = {
  model?: string;
  prompt: string;
  duration: number;
  aspectRatio: string;
  images?: string[];
  videos?: string[];
  audios?: string[];
  faceSplit?: unknown;
};

export type WxHaidiYueVideoValidationInput = {
  seconds: number;
  resolution: string;
  ratio: string;
  imageCount: number;
  videoCount: number;
  audioCount: number;
  hasFirstFrame?: boolean;
  hasLastFrame?: boolean;
};

export type NormalizedWxHaidiYueTask = {
  status: 'pending' | 'completed' | 'failed' | string;
  progress: number;
  resultUrl: string;
  error: string;
  errorCode: string;
};

export function isWxHaidiYueChannel(channel: { type?: string } | null | undefined): boolean {
  return channel?.type === WX_HAIDIYUE_CHANNEL_TYPE;
}

function apiRoot(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, '');
  return /\/v1$/i.test(root) ? root : `${root}/v1`;
}

export function wxHaidiYueCreateUrl(baseUrl: string): string {
  return `${apiRoot(baseUrl)}/videos/generations`;
}

export function wxHaidiYueTaskUrl(baseUrl: string, requestId: string): string {
  return `${apiRoot(baseUrl)}/videos/generations/${encodeURIComponent(requestId)}`;
}

/** Match the documented API semantics instead of JavaScript truthiness (for example, "false" is off). */
export function normalizeWxHaidiYueFaceSplit(value: unknown): boolean {
  return value === true || value === 1 || value === 'true' || value === '1';
}

/** Use the channel setting as the default while allowing an explicit request value to override it. */
export function resolveWxHaidiYueFaceSplit(
  channel: { faceSplitEnabled?: unknown } | null | undefined,
  requestValue?: unknown,
): boolean {
  if (requestValue !== undefined) return normalizeWxHaidiYueFaceSplit(requestValue);
  if (channel?.faceSplitEnabled === undefined || channel?.faceSplitEnabled === null) return true;
  return normalizeWxHaidiYueFaceSplit(channel.faceSplitEnabled);
}

export function validateWxHaidiYueVideoInput(
  model: string,
  input: WxHaidiYueVideoValidationInput,
): string | null {
  if (!WX_HAIDIYUE_MODELS.includes(model as typeof WX_HAIDIYUE_MODELS[number])) return null;
  const allowedRatios = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
  if (input.seconds !== 30) return `${model} 只支持30秒`;
  if (input.resolution !== '720p') return `${model} 只支持720p`;
  if (!allowedRatios.includes(input.ratio)) return `${model} 不支持比例 ${input.ratio}`;
  if (input.hasFirstFrame || input.hasLastFrame) return `${model} 不支持首尾帧参考`;
  if (model === WX_HAIDIYUE_MULTIMODAL_MODEL) {
    if (input.imageCount > WX_HAIDIYUE_MULTIMODAL_MAX_IMAGES) return `${model} 最多支持30张参考图片`;
    if (input.videoCount > WX_HAIDIYUE_MULTIMODAL_MAX_VIDEOS) return `${model} 最多支持10个参考视频`;
    if (input.audioCount > WX_HAIDIYUE_MULTIMODAL_MAX_AUDIOS) return `${model} 最多支持10段参考音频`;
    return null;
  }
  if (input.imageCount > 9) return `${model} 最多支持9张参考图片`;
  if (input.videoCount > 0 || input.audioCount > 0) return `${model} 不支持视频或音频参考`;
  return null;
}

export function buildWxHaidiYueVideoPayload(input: WxHaidiYueVideoPayloadInput): Record<string, unknown> {
  const images = (input.images || []).filter(Boolean);
  const videos = (input.videos || []).filter(Boolean);
  const audios = (input.audios || []).filter(Boolean);
  const faceSplit = input.faceSplit === undefined
    ? true
    : normalizeWxHaidiYueFaceSplit(input.faceSplit);
  return {
    model: input.model || WX_HAIDIYUE_UPSTREAM_MODEL,
    prompt: input.prompt,
    duration: input.duration,
    aspect_ratio: input.aspectRatio,
    ...(images.length === 1 ? { image: images[0] } : {}),
    ...(images.length > 1 ? { images } : {}),
    ...(videos.length ? { videos } : {}),
    ...(audios.length ? { audios } : {}),
    face_split: faceSplit,
  };
}

function resolveResultUrl(value: unknown, baseUrl: string): string {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url) return '';
  try {
    return new URL(url, `${apiRoot(baseUrl)}/`).toString();
  } catch {
    return url;
  }
}

export function normalizeWxHaidiYueTask(raw: any, baseUrl: string): NormalizedWxHaidiYueTask {
  const status = String(raw?.status || '').toLowerCase();
  const errorValue = raw?.error;
  const error = typeof errorValue === 'object' && errorValue
    ? String(errorValue.message || JSON.stringify(errorValue))
    : String(errorValue || '');
  const errorCode = typeof errorValue === 'object' && errorValue
    ? String(errorValue.code || '')
    : '';

  return {
    status: status === 'done' ? 'completed' : status,
    progress: status === 'done' ? 100 : 0,
    resultUrl: resolveResultUrl(raw?.video?.url || raw?.video_url || raw?.url, baseUrl),
    error,
    errorCode,
  };
}

/** Only send the channel credential to the API origin, never to a signed CDN URL. */
export function shouldSendWxHaidiYueAuthorization(targetUrl: string, baseUrl: string): boolean {
  try {
    return new URL(targetUrl, `${apiRoot(baseUrl)}/`).origin === new URL(apiRoot(baseUrl)).origin;
  } catch {
    return false;
  }
}
