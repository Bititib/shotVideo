export const SNUMOM_BASE_URL = 'https://snumom.com';
export const SNUMOM_CHANNEL_TYPE = 'snumom';
export const SNUMOM_GROK_IMAGINE_VIDEO_MODEL = 'grok-imagine-video-1.5';
export const SNUMOM_GROK_IMAGINE_VIDEO_LEGACY_MODEL = 'grok-imagine-video-1.5（按次）';
export const SNUMOM_GROK_IMAGINE_VIDEO_SECONDS = Array.from({ length: 15 }, (_, index) => index + 1);
export const SNUMOM_GROK_IMAGINE_VIDEO_MAX_IMAGES = 7;
export const SNUMOM_SD_MINI_MODEL = 'sd-mini';
export const SNUMOM_SD_MINI_SECONDS = [10, 15] as const;
export const SNUMOM_SD_MINI_MAX_IMAGES = 9;
export const SNUMOM_SD_MINI_MAX_VIDEOS = 3;
export const SNUMOM_SD_MINI_MAX_AUDIOS = 3;
export const SNUMOM_VIDEO_MODELS = [
  'wan3.0-video',
  'wan3.0-video-prime',
  SNUMOM_GROK_IMAGINE_VIDEO_MODEL,
  SNUMOM_SD_MINI_MODEL,
] as const;

export function canonicalSnumomVideoModel(model: string): string {
  return model === SNUMOM_GROK_IMAGINE_VIDEO_LEGACY_MODEL ? SNUMOM_GROK_IMAGINE_VIDEO_MODEL : model;
}

export function isSnumomWan30VideoModel(model: string): boolean {
  return model === 'wan3.0-video' || model === 'wan3.0-video-prime';
}

export function snumomWanBillableSeconds(model: string, outputSeconds: number, referenceVideoSeconds = 0): number {
  const output = Number(outputSeconds);
  const references = Number(referenceVideoSeconds);
  if (!Number.isFinite(output) || output < 0 || !Number.isFinite(references) || references < 0) {
    throw new Error('snumom billable seconds must be non-negative finite numbers');
  }
  return output + (isSnumomWan30VideoModel(model) ? references : 0);
}

export function snumomSdMiniSecondsForResolution(resolution: string): 10 | 15 | null {
  const normalized = String(resolution || '').toLowerCase();
  if (normalized === '480p') return 15;
  if (normalized === '720p') return 10;
  return null;
}

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
  smartDuration?: boolean;
  promptExtend?: boolean;
  inputMedia?: Array<{ type: 'file' | 'link'; url: string }>;
}

export interface SnumomWanBillingUsage {
  billableSeconds: number;
  outputSeconds?: number;
  referenceVideoSeconds?: number;
  resolution?: '480p' | '720p' | '1080p';
}

export function normalizeSnumomWanInputMedia(value: unknown): Array<{ type: 'file' | 'link'; url: string }> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('input.media must be an array');
  if (value.length > 1) throw new Error('Wan 3.0 supports at most one file or link reference');
  return value.map(item => {
    if (!item || typeof item !== 'object') throw new Error('input.media items must be objects');
    const type = String((item as any).type || '').toLowerCase();
    if (type !== 'file' && type !== 'link') throw new Error('input.media type must be file or link');
    const url = String((item as any).url || '').trim();
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('input.media url must be a public HTTPS URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.hostname === 'localhost' || /^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(parsed.hostname)) {
      throw new Error('input.media url must be a public HTTP(S) URL');
    }
    return { type, url } as { type: 'file' | 'link'; url: string };
  });
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
  const normalizedModel = canonicalSnumomVideoModel(input.model);
  const normalizedResolution = normalizeSnumomResolution(input.resolution);
  const frameMode = isSnumomWan30VideoModel(normalizedModel)
    && images.some(item => item.role === 'first_frame' || item.role === 'last_frame');
  const parameters = {
    ...(input.smartDuration ? { duration: -1 } : {}),
    ...(typeof input.promptExtend === 'boolean' ? { prompt_extend: input.promptExtend } : {}),
  };
  return {
    model: normalizedModel,
    prompt: input.prompt.trim(),
    ...(!input.smartDuration ? { seconds: String(input.seconds) } : {}),
    size: normalizedModel.startsWith('grok-imagine-video-1.5') && normalizedResolution === '1080P' ? '720P' : normalizedResolution,
    aspect_ratio: frameMode ? 'adaptive' : input.aspectRatio,
    ...(Object.keys(parameters).length ? { parameters } : {}),
    ...(images.length ? { reference_images: images } : {}),
    ...(videos.length ? { reference_videos: videos } : {}),
    ...(audios.length ? { reference_audios: audios } : {}),
    ...(input.inputMedia?.length ? { input: { media: input.inputMedia } } : {}),
  };
}

