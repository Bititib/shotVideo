export const WX_HAIDIYUE_CHANNEL_TYPE = 'wx-haidiyue';
export const WX_HAIDIYUE_CHANNEL_NAME = 'wx-海底月 sd2.5 渠道';
export const WX_HAIDIYUE_UPSTREAM_MODEL = 'sd2.5';
export const WX_HAIDIYUE_FACE_SPLIT_MODEL = 'sd2.5-haidiyue-face';
export const WX_HAIDIYUE_FACE_SPLIT_MODEL_NAME = 'sd2.5';
export const WX_HAIDIYUE_FACE_SPLIT_PRICE = 2;

export type WxHaidiYueVideoPayloadInput = {
  prompt: string;
  duration: number;
  aspectRatio: string;
  images?: string[];
  faceSplit?: unknown;
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

export function buildWxHaidiYueVideoPayload(input: WxHaidiYueVideoPayloadInput): Record<string, unknown> {
  const images = (input.images || []).filter(Boolean);
  const faceSplit = input.faceSplit === undefined
    ? true
    : normalizeWxHaidiYueFaceSplit(input.faceSplit);
  return {
    model: WX_HAIDIYUE_UPSTREAM_MODEL,
    prompt: input.prompt,
    duration: input.duration,
    aspect_ratio: input.aspectRatio,
    ...(images.length === 1 ? { image: images[0] } : {}),
    ...(images.length > 1 ? { images } : {}),
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
