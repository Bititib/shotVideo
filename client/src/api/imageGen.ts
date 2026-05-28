export interface ImageModel {
  id: string;
  name: string;
  description: string;
  available: boolean;
}

export interface ImageGenerateParams {
  prompt: string;
  model?: string;
  aspect_ratio?: string;
  n?: number;                    // 生成数量 1~4
  reference_images?: string[];   // base64 数据 URL
}

export interface ImageSSEEvent {
  type: 'status' | 'progress' | 'content' | 'image_ready' | 'image_error' | 'complete' | 'error';
  progress?: number;
  index?: number;               // 多图时的图片索引
  total?: number;               // 多图总数
  content?: string;
  imageUrl?: string;            // 单张图片 URL（image_ready）
  imageUrls?: string[];         // 所有图片 URL（complete）
  message?: string;
}

/** 获取可用的图片模型列表 */
export async function fetchImageModels(): Promise<ImageModel[]> {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch('/api/image-gen/models', { headers });
  if (!res.ok) throw new Error('获取模型列表失败');
  return res.json();
}

/** 发起图片生成（SSE 流式），返回 AbortController 可用于取消 */
export function generateImage(
  params: ImageGenerateParams,
  onEvent: (event: ImageSSEEvent) => void,
): AbortController {
  const controller = new AbortController();
  const token = localStorage.getItem('token');

  fetch('/api/image-gen/generate', {
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
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const event: ImageSSEEvent = JSON.parse(line.slice(6));
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
