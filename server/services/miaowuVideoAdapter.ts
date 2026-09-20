export interface MiaowuChannelLike {
  type?: string | null;
  baseUrl?: string | null;
}

export interface MiaowuVideoPayloadInput {
  model: string;
  prompt: string;
  seconds: number;
  ratio: string;
  resolution: string;
  imageUrls?: string[];
  videoUrls?: string[];
  audioUrls?: string[];
}

export interface NormalizedMiaowuVideoTask {
  status: string;
  progress: number;
  resultUrl: string;
  error: string;
}

const MIAOWU_HOSTNAME = 'api.miaowuai.store';
export const MIAOWU_SEEDANCE_25_DEAL_MODEL = 'seedance-2.5-deal';
export const MIAOWU_SEEDANCE_25_DEAL_MIN_SECONDS = 5;
export const MIAOWU_SEEDANCE_25_DEAL_MAX_SECONDS = 30;
export const MIAOWU_SEEDANCE_25_DEAL_MAX_IMAGES = 30;
export const MIAOWU_SEEDANCE_25_DEAL_MAX_AUDIOS = 10;
export const MIAOWU_SEEDANCE_25_DEAL_RESOLUTIONS = ['480p', '720p'] as const;
export const MIAOWU_SEEDANCE_25_PRO_MODEL = 'seedance-2.5-pro';
export const MIAOWU_DEFAULT_VIDEO_MODELS = [
  MIAOWU_SEEDANCE_25_DEAL_MODEL,
  MIAOWU_SEEDANCE_25_PRO_MODEL,
] as const;

export interface MiaowuSeedance25DealInput {
  seconds: number;
  resolution: string;
  imageCount: number;
  videoCount: number;
  audioCount: number;
}

export function validateMiaowuSeedance25DealInput(input: MiaowuSeedance25DealInput): string {
  if (!Number.isInteger(input.seconds)
    || input.seconds < MIAOWU_SEEDANCE_25_DEAL_MIN_SECONDS
    || input.seconds > MIAOWU_SEEDANCE_25_DEAL_MAX_SECONDS) {
    return `${MIAOWU_SEEDANCE_25_DEAL_MODEL} 仅支持 5–30 秒的整数时长`;
  }
  if (!(MIAOWU_SEEDANCE_25_DEAL_RESOLUTIONS as readonly string[]).includes(String(input.resolution).toLowerCase())) {
    return `${MIAOWU_SEEDANCE_25_DEAL_MODEL} 仅支持 480p 或 720p`;
  }
  if (input.imageCount > MIAOWU_SEEDANCE_25_DEAL_MAX_IMAGES) {
    return `${MIAOWU_SEEDANCE_25_DEAL_MODEL} 最多支持 30 张参考图片`;
  }
  if (input.videoCount > 0) {
    return `${MIAOWU_SEEDANCE_25_DEAL_MODEL} 不支持参考视频`;
  }
  if (input.audioCount > MIAOWU_SEEDANCE_25_DEAL_MAX_AUDIOS) {
    return `${MIAOWU_SEEDANCE_25_DEAL_MODEL} 最多支持 10 段参考音频`;
  }
  return '';
}

export interface MiaowuSeedance25ProInput {
  seconds: number;
  resolution: string;
  imageCount: number;
  videoCount: number;
  audioCount: number;
}

export function validateMiaowuSeedance25ProInput(input: MiaowuSeedance25ProInput): string {
  if (!Number.isInteger(input.seconds) || input.seconds < 4 || input.seconds > 30) {
    return `${MIAOWU_SEEDANCE_25_PRO_MODEL} 仅支持 4–30 秒的整数时长`;
  }
  if (!['480p', '720p'].includes(String(input.resolution).toLowerCase())) {
    return `${MIAOWU_SEEDANCE_25_PRO_MODEL} 仅支持 480p 或 720p`;
  }
  if (input.imageCount > 30) return `${MIAOWU_SEEDANCE_25_PRO_MODEL} 最多支持 30 张参考图片`;
  if (input.videoCount > 10) return `${MIAOWU_SEEDANCE_25_PRO_MODEL} 最多支持 10 个参考视频`;
  if (input.audioCount > 10) return `${MIAOWU_SEEDANCE_25_PRO_MODEL} 最多支持 10 段参考音频`;
  return '';
}

export function isMiaowuChannel(channel: MiaowuChannelLike | null | undefined): boolean {
  if (!channel) return false;
  if (String(channel.type || '').toLowerCase() === 'miaowu') return true;
  if (!channel.baseUrl) return false;
  try {
    return new URL(channel.baseUrl).hostname.toLowerCase() === MIAOWU_HOSTNAME;
  } catch {
    return false;
  }
}

/** Accept both https://host and https://host/v1 as the administrator-facing Base URL. */
export function miaowuApiBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
}

export function miaowuVideoCreateUrl(baseUrl: string): string {
  return `${miaowuApiBaseUrl(baseUrl)}/v1/videos`;
}

export function miaowuVideoTaskUrl(baseUrl: string, taskId: string): string {
  return `${miaowuVideoCreateUrl(baseUrl)}/${encodeURIComponent(taskId)}`;
}

export function miaowuVideoContentUrl(baseUrl: string, taskId: string): string {
  return `${miaowuVideoTaskUrl(baseUrl, taskId)}/content`;
}

export function miaowuVideoModelListUrl(baseUrl: string): string {
  return `${miaowuApiBaseUrl(baseUrl)}/v1/dream/model_list?type=video`;
}

export function buildMiaowuVideoPayload(input: MiaowuVideoPayloadInput): Record<string, unknown> {
  const imageUrls = input.imageUrls?.filter(Boolean) || [];
  const videoUrls = input.videoUrls?.filter(Boolean) || [];
  const audioUrls = input.audioUrls?.filter(Boolean) || [];
  return {
    model: input.model,
    prompt: input.prompt.trim(),
    seconds: input.seconds,
    ratio: input.ratio,
    resolution: input.resolution,
    ...(imageUrls.length > 0 ? { image_urls: imageUrls } : {}),
    ...(videoUrls.length > 0 ? { video_urls: videoUrls } : {}),
    ...(audioUrls.length > 0 ? { audio_urls: audioUrls } : {}),
  };
}

function errorMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    return String(candidate.message || candidate.detail || candidate.code || '');
  }
  return '';
}

function normalizeResultUrl(value: unknown): string {
  const raw = String(value || '').trim();
  // Some Miaowu responses wrap the media URL as a Markdown link. Passing the
  // whole `[url](url)` value to fetch produces a 400 from the object store.
  const markdownLink = raw.match(/^\[[^\]]*\]\((https?:\/\/[^\s)]+)\)$/i);
  return markdownLink?.[1] || raw;
}

export function normalizeMiaowuVideoTask(
  payload: Record<string, any>,
  baseUrl: string,
  taskId: string,
): NormalizedMiaowuVideoTask {
  const status = String(payload.status || '').toLowerCase();
  const rawProgress = payload.progress;
  const progress = rawProgress === undefined || rawProgress === null
    ? (status === 'completed' ? 100 : 0)
    : (typeof rawProgress === 'number' ? rawProgress : Number.parseInt(String(rawProgress), 10) || 0);
  const resultUrl = status === 'completed'
    ? normalizeResultUrl(payload.url || miaowuVideoContentUrl(baseUrl, taskId))
    : normalizeResultUrl(payload.url);
  return {
    status,
    progress,
    resultUrl,
    error: errorMessage(payload.error) || errorMessage(payload.failure_reason),
  };
}
