export interface VideoModel {
  id: string;
  name: string;
  description: string;
  maxSeconds?: number;
  available: boolean;
  allowedSeconds?: number[] | null;
  requireRef?: boolean;
  series?: string;
  billingType?: 'flat' | 'per_second';
  group?: string;
  icon?: string;
  rates?: {
    '480p'?: number;
    '720p'?: number;
    '1080p'?: number;
  };
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
}

export interface VideoSSEEvent {
  type: 'status' | 'progress' | 'content' | 'complete' | 'error' | 'content_id' | 'close';
  progress?: number;
  content?: string;
  videoUrl?: string;
  message?: string;
  contentId?: number;
}

/** 获取可用的视频模型列表 */
export async function fetchVideoModels(): Promise<VideoModel[]> {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch('/api/video/models', { headers });
  if (!res.ok) throw new Error('获取模型列表失败');
  return res.json();
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
        onEvent({ type: 'error', message: err.message });
      }
    });

  return controller;
}
