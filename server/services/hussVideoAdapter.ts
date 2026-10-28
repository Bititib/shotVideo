import { HUSS_HSS_MODEL, hussHssModelLimits } from '../../shared/hussBbVideo.js';
import { randomUUID } from 'node:crypto';
import { videoErrorTaskId, videoRequestNotSent } from './videoSubmissionErrors.js';
import { publishReferenceUrl } from './publicReferenceService.js';
import type { ModelInputLimits } from '../../shared/modelRouting.js';
import { sanitizedGenerationReason } from '../../shared/generationErrorPrivacy.js';

export function hussFailure(stage: string, payload: any, status?: number, requestId?: string, secret = '') {
  const code = payload?.error?.code ?? payload?.error_code ?? payload?.code;
  const details = (code !== undefined ? 'code=' + String(code) + ' ' : '') + sanitizedGenerationReason(payload);
  const id = requestId || payload?.request_id || payload?.requestId || payload?.error?.request_id;
  const text = `[HUSS ${stage}]${status ? ' HTTP ' + status : ''}${id ? ' request_id=' + String(id) : ''}：${details}`;
  return sanitizedGenerationReason(secret ? text.split(secret).join('[密钥已隐藏]') : text);
}

export const HUSS_CHANNEL_TYPE = 'huss';
export const HUSS_BASE_URL = 'https://www.huss.top';
export const HUSS_BB_MODEL = 'bb-seedance2.5-301010';
export type HussChannel = { type?: string; baseUrl: string; apiKey: string; timeout?: number };
export type HussVideoInput = { model: string; prompt: string; seconds: number; ratio: string; resolution: string; images: string[]; videos: string[]; audios: string[]; firstFrame?: string; lastFrame?: string; idempotencyKey?: string; publicBaseUrl: string };
export type HussVideoModel = { id: string; name: string; type: 'video'; config: Record<string, unknown> };

export function isHussChannel(channel: { type?: string; baseUrl?: string } | null | undefined) {
  if (channel?.type === HUSS_CHANNEL_TYPE) return true;
  try { return ['huss.top', 'www.huss.top'].includes(new URL(channel?.baseUrl || '').hostname); } catch { return false; }
}
export function hussApiBase(baseUrl: string) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('HUSS 接口地址无效');
  const p = url.pathname.replace(/\/+$/, ''); url.pathname = /\/v1$/i.test(p) ? p.slice(0, -3) || '/' : p || '/';
  return url.href.replace(/\/$/, '');
}

