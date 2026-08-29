export interface ImageModel {
  id: string;
  name: string;
  description: string;
  available: boolean;
  rate?: number;
}

export interface ImageGenerateParams {
  prompt: string;
  model?: string;
  aspect_ratio?: string;
  n?: number;                    // 生成数量 1~4
  reference_images?: string[];   // base64 数据 URL
}

export interface ImageSSEEvent {
  type: 'status' | 'queue' | 'progress' | 'content' | 'image_ready' | 'image_error' | 'complete' | 'error';
  progress?: number;
  index?: number;               // 多图时的图片索引
  total?: number;               // 多图总数
  content?: string;
  imageUrl?: string;            // 单张图片 URL（image_ready）
  imageUrls?: string[];         // 所有图片 URL（complete）
  message?: string;
  position?: number;
  running?: number;
  concurrencyLimit?: number;
  queued?: number;
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
  const response = await fetch(`/api/image-gen/download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`, {
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
