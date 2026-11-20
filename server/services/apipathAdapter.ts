import { randomUUID } from 'node:crypto';
import { transportDiagnostic } from './upstreamDiagnostic.js';
import { sanitizedGenerationReason } from '../../shared/generationErrorPrivacy.js';
import type { ModelRoute } from '../../shared/modelRouting.js';

export type ApipathChannel = { type?: string | null; baseUrl: string; apiKey: string; timeout?: number };
export const APIPATH_VIDEO_FIELDS=['prompt','ratio','duration','resolution','count','generation_mode','reference_images','reference_videos','reference_audios','first_frame','last_frame','aigc_watermark'];
export const APIPATH_VIDEO_MODES=['text','reference','multimodal','image_video','image_audio','first_frame','last_frame','first_last','first_frame_reference','last_frame_reference','first_last_reference'];
export const isApipathChannel = (c: { type?: string | null } | null | undefined) => c?.type === 'apipath';
export const apipathBase = (url: string) => url.replace(/\/+$/, '').replace(/\/v1$/, '');
export const apipathVideoUrl = (url: string, id: string) => apipathBase(url) + '/v1/video/generations/' + encodeURIComponent(id);
export class ApipathError extends Error {
  constructor(message: string, public uncertain = true, public status = 0) { super(message); }
}
export function apipathTaskId(raw: any): string {
  const ids = [raw?.task_no, raw?.task_id, raw?.id].filter(v => typeof v === 'string' && v.trim());
  if (new Set(ids).size > 1) throw new ApipathError('通联返回的任务编号互相冲突，请核实原请求');
  return ids[0] || '';
}
const diagnostic = (c: ApipathChannel, stage: string, raw: any, status = 0) => {
  const code = raw?.error?.code ?? raw?.error_code ?? raw?.code ?? (typeof raw?.error === 'string' ? raw.error : undefined);
  const reason = raw?.error?.message ?? raw?.error_message ?? raw?.message ?? (typeof raw?.error === 'string' ? raw.error : '上游未提供具体原因');
  const text = `[通联 ${stage}] HTTP ${status || '未提供'} code=${String(code ?? '未提供')}；原因：${sanitizedGenerationReason(reason)}`;
  return sanitizedGenerationReason(c.apiKey ? text.split(c.apiKey).join('[密钥已隐藏]') : text);
};

/** No POST retries: the provider explicitly does not implement idempotency. */
export async function apipathRequest(c: ApipathChannel, endpoint: string, body?: object | FormData,
  onStarting: (metadata: Record<string, unknown>) => void = () => {}, onTask: (id: string) => void = () => {}) {
  const submitting = body !== undefined;
  if (submitting) onStarting({ apipathLogicalRequestId: randomUUID(), apipathBaseUrl: apipathBase(c.baseUrl) });
  let response: Response;
  try {
    response = await fetch(apipathBase(c.baseUrl) + endpoint, {
      method: submitting ? 'POST' : 'GET', redirect: 'error',
      headers: { Authorization: 'Bearer ' + c.apiKey, ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(c.timeout || (submitting ? 120_000 : 30_000)),
    });
  } catch (e) { throw new ApipathError(transportDiagnostic('通联', submitting ? '提交结果未知' : '查询异常', e, c.apiKey)); }
  let raw: any;
  try { raw = await response.json(); }
  catch { throw new ApipathError(diagnostic(c, '响应无法解析', { message: '响应非 JSON 或读取中断' }, response.status)); }
  // Persist accepted evidence before considering HTTP or error fields.
  const id = submitting ? apipathTaskId(raw) : '';
  if (id) onTask(id);
  if (!response.ok || (submitting && !id && raw?.error)) {
    // Only documented pre-dispatch rejections constitute refund evidence.
    const code = raw?.error?.code ?? raw?.error_code ?? (typeof raw?.error === 'string' ? raw.error : undefined);
    const rejected = submitting && !id && ((response.status === 400 && ['invalid_request_error','invalid_request','reference_duration_missing','unsupported_media','provider_param_rejected'].includes(code))
      || (endpoint==='/v1/video/generations' && response.status===400 && typeof raw?.error==='string' && Boolean(raw.error.trim()))
      || (response.status === 401 && code === 'invalid_api_key') || (response.status === 429 && code === 'rate_limit_exceeded')
      || ([500,502].includes(response.status) && code === 'provider_error'));
    throw new ApipathError(diagnostic(c, submitting ? '提交' : '查询', raw, response.status), !rejected, response.status);
  }
  return raw;
}
export function normalizeApipathVideo(raw: any, c: ApipathChannel, id: string) {
  const returnedId = apipathTaskId(raw);
  if (returnedId && returnedId !== id) throw new ApipathError('通联查询返回了其他任务编号，保留原任务');
  const status = raw?.status;
  // Observed on Apipath video receipts (2026-11-01); keep its raw nonterminal
  // status for diagnostics while the shared poller continues the original task.
  if (!['queued', 'pending', 'running', 'processing', 'in_progress', 'completed', 'failed'].includes(status)) {
    throw new ApipathError(diagnostic(c, '查询状态未确认', { message: '未知状态：' + String(status) }));
  }
  let resultUrl = '';
  if (status === 'completed') {
    try { const url = new URL(raw.url || apipathVideoUrl(c.baseUrl,id)+'/content'); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); resultUrl = url.href; }
    catch { throw new ApipathError('通联已完成但未返回有效 url，继续核实原结果'); }
  }
  return { status, progress: status === 'completed' ? 100 : Math.max(0, Math.min(99, Number(raw.progress) || 0)), resultUrl,
    error: status === 'failed' ? diagnostic(c, '任务失败 task_no=' + id, raw) : '' };
}
export async function pollApipathVideo(c: ApipathChannel, id: string) {
  return normalizeApipathVideo(await apipathRequest(c, '/v1/video/generations/' + encodeURIComponent(id)), c, id);
}