/** Official read-only content endpoint. Never forward the API key on redirects. */
export async function fetchHussVideoContent(channel: HussChannel, taskId: string): Promise<Response> {
  let url = hussApiBase(channel.baseUrl) + '/v1/videos/' + encodeURIComponent(taskId) + '/content';
  const signal = AbortSignal.timeout(300_000);
  for (let hop = 0; hop <= 5; hop++) {
    const response = await fetch(url, { method: 'GET', redirect: 'manual', signal, cache: 'no-store',
      headers: hop === 0 ? { Authorization: 'Bearer ' + channel.apiKey } : {} });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || hop === 5) throw new Error('HUSS 原任务下载入口重定向缺少地址或次数超限');
    const next = new URL(location, url);
    if (next.protocol !== 'https:' || next.username || next.password) throw new Error('HUSS 原任务下载入口返回无效重定向地址');
    url = next.href;
  }
  throw new Error('HUSS 原任务下载未返回响应');
}
export class HussApiError extends Error { constructor(message: string, readonly status: number, readonly uncertain = false, readonly retryAfterMs = 0) { super(message); } }
async function hussRequest(channel: HussChannel, endpoint: string, body?: unknown, idempotencyKey?: string) {
  const persistent = (body as any)?.model === HUSS_HSS_MODEL;
  const generation = body !== undefined;
  let response: Response;
  try {
    response = await fetch(hussApiBase(channel.baseUrl) + '/v1' + endpoint, { method: generation ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + channel.apiKey, ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}), ...(generation ? { 'Content-Type': 'application/json' } : {}) },
      ...(generation ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(channel.timeout || (generation ? 900_000 : 60_000)), redirect: 'error' });
  } catch (error: any) { throw new HussApiError(hussFailure(endpoint + ' 连接', { code: error?.cause?.code || error?.code || error?.name, message: error?.message, detail: error?.cause?.message }, undefined, undefined, channel.apiKey) + (generation && !videoRequestNotSent(error) ? '；提交结果待核实，请勿重复生成' : ''), 0, generation && !videoRequestNotSent(error)); }
  const requestId = response.headers.get('x-request-id') || response.headers.get('request-id') || undefined;
  let text: string;
  try { text = await response.text(); } catch (error: any) { throw new HussApiError(hussFailure(endpoint + ' 读取响应', error?.message, response.status, requestId, channel.apiKey), response.status, generation); }
  let payload: any; try { payload = JSON.parse(text); } catch { throw new HussApiError(hussFailure(endpoint + ' 非 JSON 响应', text || '上游返回空响应', response.status, requestId, channel.apiKey), response.status, generation); }
  // A successfully queried failed task/receipt is business state, not a query error.
  const state = payload?.data?.status || payload?.status;
  if (response.ok && !generation && endpoint.startsWith('/videos/') &&
    ['queued','processing','accepted','not_submitted','rejected','submission_uncertain','failed','cancelled','canceled','completed','in_progress','running','success','succeeded'].includes(state)) return payload;
  if (generation && ['rejected','not_submitted'].includes(state) && payload.submission_uncertain !== true && !videoErrorTaskId(payload, response.headers))
    throw new HussApiError(hussFailure(endpoint, payload, response.status, requestId, channel.apiKey), response.status, false);
  if (persistent && response.ok && typeof payload?.id === 'string' && /^video_[A-Za-z0-9_-]+$/.test(payload.id)) return payload;
  const failure = payload?.error || payload?.code && payload.code !== 0;
  if (persistent && (!response.ok || failure)) {
    const code = payload?.error?.code || payload?.code;
    const rejected = [400,401,402,403].includes(response.status) &&
      ['invalid_prompt','invalid_input','invalid_duration','unsupported_resolution','invalid_reference_count','invalid_api_key','model_not_allowed','request_not_allowed'].includes(code);
    const retry = response.headers.get('retry-after') || '';
    const delay = /^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now()) || 0;
    throw new HussApiError(hussFailure(endpoint, payload, response.status, requestId, channel.apiKey), response.status,
      !rejected || payload?.submission_uncertain === true || payload?.data?.submission_uncertain === true || Boolean(videoErrorTaskId(payload, response.headers)), delay);
  }
  if (!response.ok || failure) {
    throw new HussApiError(hussFailure(endpoint, payload, response.status, requestId, channel.apiKey), response.status || 502,
      generation && (Boolean(videoErrorTaskId(payload, response.headers)) || (!persistent && response.status === 400) || response.status === 409 || response.status === 408 || response.status >= 500 || state === 'submission_uncertain'),
      (() => { const value = response.headers.get('retry-after') || ''; return /^\d+$/.test(value) ? Number(value) * 1000 : Math.max(0, Date.parse(value) - Date.now()) || 0; })());
  }
  return payload;
}
export function hussBbModelLimits(): ModelInputLimits { return { maxImages: 30, maxVideos: 10, maxAudios: 10, maxOutputs: 1, minImages: 0, resolutions: ['720p'], ratios: ['16:9', '9:16', '1:1'], qualities: [], firstFrame: false, lastFrame: false, duration: { mode: 'range', min: 10, max: 30, step: 1, values: [] } }; }
export async function fetchHussVideoModels(channel: HussChannel): Promise<HussVideoModel[]> {
  const raw = await hussRequest(channel, '/models'); const candidates = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.models) ? raw.models : [];
  const allowed = new Set(candidates.map((item: any) => typeof item === 'string' ? item : item?.id));
  const selected = [HUSS_BB_MODEL, HUSS_HSS_MODEL].filter(id => allowed.has(id));
  if (!selected.length) throw new Error('HUSS 当前 API Key 未开放已接入的视频模型');
  return selected.map(id => ({ id, name: id, type: 'video' as const, config: { limits: id === HUSS_HSS_MODEL ? hussHssModelLimits() : hussBbModelLimits() } }));
}
export function hussVideoParameters(input: HussVideoInput) {
  const persistent = input.model === HUSS_HSS_MODEL;
  const limits = persistent ? hussHssModelLimits() : hussBbModelLimits();
  if (![HUSS_BB_MODEL, HUSS_HSS_MODEL].includes(input.model)) throw new Error('HUSS 未接入此模型');
  if (input.firstFrame || input.lastFrame) throw new Error('HUSS 此模型不支持独立首尾帧，请作为普通参考图片提交');
  if (!input.prompt.trim()) throw new Error('HUSS 提示词不能为空');
  if (!Number.isInteger(input.seconds) || input.seconds < limits.duration.min || input.seconds > 30) throw new Error(`HUSS ${input.model} 视频时长须为 ${limits.duration.min}–30 秒整数`);
  if (input.resolution !== '720p' || !limits.ratios.includes(input.ratio)) throw new Error(`HUSS ${input.model} 仅支持 720p 和 ${limits.ratios.join('、')}`);
  if (input.images.length > 30 || input.videos.length > 10 || input.audios.length > 10) throw new Error('HUSS 参考素材数量超过模型上限');
  const key = input.idempotencyKey || randomUUID(); if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new Error('HUSS 请求标识仅支持 1–128 位字母、数字、点、下划线、冒号和短横线');
  return { key, payload: { model: input.model, prompt: input.prompt.trim(), duration: input.seconds, ratio: input.ratio, resolution: input.resolution } };
}
export async function submitHussVideo(channel: HussChannel, input: HussVideoInput, beforeSubmit: (payload: Record<string, unknown>) => void, onAccepted?: (raw: unknown) => void) {
  const { key, payload } = hussVideoParameters(input); const publish = (items: string[]) => items.map(item => publishReferenceUrl(item, input.publicBaseUrl));
  const request: Record<string, any> = { ...payload, ...(input.images.length ? { [input.model === HUSS_HSS_MODEL ? 'images' : 'reference_images']: publish(input.images) } : {}), ...(input.videos.length ? { videos: publish(input.videos) } : {}), ...(input.audios.length ? { audios: publish(input.audios) } : {}) };
  if (input.model === HUSS_HSS_MODEL) {
    for (const value of [...(request.images || []), ...(request.videos || []), ...(request.audios || [])]) {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('HUSS hss 素材必须为无需登录的公网 HTTPS 直链');
    }
    if (Buffer.byteLength(JSON.stringify(request)) > 4 * 1024 * 1024) throw new Error('HUSS hss 请求超过 4 MiB');
  }
  beforeSubmit({ ...request, idempotency_key: key });
  let result: any;
  try { result = await hussRequest(channel, '/videos', request, key); }
  catch (error) {
    if (!(error instanceof HussApiError) || !error.uncertain) throw error;
    if (input.model === HUSS_HSS_MODEL) throw error; // Persisted replay is handled by recovery, never legacy GET.
    let receipt: Awaited<ReturnType<typeof recoverHussSubmission>>;
    try { receipt = await recoverHussSubmission(channel, key); } catch { throw error; }
    if (receipt.state === 'accepted') return receipt.taskId;
    if (receipt.state === 'rejected') throw new HussApiError(receipt.error, error.status, false);
    throw error;
  }
  const id = result?.id ?? result?.data?.id;
  if (input.model === HUSS_HSS_MODEL && (typeof id !== 'string' || !/^video_[A-Za-z0-9_-]+$/.test(id))) throw new HussApiError(hussFailure('异步任务编号无效', result, 202, undefined, channel.apiKey), 202, true);
  if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).trim()) throw new HussApiError(hussFailure('未返回任务编号，提交结果待核实', result, 202, undefined, channel.apiKey), 202, true);
  if (input.model === HUSS_HSS_MODEL && result?.status === 'completed' && result?.url) {
    try { onAccepted?.(result); }
    catch (error) { throw new HussApiError(hussFailure('已受理任务凭据保存异常', error, 202, undefined, channel.apiKey), 202, true); }
  }
  return String(id);
}
export function normalizeHussTask(raw: any, baseUrl: string, taskId?: string) {
  const data = raw?.data && typeof raw.data === 'object' ? raw.data : raw; const original = String(data?.status || '').toLowerCase();
  if (taskId && [data?.id, data?.task_id].some(id => id != null && String(id) !== taskId)) throw new Error('HUSS 返回的任务编号不一致，继续核查原任务');
  let status = ({ queued: 'queued', pending: 'queued', processing: 'running', in_progress: 'running', running: 'running', completed: 'completed', succeeded: 'completed', success: 'completed', not_submitted: 'failed', failed: 'failed', rejected: 'failed', cancelled: 'cancelled', canceled: 'cancelled' } as Record<string, string>)[original];
  if (taskId?.startsWith('video_') && (data?.submission_uncertain === true || data?.recovery_status === 'manual_review_required')) status = 'running';
  if (!status) throw new Error(hussFailure('任务响应未包含有效状态 ' + original, data)); const rawUrl = data?.url || data?.output?.url || data?.output?.video_url || data?.video_url || '';
  const storagePending = status === 'completed' && data?.storage_status === 'pending';
  if (storagePending) status = 'running';
  if (status === 'completed' && !rawUrl) throw new Error(hussFailure('任务已完成但缺少成品地址，继续查询原任务', data));
  const url = rawUrl ? new URL(rawUrl, hussApiBase(baseUrl) + '/') : null; if (url && (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)) throw new Error('HUSS 视频结果地址无效');
  const phaseText: Record<string, string> = { queued: 'HUSS 已保存任务，等待提交', submitting: 'HUSS 正在提交原任务', upstream_queued: 'HUSS 上游排队中', generating: 'HUSS 视频生成中', saving: 'HUSS 成品保存中', submission_uncertain: 'HUSS 原任务接单结果待核对，保留任务编号继续查询' };
  return { status, storagePending, progressText: data?.recovery_status === 'manual_review_required' ? 'HUSS 自动核对窗口已结束，请联系上游核对原任务；未重新生成或退款' : phaseText[data?.phase] || '', phase: String(data?.phase || ''), progressKnown: typeof data?.progress === 'number' && Number.isFinite(data.progress) || status === 'completed', progress: Math.max(0, Math.min(100, Number(data?.progress) || (status === 'completed' ? 100 : 0))), resultUrl: status === 'completed' ? url?.href || '' : '', error: typeof data?.error === 'string' ? data.error : data?.error?.message || data?.message || '', errorCode: data?.error?.code || data?.error_code || '' };
}
export async function pollHussVideo(channel: HussChannel, taskId: string) {
  const raw = await hussRequest(channel, '/videos/' + encodeURIComponent(taskId));
  const task = normalizeHussTask(raw, channel.baseUrl, taskId);
  if (['failed', 'cancelled'].includes(task.status)) task.error = hussFailure('任务 ' + taskId + ' ' + task.status, raw?.data || raw, undefined, undefined, channel.apiKey);
  return task;
}

