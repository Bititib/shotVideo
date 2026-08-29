export const SNUMOM_BASE_URL = 'https://snumom.com';
export const SNUMOM_CHANNEL_TYPE = 'snumom';

export interface SnumomChannelLike {
  type?: string | null;
  baseUrl?: string | null;
}

export interface SnumomWanPayloadInput {
  model: string;
  prompt: string;
  seconds: number;
  resolution: string;
  aspectRatio: string;
  images?: Array<{ url: string; role?: 'reference_image' | 'first_frame' | 'last_frame' }>;
  videos?: Array<{ url: string; duration?: number }>;
  audios?: Array<{ url: string }>;
}

export function isSnumomWanChannel(channel: SnumomChannelLike | null | undefined): boolean {
  if (channel?.type === SNUMOM_CHANNEL_TYPE) return true;
  if (!channel?.baseUrl) return false;
  try {
    return new URL(channel.baseUrl).hostname.toLowerCase() === 'snumom.com';
  } catch {
    return false;
  }
}

export function normalizeSnumomResolution(resolution: string): '480P' | '720P' | '1080P' {
  const value = String(resolution || '').toUpperCase();
  if (value === '480P' || value === '1080P') return value;
  return '720P';
}

export function buildSnumomWanPayload(input: SnumomWanPayloadInput): Record<string, unknown> {
  const images = (input.images || []).filter(item => item?.url);
  const videos = (input.videos || []).filter(item => item?.url);
  const audios = (input.audios || []).filter(item => item?.url);
  return {
    model: input.model,
    prompt: input.prompt.trim(),
    seconds: input.seconds,
    size: normalizeSnumomResolution(input.resolution),
    aspect_ratio: input.aspectRatio,
    ...(images.length ? { reference_images: images } : {}),
    ...(videos.length ? { reference_videos: videos } : {}),
    ...(audios.length ? { reference_audios: audios } : {}),
  };
}

export function normalizeSnumomWanTask(payload: any) {
  return {
    id: String(payload?.id || payload?.task_id || ''),
    status: String(payload?.status || '').toLowerCase(),
    progress: Number(payload?.progress || 0),
    resultUrl: String(payload?.metadata?.url || payload?.video_url || payload?.result_url || payload?.url || ''),
    error: String(payload?.message || payload?.error?.message || payload?.error || ''),
  };
}

export function snumomContentUrl(baseUrl: string, taskId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/videos/${encodeURIComponent(taskId)}/content`;
}
