import type { ModelInputLimits } from '../../../shared/modelRouting';
import { legacyImageReferenceLimit } from '../../../shared/imageCapabilities';
export interface ImageModel {
  routingLimits?: ModelInputLimits;
  maxReferenceImages?: number;
  id: string;
  name: string;
  description: string;
  available: boolean;
  rate?: number;
  resolutionPrices?: Record<string, number>;
}

export function imageReferenceLimit(model: ImageModel | undefined): number {
  return model ? model.routingLimits?.maxImages ?? model.maxReferenceImages ?? legacyImageReferenceLimit(model.id) : 0;
}

/** Read generated images through the authenticated download endpoint before reusing them. */
export async function generatedImageReference(url: string): Promise<string> {
  if (url.startsWith('data:image/')) return url;
  const token = localStorage.getItem('token');
  const response = await fetch(url.startsWith('/api/media/') ? url : `/api/image-gen/download?url=${encodeURIComponent(url)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error('原图读取失败，请重新上传图片后再试');
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('原图不是有效图片，请重新上传');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('原图读取失败，请重新上传'));
    reader.readAsDataURL(blob);
  });
}

export interface ImageGenerateParams {
  prompt: string;
  model?: string;
  aspect_ratio?: string;
  resolution?: '1K' | '2K' | '4K';
  quality?: 'low' | 'medium' | 'high';
  n?: number;                    // 生成数量 1~4
  reference_images?: string[];   // base64 数据 URL
}

export interface ImageSSEEvent {
  type: 'content_id' | 'disconnected' | 'status' | 'queue' | 'progress' | 'content' | 'image_ready' | 'image_error' | 'complete' | 'error';
  status?: string;
  progress?: number;
  index?: number;               // 多图时的图片索引
  total?: number;               // 多图总数
  content?: string;
  imageUrl?: string;            // 单张图片 URL（image_ready）
  imageUrls?: string[];         // 所有图片 URL（complete）
  message?: string;
  contentId?: number;           // 已持久化的内容记录 ID，刷新页面后可继续恢复
  position?: number;
  running?: number;
  concurrencyLimit?: number;
  queued?: number;
}

const MODEL_CACHE_TTL_MS = 30_000;
const PERSISTED_MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PERSISTED_MODEL_CACHE_KEY = 'image-models-cache-v1';
let imageModelCache: { token: string; expiresAt: number; data: ImageModel[] } | null = null;
let imageModelRequest: { token: string; promise: Promise<ImageModel[]> } | null = null;

/** Return the last successful model list immediately while the latest config loads. */
export function getCachedImageModels(): ImageModel[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const cached = JSON.parse(localStorage.getItem(PERSISTED_MODEL_CACHE_KEY) || 'null');
    if (!cached || !Array.isArray(cached.data) || Date.now() - Number(cached.savedAt || 0) > PERSISTED_MODEL_CACHE_TTL_MS) {
      return [];
    }
    return cached.data.filter((model: any) => model && typeof model.id === 'string' && typeof model.name === 'string');
  } catch {
    return [];
  }
}

function persistImageModels(data: ImageModel[]) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PERSISTED_MODEL_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data }));
  } catch { /* storage may be disabled or full */ }
}

/** 获取可用的图片模型列表；短时缓存并合并并发请求。 */
export async function fetchImageModels(): Promise<ImageModel[]> {
  const token = localStorage.getItem('token');
  const cacheKey = token || '';
  const now = Date.now();
  if (imageModelCache?.token === cacheKey && imageModelCache.expiresAt > now) {
    return imageModelCache.data;
  }
  if (imageModelRequest?.token === cacheKey) return imageModelRequest.promise;

  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const promise = fetch('/api/image-gen/models', { headers })
    .then(async (res) => {
      if (!res.ok) throw new Error('获取模型列表失败');
      const data = await res.json() as ImageModel[];
      imageModelCache = { token: cacheKey, expiresAt: Date.now() + MODEL_CACHE_TTL_MS, data };
      persistImageModels(data);
      return data;
    })
    .finally(() => {
      if (imageModelRequest?.promise === promise) imageModelRequest = null;
    });
  imageModelRequest = { token: cacheKey, promise };
  return promise;
}

/** Download through the authenticated same-origin proxy to force a file save. */
export async function downloadGeneratedImage(url: string, filename = 'generated-image.png'): Promise<void> {
  if (url.startsWith('data:') || url.startsWith('blob:')) {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return;
  }

  const token = localStorage.getItem('token');
  const response = await fetch(url.startsWith('/api/media/') ? url : `/api/image-gen/download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `图片下载失败 (${response.status})`);
  }

  const blobUrl = URL.createObjectURL(await response.blob());
  try {
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1_000);
  }
}

/** 发起图片生成（SSE 流式），返回 AbortController 可用于取消 */
export function generateImage(
  params: ImageGenerateParams,
  onEvent: (event: ImageSSEEvent) => void,
): AbortController {
  const controller = new AbortController();
  const token = localStorage.getItem('token');

  let terminal = false;
  let contentId: number | undefined;
  const emit = (event: ImageSSEEvent) => {
    if (controller.signal.aborted || terminal) return;
    contentId = event.contentId || contentId;
    if (event.type === 'complete' || event.type === 'error') terminal = true;
    onEvent({ ...event, contentId });
  };
  const disconnected = () => emit({ type: 'disconnected', contentId,
    message: '实时连接已断开，正在核实后台结果，请勿重复提交' });
  fetch('/api/image-gen/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(params), signal: controller.signal,
  }).then(async response => {
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      emit({ type: 'error', message: err.error || `请求失败 (${response.status})` });
      return;
    }
    const reader = response.body?.getReader();
    if (!reader) { disconnected(); return; }
    const decoder = new TextDecoder();
    let buffer = '';
    const consume = (line: string) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let event: ImageSSEEvent;
      try { event = JSON.parse(data); } catch { return; }
      emit(event);
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        lines.forEach(consume);
        if (done) { consume(buffer); break; }
      }
      if (!terminal) disconnected();
    } finally { reader.releaseLock(); }
  }).catch(() => { if (!controller.signal.aborted) disconnected(); });
  return controller;
}