function finiteNonNegative(value: unknown): number | undefined {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

/** Read settlement data only when the upstream explicitly labels it as usage/billing data. */
export function extractSnumomWanBillingUsage(payload: any, fallbackReferenceSeconds = 0): SnumomWanBillingUsage | null {
  const scopes = [payload?.usage, payload?.billing, payload?.metadata?.usage, payload?.metadata?.billing]
    .filter(value => value && typeof value === 'object');
  for (const scope of scopes) {
    const outputSeconds = finiteNonNegative(scope.output_seconds ?? scope.outputSeconds ?? scope.output_duration);
    const referenceVideoSeconds = finiteNonNegative(scope.reference_video_seconds ?? scope.referenceVideoSeconds ?? scope.input_seconds);
    const explicitTotal = finiteNonNegative(scope.billable_seconds ?? scope.billableSeconds ?? scope.total_seconds ?? scope.totalSeconds);
    const billableSeconds = explicitTotal ?? (outputSeconds !== undefined
      ? outputSeconds + (referenceVideoSeconds ?? finiteNonNegative(fallbackReferenceSeconds) ?? 0)
      : undefined);
    if (billableSeconds === undefined) continue;
    const resolutionValue = String(scope.resolution ?? scope.actual_resolution ?? '').toLowerCase();
    const resolution = ['480p', '720p', '1080p'].includes(resolutionValue)
      ? resolutionValue as SnumomWanBillingUsage['resolution']
      : undefined;
    return { billableSeconds, outputSeconds, referenceVideoSeconds, resolution };
  }
  return null;
}

export function normalizeSnumomWanTask(payload: any, referenceVideoSeconds = 0) {
  return {
    id: extractSnumomTaskId(payload),
    status: String(payload?.status || '').toLowerCase(),
    progress: Number(payload?.progress || 0),
    resultUrl: String(payload?.metadata?.url || payload?.video_url || payload?.result_url || payload?.url || ''),
  error: payload?.error || payload?.message ? upstreamDiagnostic('snumom', '任务失败', { error: payload.error, message: payload.message, error_code: payload.error_code }) : '',
    billingUsage: extractSnumomWanBillingUsage(payload, referenceVideoSeconds),
  };
}

function snumomTaskId(value: unknown): string {
  if (!['string', 'number'].includes(typeof value)) return '';
  const taskId = String(value).trim();
  return /^task_[A-Za-z0-9_-]+$/.test(taskId) ? taskId : '';
}

/** snumom documents only id/task_id as polling IDs; request_id is a trace ID. */
export function extractSnumomTaskId(
  payload: any,
  headers?: Pick<Headers, 'get'> | Record<string, string | string[] | undefined> | null,
): string {
  const firstData = Array.isArray(payload?.data) ? payload.data[0] : payload?.data;
  const scopes = [payload, firstData, payload?.result, payload?.output, payload?.task, payload?.response?.data]
    .filter(value => value && typeof value === 'object');
  for (const scope of scopes) {
    for (const field of ['task_id', 'taskId', 'id']) {
      const taskId = snumomTaskId(scope?.[field]);
      if (taskId) return taskId;
    }
  }
  for (const name of ['x-task-id', 'task-id']) {
    const value = headers && typeof (headers as Pick<Headers, 'get'>).get === 'function'
      ? (headers as Pick<Headers, 'get'>).get(name)
      : (headers as Record<string, string | string[] | undefined> | null)?.[name];
    const taskId = snumomTaskId(Array.isArray(value) ? value[0] : value);
    if (taskId) return taskId;
  }
  const location = headers && typeof (headers as Pick<Headers, 'get'>).get === 'function'
    ? (headers as Pick<Headers, 'get'>).get('location')
    : (headers as Record<string, string | string[] | undefined> | null)?.location;
  const locationValue = Array.isArray(location) ? location[0] : location;
  const match = String(locationValue || '').match(/\/v1\/videos\/(task_[A-Za-z0-9_-]+)(?:[/?#]|$)/i);
  return match ? match[1] : '';
}

export function snumomContentUrl(baseUrl: string, taskId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/videos/${encodeURIComponent(taskId)}/content`;
}
import { upstreamDiagnostic } from './upstreamDiagnostic.js';
