export interface VideoModel {
  id: string;
  name: string;
  description: string;
  maxSeconds?: number;
  available: boolean;
  allowedSeconds?: number[] | null;
  requireRef?: boolean;
  series?: string;
  billingType?: 'per_call' | 'per_second' | 'per_token' | 'per_character' | null;
  rates?: {
    '480p'?: number;
    '720p'?: number;
    '1080p'?: number;
  };
  successRate?: number;
  successRateEstimated?: boolean;
  totalCalls?: number;
}

export interface VideoGenerateParams {
  prompt: string;
  model?: string;
  aspect_ratio?: string;
  video_length?: number;
  resolution?: string;
  reference_images?: string[];  // base64 dataURL 数组
  reference_video?: string;     // 旧兼容字段
  reference_videos?: string[];  // 多视频数组
  audio_url?: string;           // 旧兼容字段
  audio_urls?: string[];        // 多音频数组
  first_frame?: string;         // base64 首帧图片
  last_frame?: string;          // base64 尾帧图片
  compliance_enabled?: boolean; // 是否开启合规素材/过人脸
  compliance_mode?: string;    // 合规素材风格 (colored-pencil | watercolor | fishnet | grid)
}

export interface VideoSSEEvent {
  type: 'status' | 'queue' | 'progress' | 'content' | 'complete' | 'error' | 'content_id' | 'close';
  progress?: number;
  content?: string;
  videoUrl?: string;
  message?: string;
  contentId?: number;
  position?: number;
  running?: number;
  concurrencyLimit?: number;
  queued?: number;
}

const MODEL_CACHE_TTL_MS = 30_000;
let videoModelCache: { token: string; expiresAt: number; data: VideoModel[] } | null = null;
let videoModelRequest: { token: string; promise: Promise<VideoModel[]> } | null = null;

/** 获取可用的视频模型列表；短时缓存并合并并发请求，避免页面切换/聚焦时重复下载。 */
export async function fetchVideoModels(): Promise<VideoModel[]> {
  const token = localStorage.getItem('token');
  const cacheKey = token || '';
  const now = Date.now();
  if (videoModelCache?.token === cacheKey && videoModelCache.expiresAt > now) {
    return videoModelCache.data;
  }
  if (videoModelRequest?.token === cacheKey) return videoModelRequest.promise;

  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const promise = fetch('/api/video/models', { headers })
    .then(async (res) => {
      if (!res.ok) throw new Error('获取模型列表失败');
      const data = await res.json() as VideoModel[];
      videoModelCache = { token: cacheKey, expiresAt: Date.now() + MODEL_CACHE_TTL_MS, data };
      return data;
    })
    .finally(() => {
      if (videoModelRequest?.promise === promise) videoModelRequest = null;
    });
  videoModelRequest = { token: cacheKey, promise };
  return promise;
}

/** 发起视频生成（SSE 流式），返回 AbortController 可用于取消 */
export function generateVideo(
  params: VideoGenerateParams,
  onEvent: (event: VideoSSEEvent) => void,
): AbortController {
  const controller = new AbortController();
  const token = localStorage.getItem('token');

  fetch('/api/video/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(params),
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        onEvent({ type: 'error', message: err.error || `请求失败 (${response.status})` });
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        onEvent({ type: 'error', message: '无响应流' });
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          onEvent({ type: 'close' });
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const event: VideoSSEEvent = JSON.parse(line.slice(6));
              onEvent(event);
            } catch { /* skip */ }
          }
        }
      }
    })
    .catch((err) => {
      if (err.name !== 'AbortError') {
        // 网络闪断或连接中断时，触发 close 事件提升为后台轮询，防止硬报错误导用户
        onEvent({ type: 'close' });
      }
    });


  return controller;
}