export function buildApipathVideoPayload(model: string, prompt: string, input: {
  seconds: number; ratio: string; resolution: string; images: string[]; videos: string[]; audios: string[]; firstFrame?: string; lastFrame?: string; generationMode?: unknown;
}, profile?: ModelRoute['apipath']) {
  const { images, videos, audios, firstFrame, lastFrame } = input;
  if (profile?.maxPromptChars && Array.from(prompt).length > profile.maxPromptChars)
    throw new ApipathError('通联该型号提示词最多 ' + profile.maxPromptChars + ' 字符，当前 ' + Array.from(prompt).length + ' 字符',false);
  if (!profile && (firstFrame || lastFrame)) throw new ApipathError('通联此历史型号尚未核实独立首尾帧组合', false);
  if (!profile && input.generationMode!==undefined)throw new ApipathError('通联此历史型号尚未核实 generation_mode',false);
  const payload: Record<string,unknown> = { model,prompt,ratio:input.ratio,duration:input.seconds,resolution:input.resolution,count:1,
    ...(images.length?{reference_images:images}:{}),...(videos.length?{reference_videos:videos}:{}),...(audios.length?{reference_audios:audios}:{}),
    ...(firstFrame?{first_frame:firstFrame}:{}),...(lastFrame?{last_frame:lastFrame}:{}) };
  if (profile) {
    if(profile.modeOptional && !profile.modes.length){
      if(input.generationMode!==undefined)throw new ApipathError('通联该型号未公布可选 generation_mode，请使用默认模式',false);
    } else {
    const refs = images.length + videos.length + audios.length;
    let mode = firstFrame && lastFrame ? refs ? 'first_last_reference' : 'first_last'
      : firstFrame ? refs ? 'first_frame_reference' : 'first_frame' : lastFrame ? refs ? 'last_frame_reference' : 'last_frame'
      : videos.length ? images.length && !audios.length ? 'image_video' : 'multimodal'
      : audios.length ? images.length ? 'image_audio' : 'multimodal' : images.length ? 'reference' : 'text';
    if (!profile.modes.includes(mode) && profile.modes.includes('multimodal')) mode='multimodal';
    if(input.generationMode!==undefined){if(typeof input.generationMode!=='string')throw new ApipathError('通联 generation_mode 必须为文本',false);mode=input.generationMode;}
    if (!profile.modes.includes(mode)) throw new ApipathError('通联该型号未公布此素材组合对应的生成模式：' + mode, false);
    payload.generation_mode=mode;
    }
    for (const field of Object.keys(payload)) if (!['model','prompt'].includes(field) && !profile.fields.includes(field)) {
      if (field.startsWith('reference_') || ['first_frame','last_frame','generation_mode'].includes(field)) throw new ApipathError('通联该型号不接受字段：'+field,false);
      delete payload[field]; // Fixed resolution/count are not transmitted when the model's allowlist excludes them.
    }
  }
  return payload;
}
