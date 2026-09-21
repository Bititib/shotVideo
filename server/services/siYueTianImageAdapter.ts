import { isSiYueTianChannel } from './siYueTianChannelService.js';

export const SI_YUE_TIAN_IMAGE_MODELS = [
  'gpt-image-2',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
  'nano-banana-2',
  'nano-banana-2-lite',
  'nano-banana-pro',
] as const;

export type SiYueTianImageModel = typeof SI_YUE_TIAN_IMAGE_MODELS[number];

export const SI_YUE_TIAN_IMAGE_TO_IMAGE_MODELS = new Set<SiYueTianImageModel>([
  'gpt-image-2',
  'gpt-image-2.5-sunburst',
  'nano-banana-2',
  'nano-banana-pro',
]);

export const SI_YUE_TIAN_IMAGE_PRICE = 0.05;

const IMAGE_MODEL_SET = new Set<string>(SI_YUE_TIAN_IMAGE_MODELS);
const RETRYABLE_FAILURE = /未返回图片地址|temporar(?:ily|y) unavailable|system cpu overloaded|cpu overloaded|system overloaded|system busy|server busy|service unavailable|too many requests|rate[ -]?limit|HTTP\s*(?:429|502|503|504)/i;

export function isRetryableSiYueTianImageFailure(error: unknown): boolean {
  return RETRYABLE_FAILURE.test(String((error as any)?.message || error || ''));
}

export function isSiYueTianImageModel(model: unknown): model is SiYueTianImageModel {
  return typeof model === 'string' && IMAGE_MODEL_SET.has(model);
}

export function isSiYueTianImageChannel(
  channel: { baseUrl?: string | null } | null | undefined,
  model?: unknown,
): boolean {
  return isSiYueTianChannel(channel) && (model === undefined || isSiYueTianImageModel(model));
}

export function siYueTianAspectRatioFromSize(size: unknown, fallback = '1:1'): string {
  if (typeof size !== 'string') return fallback;
  const normalized = size.trim().toLowerCase();
  const known: Record<string, string> = {
    '1024x1024': '1:1',
    '1280x720': '16:9',
    '720x1280': '9:16',
    '1024x768': '4:3',
    '768x1024': '3:4',
    '1080x720': '3:2',
    '720x1080': '2:3',
    '1680x720': '21:9',
  };
  return known[normalized] || fallback;
}

export function normalizeSiYueTianResolution(value: unknown): '1K' | '2K' | '4K' {
  const normalized = String(value || '2K').trim().toUpperCase();
  return normalized === '1K' || normalized === '4K' ? normalized : '2K';
}

type FetchLike = typeof fetch;

export type SiYueTianImageInput = {
  baseUrl: string;
  apiKey: string;
  model: SiYueTianImageModel;
  prompt: string;
  aspectRatio?: string;
  resolution?: unknown;
  referenceImages?: string[];
  quality?: string;
  watermark?: boolean;
  callbackUrl?: string;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  onSubmitted?: (taskId: string) => void;
  onProgress?: (progress: number, status: string) => void;
  onRetry?: (attempt: number, maxAttempts: number, delayMs: number, message: string) => void;
};

export type SiYueTianImageResult = {
  imageUrl: string;
  taskId: string;
  raw: any;
};

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function upstreamError(body: any, fallback: string): Error {
  const message = body?.error?.message || body?.error || body?.message || fallback;
  return new Error(typeof message === 'string' ? message : fallback);
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new Error(`四月天返回了无效 JSON: ${text.slice(0, 200)}`); }
}

async function runOnce(input: SiYueTianImageInput): Promise<SiYueTianImageResult> {
  const fetchImpl = input.fetchImpl || fetch;
  const sleep = input.sleep || ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  const baseUrl = input.baseUrl.replace(/\/+$/, '');
  const referenceImages = (input.referenceImages || []).filter(Boolean);
  if (referenceImages.length > 0 && !SI_YUE_TIAN_IMAGE_TO_IMAGE_MODELS.has(input.model)) {
    throw new Error(`${input.model} 不支持参考图，请改用支持图生图的模型`);
  }

  const payload: Record<string, any> = {
    model: input.model,
    prompt: input.prompt,
    aspect_ratio: input.aspectRatio || '1:1',
    resolution: normalizeSiYueTianResolution(input.resolution),
  };
  if (referenceImages.length > 0) payload.reference_images = referenceImages;
  if (input.quality) payload.quality = input.quality;
  if (typeof input.watermark === 'boolean') payload.watermark = input.watermark;
  if (input.callbackUrl) payload.callback_url = input.callbackUrl;

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${input.apiKey}`,
  };
  const submitted = await fetchImpl(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: input.signal,
  });
  const submitBody = await readJson(submitted);
  if (!submitted.ok || submitBody?.error) {
    throw upstreamError(submitBody, `四月天图片任务提交失败 (HTTP ${submitted.status})`);
  }

  const taskId = String(submitBody.task_id || submitBody.taskId || submitBody.id || '');
  const taskPath = String(submitBody.task_url || (taskId ? `/v1/images/generations/${encodeURIComponent(taskId)}` : ''));
  if (!taskId || !taskPath) throw new Error('四月天图片接口未返回任务 ID');
  input.onSubmitted?.(taskId);

  const taskUrl = new URL(taskPath, `${baseUrl}/`).toString();
  const pollIntervalMs = Math.max(1, input.pollIntervalMs ?? 12_000);
  const timeoutMs = Math.max(pollIntervalMs, input.timeoutMs ?? 900_000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    if (input.signal?.aborted) throw abortError('图片生成已取消');
    const response = await fetchImpl(taskUrl, { headers: { Authorization: `Bearer ${input.apiKey}` }, signal: input.signal });
    const task = await readJson(response);
    if (!response.ok || task?.error && !task?.status) {
      const error = upstreamError(task, `四月天图片任务查询失败 (HTTP ${response.status})`);
      if (isRetryableSiYueTianImageFailure(error)) {
        input.onRetry?.(0, 0, pollIntervalMs, error.message);
        await sleep(pollIntervalMs);
        continue;
      }
      throw error;
    }

    const status = String(task.status || '').toLowerCase();
    const progress = Math.max(0, Math.min(100, Number.parseInt(String(task.progress || '0'), 10) || 0));
    input.onProgress?.(progress, status);
    if (status === 'succeeded') {
      const imageUrl = String(task?.result?.image_url || task?.result?.url || '');
      if (!imageUrl) throw new Error('四月天图片任务成功但未返回图片地址');
      return { imageUrl, taskId, raw: task };
    }
    if (status === 'failed') throw upstreamError(task, '四月天图片生成失败');
    await sleep(pollIntervalMs);
  }
  throw abortError(`四月天图片生成超时（${Math.ceil(timeoutMs / 1000)} 秒）`);
}

export async function generateSiYueTianImage(input: SiYueTianImageInput): Promise<SiYueTianImageResult> {
  const attempts = Math.max(1, Math.min(4, input.maxAttempts ?? 3));
  const sleep = input.sleep || ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  const retryBaseDelayMs = Math.max(1, input.retryBaseDelayMs ?? 10_000);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await runOnce(input);
    } catch (error: any) {
      lastError = error;
      if (error?.name === 'AbortError' || attempt >= attempts || !isRetryableSiYueTianImageFailure(error)) throw error;
      const delayMs = Math.min(60_000, retryBaseDelayMs * Math.pow(3, attempt - 1));
      input.onRetry?.(attempt + 1, attempts, delayMs, String(error?.message || '上游暂时繁忙'));
      await sleep(delayMs);
    }
  }
  throw lastError;
}