/** Legacy BB: read-only receipt. HSS: documented identical-key/payload replay, never a new key. */
export async function recoverHussSubmission(channel: HussChannel, key: string, snapshot?: Record<string, any>) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new Error('HUSS 原提交编号无效');
  if (snapshot?.model === HUSS_HSS_MODEL) {
    if (snapshot.idempotency_key !== key) throw new Error('HUSS 原请求快照与幂等编号不匹配，未重放');
    if (typeof snapshot.prompt !== 'string' || !['images','videos','audios'].every(field => snapshot[field] === undefined || Array.isArray(snapshot[field]) && snapshot[field].every((url: unknown) => typeof url === 'string'))) throw new Error('HUSS 原请求快照不完整，未重放');
    hussVideoParameters({ model: HUSS_HSS_MODEL, prompt: snapshot.prompt, seconds: snapshot.duration, ratio: snapshot.ratio, resolution: snapshot.resolution,
      images: snapshot.images || [], videos: snapshot.videos || [], audios: snapshot.audios || [], idempotencyKey: key, publicBaseUrl: '' });
    const { idempotency_key: _, ...request } = snapshot;
    {
      // Documented same-account/key/parameters replay returns the original video ID.
      const raw = await hussRequest(channel, '/videos', request, key);
      if (typeof raw?.id === 'string' && /^video_[A-Za-z0-9_-]+$/.test(raw.id))
        return { state: 'accepted' as const, taskId: raw.id, error: '', initialTask: raw };
      return { state: 'unknown' as const, taskId: '', error: hussFailure('异步回执缺少 video_ 编号', raw) };
    }
  }
  const raw = await hussRequest(channel, '/videos/submissions', undefined, key);
  const receipt = raw?.data && typeof raw.data === 'object' ? raw.data : raw;
  if (receipt?.status === 'accepted' && typeof receipt.task_id === 'string' && receipt.task_id.trim())
    return { state: 'accepted' as const, taskId: receipt.task_id.trim(), error: '' };
  if (['rejected', 'not_submitted'].includes(receipt?.status) && !receipt.task_id && receipt.submission_uncertain !== true && (receipt.error?.code || receipt.code) !== 'idempotency_conflict')
    return { state: 'rejected' as const, taskId: '', error: hussFailure('原提交回执 ' + receipt.status, receipt, undefined, undefined, channel.apiKey) };
  return { state: receipt?.status === 'processing' ? 'pending' as const : 'unknown' as const, taskId: '', error: hussFailure('原提交回执', receipt, undefined, undefined, channel.apiKey) };
}
