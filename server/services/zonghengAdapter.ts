import { normalizeZonghengVideoResolution, validateZonghengVideoSpec, validateZonghengVideoReferences } from '../../shared/zonghengVideo.js';
import { sanitizedGenerationReason } from '../../shared/generationErrorPrivacy.js';
import { V6K_BASE_URL, V6K_CHANNEL_TYPE, retiredZonghengBase, type ZonghengProtocol } from './zonghengProtocol.js';
export { ZONGHENG_MODEL_PREFIX } from '../../shared/zonghengVideo.js';
// Only the V6K unified video API is supported.
export const ZONGHENG_BASE_URL = V6K_BASE_URL;
export function isZonghengChannel(c: { type?: string | null; baseUrl?: string | null } | null | undefined): boolean {
  if (c?.type === 'zongheng' || c?.type === V6K_CHANNEL_TYPE) return true;
  try { return new URL(c?.baseUrl || '').hostname === new URL(ZONGHENG_BASE_URL).hostname; } catch { return false; }
}
export const zonghengBaseUrl = (base: string) => {
  if (retiredZonghengBase(base)) throw new Error('旧视频接口已停用，请配置 V6K 地址和令牌');
  return base.replace(/\/+$/, '').replace(/\/v1$/i, '');
};
export const zonghengTaskUrl = (base: string, id: string, _protocol: ZonghengProtocol = 'v6k') => `${zonghengBaseUrl(base)}/v1/videos/${encodeURIComponent(id)}`;
export function zonghengError(payload: any): string {
  const code = payload?.error_code ?? payload?.error?.code ?? payload?.code;
  const detail = payload?.error_detail || payload?.error?.message || (typeof payload?.error === 'string' ? payload.error : '') || payload?.message || '';
  return sanitizedGenerationReason([code, detail].filter(Boolean).join(': ')).slice(0, 500) || '生成服务请求失败';
}
export interface ZonghengSubmissionDiagnostics {
  reason: 'http_error' | 'invalid_task_response' | 'invalid_json' | 'timeout' | 'network_error';
  httpStatus?: number; elapsedMs: number; networkCode?: string; requestNotSent?: boolean;
}
export class ZonghengSubmissionError extends Error {
  constructor(message: string, readonly uncertain: boolean, readonly diagnostics?: ZonghengSubmissionDiagnostics) { super(message); }
}
export interface ZonghengVideoInput {
  model: string; prompt: string; seconds: number; ratio: string; resolution: string;
  images: string[]; videos: string[]; audios: string[]; firstFrame?: string; lastFrame?: string;
  quality?: string; negativePrompt?: string; generateAudio?: boolean;
}
export function buildZonghengVideoPayload(i: ZonghengVideoInput, _protocol: ZonghengProtocol = 'v6k') {
  if (!i.model || !i.prompt?.trim()) throw new Error('模型和视频描述不能为空');
  if (!Number.isFinite(i.seconds) || i.seconds <= 0) throw new Error('视频时长必须大于零');
  if (typeof i.ratio !== 'string' || typeof i.resolution !== 'string' || !i.ratio || !i.resolution) throw new Error('比例和分辨率必须是有效文本');
  for (const value of [i.quality, i.negativePrompt, i.firstFrame, i.lastFrame]) if (value !== undefined && typeof value !== 'string') throw new Error('质量、负面描述和首尾帧必须为文本');
  if (i.lastFrame && !i.firstFrame) throw new Error('使用尾帧时必须同时提供首帧');
  if (i.images.length && (i.firstFrame || i.lastFrame)) throw new Error('普通参考图与独立首尾帧不能混用');
  if (i.generateAudio !== undefined && typeof i.generateAudio !== 'boolean') throw new Error('generate_audio 必须为布尔值');
  validateZonghengVideoSpec(i.model, i.seconds, i.resolution);
  validateZonghengVideoReferences(i.model, { images: i.images.length, videos: i.videos.length, audios: i.audios.length });
  const resolution = normalizeZonghengVideoResolution(i.model, i.resolution) || i.resolution;
  if (i.firstFrame || i.lastFrame || i.quality !== undefined || i.negativePrompt !== undefined || i.generateAudio !== undefined)
    throw new Error('当前接口尚未确认首尾帧、质量、负面提示词或音频开关参数，请使用普通参考素材');
  if (!Number.isSafeInteger(i.seconds)) throw new Error('视频时长必须为整数秒');
  return { model: i.model, prompt: i.prompt.trim(), seconds: i.seconds, ratio: i.ratio, resolution,
    ...(i.images.length ? { images: i.images } : {}), ...(i.videos.length ? { videos: i.videos } : {}),
    ...(i.audios.length ? { audios: i.audios } : {}) };
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
export function normalizeZonghengTask(p: any, base = V6K_BASE_URL, protocol: ZonghengProtocol = 'v6k', taskId = '') {
  if (!['queued', 'in_progress', 'completed', 'failed'].includes(p?.status)) throw new Error('视频查询未返回有效任务状态');
  const id = typeof p.id === 'string' ? p.id.trim() : '';
  if (!id || taskId && id !== taskId) throw new Error('视频查询返回的任务 ID 缺失或不一致');
  const completed = p.status === 'completed';
  return { status: completed ? 'completed' : p.status === 'failed' ? 'failed' : 'processing',
    progress: completed ? 100 : Math.max(0, Math.min(99, Number(p.progress) || 0)),
    resultUrl: completed ? zonghengTaskUrl(base, id, protocol) + '/content' : '',
    upstreamGenerated: completed, deliveryPending: false, deliveryStatus: completed ? 'ready' : '',
    generationCompletedAt: typeof p.completed_at === 'number' && Number.isFinite(p.completed_at) ? new Date(p.completed_at * 1000).toISOString() : '',
    progressText: '', error: p.status === 'failed' ? zonghengError(p) : '', pollDelay: 20_000 };
}
export function zonghengTaskMetadata(payload: any, base = V6K_BASE_URL, protocol: ZonghengProtocol = 'v6k', taskId = '') {
  const task = normalizeZonghengTask(payload, base, protocol, taskId);
  return { upstreamGenerated: task.upstreamGenerated, upstreamDeliveryPending: task.deliveryPending,
    upstreamDeliveryStatus: task.deliveryStatus, upstreamGenerationCompletedAt: task.generationCompletedAt || undefined, progressText: task.progressText || undefined };
}
/** Only connection establishment errors prove that this POST was never sent.
 * Generic aborts, socket resets, and response-body failures remain uncertain.
 */
export function zonghengRequestNotSent(error: unknown, httpStatus?: number): boolean {
  if (httpStatus !== undefined) return false;
  const beforeConnection = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']);
  const seen = new Set<object>();
  const check = (value: any): boolean => {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value.errors) && value.errors.length) return value.errors.every(check);
    if (typeof value.code === 'string') return beforeConnection.has(value.code);
    return check(value.cause);
  };
  return check(error);
}
export async function submitZonghengVideo(base: string, apiKey: string, input: ZonghengVideoInput, idempotencyKey: string,
  beforeSubmit: () => void, timeout = 120_000, protocol: ZonghengProtocol = 'v6k') {
  const body = JSON.stringify(buildZonghengVideoPayload(input, protocol));
  const url = zonghengBaseUrl(base) + '/v1/videos';
  if (!idempotencyKey) throw new Error('缺少业务订单号，停止提交');
  beforeSubmit();
  const startedAt = Date.now(); let httpStatus: number | undefined;
  try {
    const response = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body, signal: AbortSignal.timeout(timeout), redirect: 'error' });
    httpStatus = response.status;
    const text = await response.text(); let job: any;
    try { job = JSON.parse(text); }
    catch { throw new ZonghengSubmissionError('生成服务响应无法确认，请勿重复提交', response.ok || response.status === 408 || response.status >= 500,
      { reason: response.ok ? 'invalid_json' : 'http_error', httpStatus, elapsedMs: Date.now() - startedAt }); }
    if (!response.ok) throw new ZonghengSubmissionError(zonghengError(job).split(apiKey).join('[REDACTED]'),
      Boolean(job?.id || job?.task_id) || response.status === 408 || response.status >= 500,
      { reason: 'http_error', httpStatus, elapsedMs: Date.now() - startedAt });
    const accepted = typeof job?.id === 'string' && job.id.trim() && ['queued','in_progress','completed','failed'].includes(job.status);
    if (!accepted) {
      const explicitError = Boolean(job?.error) || job?.success === false
        || job?.code !== undefined && ![0,200,'0','200','success','ok'].includes(job.code);
      throw new ZonghengSubmissionError(explicitError ? zonghengError(job).split(apiKey).join('[REDACTED]') : '未返回有效任务 ID 或状态，请核实原订单', !explicitError,
        { reason: explicitError ? 'http_error' : 'invalid_task_response', httpStatus, elapsedMs: Date.now() - startedAt });
    }
    const taskId = job.id.trim();
    const initialTask = ['completed','failed'].includes(job.status) ? { id: taskId, status: job.status, progress: job.progress, completed_at: job.completed_at,
      error: job.error ? { code: job.error.code, message: job.error.message } : undefined } : undefined;
    return { taskId, pollDelay: 20_000, initialTask };
  } catch (error: any) {
    if (error instanceof ZonghengSubmissionError) throw error;
    const code = String(error?.cause?.code || error?.code || '');
    const reason = ['TimeoutError','AbortError'].includes(error?.name) ? 'timeout' : 'network_error';
    const requestNotSent = zonghengRequestNotSent(error, httpStatus);
    throw new ZonghengSubmissionError(requestNotSent ? '连接生成服务失败，请求未发送' : '提交结果待核实，请勿重复创建任务', !requestNotSent,
      { reason, httpStatus, elapsedMs: Date.now() - startedAt, requestNotSent, networkCode: code || undefined });
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
