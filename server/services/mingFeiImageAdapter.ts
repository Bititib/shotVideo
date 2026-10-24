export const MINGFEI_IMAGE_MODEL = 'gpt-image-2-mingfei';
export const MINGFEI_UPSTREAM_IMAGE_MODEL = 'gpt-image-2';
export const MINGFEI_CHANNEL_TYPE = 'mingfei';
export const MINGFEI_DEFAULT_BASE_URL = 'https://mingfeikeji.qzz.io';
export const MINGFEI_IMAGE_PRICE = 0.05;

type FetchLike = typeof fetch;

export type MingFeiImageInput = {
  baseUrl: string;
  apiKey: string;
  prompt: string;
  aspectRatio?: string;
  resolution?: unknown;
  referenceImages?: string[];
  quality?: string;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  onSubmitted?: (taskId: string) => void;
  onProgress?: (progress: number, status: string) => void;
};

export type MingFeiImageResult = {
  imageUrl: string;
  reportedImageUrl: string;
  taskId: string;
  raw: any;
};

export function isMingFeiImageModel(model: unknown): boolean {
  return model === MINGFEI_IMAGE_MODEL;
}

export function isMingFeiImageChannel(channel: { type?: string | null; baseUrl?: string | null } | null | undefined): boolean {
  return channel?.type === MINGFEI_CHANNEL_TYPE || /mingfeikeji\.qzz\.io/i.test(channel?.baseUrl || '');
}

export function normalizeMingFeiResolution(value: unknown): '1K' | '2K' | '4K' {
  const normalized = String(value || '2K').trim().toUpperCase();
  return normalized === '1K' || normalized === '4K' ? normalized : '2K';
}

export function mingFeiImageContentUrl(baseUrl: string, taskId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/videos/${encodeURIComponent(taskId)}/content`;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function upstreamError(body: any, fallback: string, secret: string, response?: Response): Error {
  return new Error(upstreamDiagnostic('MingFei', fallback, body, secret, response?.status, response?.headers.get('x-request-id') || undefined));
}

async function readJson(response: Response, secret: string): Promise<any> {
  return diagnosticJson('MingFei', '图片响应', response, secret);
}

/**
 * MingFei exposes image generation through its shared asynchronous task API.
 * `seconds` must remain the string "1" or the upstream bills it as a video task.
 */
export async function generateMingFeiImage(input: MingFeiImageInput): Promise<MingFeiImageResult> {
  const fetchImpl = input.fetchImpl || fetch;
  const sleep = input.sleep || ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  const baseUrl = input.baseUrl.replace(/\/+$/, '');
  const referenceImages = (input.referenceImages || []).filter(Boolean).slice(0, 16);
  const payload: Record<string, any> = {
    model: MINGFEI_UPSTREAM_IMAGE_MODEL,
    prompt: input.prompt,
    aspect_ratio: input.aspectRatio || '1:1',
    output_resolution: normalizeMingFeiResolution(input.resolution),
    seconds: '1',
  };
  if (referenceImages.length > 0) payload.images = referenceImages;
  if (input.quality) payload.quality = input.quality;

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${input.apiKey}`,
  };
  const submitted = await fetchImpl(`${baseUrl}/v1/videos`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: input.signal,
  });
  const submitBody = await readJson(submitted, input.apiKey);
  if (!submitted.ok || submitBody?.error) {
    throw upstreamError(submitBody, `MingFei 图片任务提交失败 (HTTP ${submitted.status})`, input.apiKey, submitted);
  }

  const taskId = String(submitBody.id || submitBody.task_id || submitBody.taskId || '');
  if (!taskId) throw upstreamError(submitBody, 'MingFei 图片接口未返回任务 ID', input.apiKey, submitted);
  input.onSubmitted?.(taskId);

  const taskUrl = `${baseUrl}/v1/videos/${encodeURIComponent(taskId)}`;
  const pollIntervalMs = Math.max(1, input.pollIntervalMs ?? 5_000);
  const timeoutMs = Math.max(pollIntervalMs, input.timeoutMs ?? 900_000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    if (input.signal?.aborted) throw abortError('图片生成已取消');
    const response = await fetchImpl(taskUrl, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal: input.signal,
    });
    const task = await readJson(response, input.apiKey);
    if (!response.ok || task?.error && !task?.status) {
      throw upstreamError(task, `MingFei 图片任务查询失败 (HTTP ${response.status})`, input.apiKey, response);
    }

    const status = String(task.status || '').toLowerCase();
    const progress = Math.max(0, Math.min(100, Number.parseInt(String(task.progress || '0'), 10) || 0));
    input.onProgress?.(progress, status);
    if (status === 'completed') {
      const reportedImageUrl = String(task.url || task?.data?.[0]?.url || '');
      return {
        imageUrl: mingFeiImageContentUrl(baseUrl, taskId),
        reportedImageUrl,
        taskId,
        raw: task,
      };
    }
    if (status === 'failed') throw upstreamError(task, 'MingFei 图片生成失败 task_id=' + taskId, input.apiKey, response);
    await sleep(pollIntervalMs);
  }

  throw abortError(`MingFei 图片生成超时（${Math.ceil(timeoutMs / 1000)} 秒）`);
}
import { upstreamDiagnostic, diagnosticJson, transportDiagnostic } from './upstreamDiagnostic.js';
