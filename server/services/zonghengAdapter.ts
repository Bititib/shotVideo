// Zongheng public API, used only by the legacy channel routes.
export const ZONGHENG_BASE_URL = 'https://cnd-coo-new.pages.dev';
export const ZONGHENG_MODEL_PREFIX = 'zongheng-';
export function isZonghengChannel(c: { type?: string | null; baseUrl?: string | null } | null | undefined): boolean {
  if (c?.type === 'zongheng') return true;
  try { return new URL(c?.baseUrl || '').hostname === new URL(ZONGHENG_BASE_URL).hostname; } catch { return false; }
}
export const zonghengBaseUrl = (base: string) => base.replace(/\/+$/, '').replace(/\/v1$/i, '');
export const zonghengTaskUrl = (base: string, id: string) => `${zonghengBaseUrl(base)}/v1/tasks/${encodeURIComponent(id)}`;
export const zonghengPollDelay = (value: unknown) => {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.max(1000, Math.min(60_000, seconds * 1000)) : 10_000;
};
export function zonghengError(payload: any): string {
  const detail = payload?.error_detail || payload?.error?.message || (typeof payload?.error === 'string' ? payload.error : '') || payload?.message;
  return [payload?.error_code, typeof detail === 'string' ? detail : ''].filter(Boolean).join(': ').replace(/sk-[\w-]+/g, '[REDACTED]').slice(0, 500) || '纵横科技请求失败';
}
export class ZonghengSubmissionError extends Error {
  constructor(message: string, readonly uncertain: boolean) { super(message); }
}
export interface ZonghengVideoInput {
  model: string; prompt: string; seconds: number; ratio: string; resolution: string;
  images: string[]; videos: string[]; audios: string[]; firstFrame?: string; lastFrame?: string;
  quality?: string; negativePrompt?: string; generateAudio?: boolean;
}
export function buildZonghengVideoPayload(i: ZonghengVideoInput) {
  if (!i.model || !i.prompt?.trim()) throw new Error('模型和视频描述不能为空');
  if (!Number.isFinite(i.seconds) || i.seconds <= 0) throw new Error('视频时长必须大于零');
  if (typeof i.ratio !== 'string' || typeof i.resolution !== 'string' || !i.ratio || !i.resolution) throw new Error('比例和分辨率必须是有效文本');
  for (const value of [i.quality, i.negativePrompt, i.firstFrame, i.lastFrame]) if (value !== undefined && typeof value !== 'string') throw new Error('质量、负面描述和首尾帧必须为文本');
  if (i.lastFrame && !i.firstFrame) throw new Error('使用尾帧时必须同时提供首帧');
  if (i.images.length && (i.firstFrame || i.lastFrame)) throw new Error('普通参考图与独立首尾帧不能混用');
  if (i.generateAudio !== undefined && typeof i.generateAudio !== 'boolean') throw new Error('generate_audio 必须为布尔值');
  return { model: i.model, prompt: i.prompt.trim(), duration: i.seconds, ratio: i.ratio, resolution: i.resolution,
    ...(i.images.length ? { images: i.images } : {}), ...(i.videos.length ? { reference_videos: i.videos } : {}),
    ...(i.audios.length ? { reference_audios: i.audios } : {}), ...(i.firstFrame ? { start_frame: i.firstFrame } : {}),
    ...(i.lastFrame ? { end_frame: i.lastFrame } : {}), ...(i.quality ? { quality: i.quality } : {}),
    ...(i.negativePrompt ? { negative_prompt: i.negativePrompt } : {}),
    ...(i.generateAudio !== undefined ? { generate_audio: i.generateAudio } : {}) };
}
/** Reject ambiguous or malformed references rather than silently dropping a supplied field. */
export function validateZonghengVideoAliases(body: Record<string, any>) {
  const groups = [
    ['reference_images','image_urls','images','image_refs','Ingredients_images'],
    ['reference_videos','video_urls','videos','video_url'], ['reference_audios','audio_urls','audios'],
    ['start_frame','first_frame_url','first_frame'], ['end_frame','end_frame_url','last_frame_url','last_frame'],
  ];
  for (const keys of groups) {
    const supplied = keys.filter(key => body[key] !== undefined && body[key] !== '' && (!Array.isArray(body[key]) || body[key].length));
    if (supplied.length > 1) throw new Error('同类素材请只使用一个字段：' + supplied.join(' / '));
    for (const key of supplied) {
      const value = body[key];
      if (Array.isArray(value) ? !value.every(v => typeof v === 'string' && v.trim()) : typeof value !== 'string' || !value.trim()) throw new Error('参考素材必须为有效地址或地址数组');
      if (['reference_images','reference_videos','reference_audios','image_refs'].includes(key) && !Array.isArray(value)) throw new Error(key + ' 必须为数组');
    }
  }
  if (body.n !== undefined && Number(body.n) !== 1) throw new Error('每次只能创建一条视频');
}
export function normalizeZonghengTask(p: any) {
  if (!['processing', 'succeeded', 'failed'].includes(p?.status)) throw new Error('纵横科技查询未返回有效任务状态');
  return { status: p.status === 'succeeded' ? 'completed' : p.status,
    progress: p.status === 'succeeded' ? 100 : Math.max(0, Math.min(99, Number(p.progress) || 0)),
    resultUrl: p.status === 'succeeded' ? String(p.video_url || p.url || p.result_url || '') : '',
    error: p.status === 'failed' ? zonghengError(p) : '', pollDelay: zonghengPollDelay(p.next_poll_seconds) };
}
export async function submitZonghengVideo(base: string, apiKey: string, input: ZonghengVideoInput, idempotencyKey: string,
  beforeSubmit: () => void, timeout = 120_000) {
  const body = JSON.stringify(buildZonghengVideoPayload(input));
  if (!idempotencyKey) throw new Error('缺少业务订单号，停止提交');
  beforeSubmit();
  try {
    const response = await fetch(`${zonghengBaseUrl(base)}/v1/videos`, { method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body, signal: AbortSignal.timeout(timeout), redirect: 'error' });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new ZonghengSubmissionError(`纵横科技提交失败 (${response.status})：${zonghengError(payload)}`, Boolean(payload.task_id) || response.status === 408 || response.status >= 500);
    }
    const job = await response.json() as any;
    if (typeof job.task_id !== 'string' || !job.task_id || job.success === false) throw new ZonghengSubmissionError('纵横科技提交结果待核实，未返回有效任务 ID', true);
    return { taskId: job.task_id, pollDelay: zonghengPollDelay(job.next_poll_seconds) };
  } catch (error: any) {
    if (error instanceof ZonghengSubmissionError) throw error;
    throw new ZonghengSubmissionError('纵横科技提交结果待核实，请勿重复创建任务', true);
  }
}
export function zonghengImageSize(ratio: string, resolution: string): string {
  const parts = /^(\d+):(\d+)$/.exec(ratio), edge = ({ '1K':1024, '2K':2048, '4K':4096 } as Record<string,number>)[resolution.toUpperCase()];
  if (!parts || !edge || !Number(parts[1]) || !Number(parts[2])) throw new Error('请使用有效的宽高比及 1K / 2K / 4K 分辨率，或明确指定 size');
  const scale = edge / Math.max(Number(parts[1]), Number(parts[2]));
  return Math.max(64, Math.round(Number(parts[1]) * scale / 64) * 64) + 'x' + Math.max(64, Math.round(Number(parts[2]) * scale / 64) * 64);
}
export function validateZonghengImageReferences(body: Record<string, any>) {
  const referenceFields = ['reference_images', 'images', 'image_urls', 'image_url', 'image', 'reference_image', 'input_image', 'mask'];
  if (referenceFields.some(key => body[key] !== undefined && body[key] !== null && body[key] !== '' && (!Array.isArray(body[key]) || body[key].length > 0))) {
    throw new Error('纵横科技文档尚未确认参考图或图片编辑协议');
  }
}
export function buildZonghengImagePayload(i: { model: string; prompt: string; size: string; aspectRatio?: string; quality?: string; n: number; referenceImages?: unknown[] }) {
  if (i.referenceImages?.length) throw new Error('纵横科技文档尚未确认参考图或图片编辑协议');
  if (!Number.isInteger(i.n) || i.n < 1 || i.n > 4) throw new Error('图片数量必须为 1–4');
  if (!i.model || !i.prompt?.trim()) throw new Error('模型和图片描述不能为空');
  if (typeof i.size !== 'string' || !i.size.trim()) throw new Error('图片 size 必须为有效文本');
  for (const value of [i.aspectRatio, i.quality]) if (value !== undefined && typeof value !== 'string') throw new Error('图片比例和质量必须为文本');
  return { model: i.model, prompt: i.prompt.trim(), size: i.size, n: i.n,
    ...(i.aspectRatio ? { aspect_ratio: i.aspectRatio } : {}), ...(i.quality ? { quality: i.quality } : {}) };
}
