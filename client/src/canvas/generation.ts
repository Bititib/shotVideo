import { uid, type CanvasNode } from './model';
export type GenerationEvent = { type: string; position?: number; message?: string; contentId?: number; progress?: number; imageUrl?: string; imageUrls?: string[]; videoUrl?: string };
export function parseEvent(line: string): GenerationEvent | null {
  if (!line.startsWith('data:')) return null;
  try { const event = JSON.parse(line.slice(5).trim()); return typeof event.type === 'string' ? event : null; } catch { return null; }
}
export async function streamGeneration(kind: 'image' | 'video', params: Record<string, unknown>, signal: AbortSignal, onEvent: (event: GenerationEvent) => void) {
  const response = await fetch(`/api/${kind === 'image' ? 'image-gen' : 'video'}/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token') || ''}` }, body: JSON.stringify(params), signal,
  });
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || `请求失败 (${response.status})`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('没有收到生成响应，请在生成记录中核实任务');
  const decoder = new TextDecoder(); let buffer = '';
  try {
    while (true) {
      const chunk = await reader.read(); buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const lines = buffer.split('\n'); buffer = lines.pop() || '';
      for (const line of lines) { const event = parseEvent(line); if (event) onEvent(event); }
      if (chunk.done) { const event = parseEvent(buffer); if (event) onEvent(event); break; }
    }
  } finally { reader.releaseLock(); }
}
export function applyGenerationEvent(node: CanvasNode, event: GenerationEvent): CanvasNode {
  if (!node.job) return node;
  const job = { ...node.job, contentId: event.contentId ?? node.job.contentId };
  const urls = [...new Set([event.imageUrl, ...(event.imageUrls || []), event.videoUrl].filter(Boolean))] as string[];
  if (urls.length) {
    const versions = (node.versions || []).map(v => v.requestId === job.requestId && job.contentId ? { ...v, contentId: job.contentId } : v);
    for (const src of urls) if (!versions.some(v => v.src === src && v.requestId === job.requestId)) versions.push({ id: uid(), src, prompt: node.text, model: node.model, ratio: node.ratio, resolution: node.settings?.resolution, createdAt: Date.now(), requestId: job.requestId, contentId: job.contentId });
    const received = versions.filter(v => v.requestId === job.requestId).length;
    const complete = event.type === 'complete' || received >= (job.expectedCount || 1);
    return { ...node, src: node.src || urls[0], versions: versions.slice(-100), job: { ...job, status: complete ? 'done' : 'running', message: complete ? '已完成' : `已生成 ${received} / ${job.expectedCount} 张`, progress: complete ? 100 : job.progress } };
  }
  if (node.job.status === 'done') return node;
  if (node.src && (event.type === 'complete' || event.type === 'error')) return { ...node, job: { ...job, status: 'done', message: event.type === 'error' ? `部分结果已保留：${event.message || '生成中断'}` : '已完成', progress: 100 } };
  if (event.type === 'error' || event.type === 'image_error') return { ...node, job: { ...job,
    status: job.contentId || job.requestId ? 'running' : 'error',
    message: job.contentId || job.requestId ? '生成通道中断，正在核实后台结果，请勿重复提交。' : event.message || '生成失败，请检查参数后重试' } };
  if (event.type === 'complete') return { ...node, job: { ...job, status: job.contentId ? 'running' : 'interrupted', message: '正在核实生成结果，请勿重复提交' } };
  return { ...node, job: { ...job, message: event.type === 'queue' && event.position != null ? (event.position > 0 ? `排队中 · 前方 ${event.position} 个任务` : '任务已就绪，正在开始生成') : event.message || job.message, progress: event.progress ?? job.progress } };
}

/** Polling must refresh in-flight progress too, especially after the event stream disconnects. */
export function applyPendingGeneration(node: CanvasNode, data: { status?: string; metadata?: any }): CanvasNode {
  if (node.job?.status !== 'running') return node;
  let meta: any = {};
  try { meta = typeof data.metadata === 'string' ? JSON.parse(data.metadata) : data.metadata || {}; } catch {}
  const raw = meta.progress ?? (Array.isArray(meta.progresses) && meta.progresses.length ? Math.max(...meta.progresses) : undefined);
  const progress = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : node.job.progress;
  const message = typeof meta.progressText === 'string' && meta.progressText ? meta.progressText
    : data.status === 'queued' ? '任务排队中，正在等待上游处理'
    : progress === 100 ? '上游已处理完成，正在等待结果保存'
    : progress != null ? `上游仍在处理 · ${Math.round(progress)}%，正在持续查询结果` : '正在查询上游生成结果';
  if (node.job.progress === progress && node.job.message === message) return node;
  return { ...node, job: { ...node.job, progress, message } };
}
export async function referenceDataUrl(src: string): Promise<string> {
  if (src.startsWith('data:image/')) return src;
  const response = await fetch(src.startsWith('/api/media/') ? src : `/api/image-gen/download?url=${encodeURIComponent(src)}`, { headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` } });
  if (!response.ok) throw new Error('参考图片读取失败，请重新导入图片后再试');
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
  });
}
