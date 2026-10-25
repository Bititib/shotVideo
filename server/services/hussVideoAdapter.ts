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
    const response = await fetch(url, { method: 'GET', redirect: 'manual', signal,
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
export class HussApiError extends Error { constructor(message: string, readonly status: number, readonly uncertain = false) { super(message); } }
async function hussRequest(channel: HussChannel, endpoint: string, body?: unknown, idempotencyKey?: string) {
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
  const failure = payload?.error || payload?.code && payload.code !== 0;
  if (!response.ok || failure) {
    throw new HussApiError(hussFailure(endpoint, payload, response.status, requestId, channel.apiKey), response.status || 502,
      generation && (Boolean(videoErrorTaskId(payload, response.headers)) || response.status === 400 || response.status === 409 || response.status === 408 || response.status >= 500 || state === 'submission_uncertain'));
  }
  return payload;
}
export function hussBbModelLimits(): ModelInputLimits { return { maxImages: 30, maxVideos: 10, maxAudios: 10, maxOutputs: 1, minImages: 0, resolutions: ['720p'], ratios: ['16:9', '9:16', '1:1'], qualities: [], firstFrame: false, lastFrame: false, duration: { mode: 'range', min: 10, max: 30, step: 1, values: [] } }; }
export async function fetchHussVideoModels(channel: HussChannel): Promise<HussVideoModel[]> {
  const raw = await hussRequest(channel, '/models'); const candidates = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.models) ? raw.models : [];
  if (!candidates.some((item: any) => (typeof item === 'string' ? item : item?.id) === HUSS_BB_MODEL)) throw new Error('HUSS 当前 API Key 未开放 bb-seedance2.5-301010 模型');
  return [{ id: HUSS_BB_MODEL, name: HUSS_BB_MODEL, type: 'video', config: { limits: hussBbModelLimits() } }];
}
export function hussVideoParameters(input: HussVideoInput) {
  const limits = hussBbModelLimits();
  if (input.model !== HUSS_BB_MODEL) throw new Error('HUSS 当前仅支持 bb-seedance2.5-301010');
  if (input.firstFrame || input.lastFrame) throw new Error('HUSS bb-seedance2.5-301010 不支持独立首尾帧，请作为普通参考图片提交');
  if (!input.prompt.trim() || Array.from(input.prompt.trim()).length > 20_000) throw new Error('HUSS 提示词长度须为 1–20000 字符');
  if (!Number.isInteger(input.seconds) || input.seconds < 10 || input.seconds > 30) throw new Error('HUSS bb-seedance2.5-301010 视频时长须为 10–30 秒整数');
  if (input.resolution !== '720p' || !limits.ratios.includes(input.ratio)) throw new Error('HUSS bb-seedance2.5-301010 仅支持 720p 和 16:9、9:16、1:1');
  if (input.images.length > 30 || input.videos.length > 10 || input.audios.length > 10) throw new Error('HUSS 参考素材数量超过模型上限');
  const key = input.idempotencyKey || randomUUID(); if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new Error('HUSS 请求标识仅支持 1–128 位字母、数字、点、下划线、冒号和短横线');
  return { key, payload: { model: HUSS_BB_MODEL, prompt: input.prompt.trim(), duration: input.seconds, ratio: input.ratio, resolution: input.resolution } };
}
export async function submitHussVideo(channel: HussChannel, input: HussVideoInput, beforeSubmit: (payload: Record<string, unknown>) => void) {
  const { key, payload } = hussVideoParameters(input); const publish = (items: string[]) => items.map(item => publishReferenceUrl(item, input.publicBaseUrl));
  const request = { ...payload, ...(input.images.length ? { reference_images: publish(input.images) } : {}), ...(input.videos.length ? { videos: publish(input.videos) } : {}), ...(input.audios.length ? { audios: publish(input.audios) } : {}) };
  beforeSubmit({ ...request, idempotency_key: key });
  let result: any;
  try { result = await hussRequest(channel, '/videos', request, key); }
  catch (error) {
    if (!(error instanceof HussApiError) || !error.uncertain) throw error;
    let receipt: Awaited<ReturnType<typeof recoverHussSubmission>>;
    try { receipt = await recoverHussSubmission(channel, key); } catch { throw error; }
    if (receipt.state === 'accepted') return receipt.taskId;
    if (receipt.state === 'rejected') throw new HussApiError(receipt.error, error.status, false);
    throw error;
  }
  const id = result?.id ?? result?.data?.id;
  if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).trim()) throw new HussApiError(hussFailure('未返回任务编号，提交结果待核实', result, 202, undefined, channel.apiKey), 202, true); return String(id);
}
export function normalizeHussTask(raw: any, baseUrl: string, taskId?: string) {
  const data = raw?.data && typeof raw.data === 'object' ? raw.data : raw; const original = String(data?.status || '').toLowerCase();
  if (taskId && [data?.id, data?.task_id].some(id => id != null && String(id) !== taskId)) throw new Error('HUSS 返回的任务编号不一致，继续核查原任务');
  let status = ({ queued: 'queued', pending: 'queued', processing: 'running', in_progress: 'running', running: 'running', completed: 'completed', succeeded: 'completed', success: 'completed', failed: 'failed', rejected: 'failed', cancelled: 'cancelled', canceled: 'cancelled' } as Record<string, string>)[original];
  if (!status) throw new Error(hussFailure('任务响应未包含有效状态 ' + original, data)); const rawUrl = data?.url || data?.output?.url || data?.output?.video_url || data?.video_url || '';
  const storagePending = status === 'completed' && data?.storage_status === 'pending';
  if (storagePending) status = 'running';
  if (status === 'completed' && !rawUrl) throw new Error(hussFailure('任务已完成但缺少成品地址，继续查询原任务', data));
  const url = rawUrl ? new URL(rawUrl, hussApiBase(baseUrl) + '/') : null; if (url && (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)) throw new Error('HUSS 视频结果地址无效');
  return { status, storagePending, progress: Math.max(0, Math.min(100, Number(data?.progress) || (status === 'completed' ? 100 : 0))), resultUrl: status === 'completed' ? url?.href || '' : '', error: typeof data?.error === 'string' ? data.error : data?.error?.message || data?.message || '', errorCode: data?.error?.code || data?.error_code || '' };
}
export async function pollHussVideo(channel: HussChannel, taskId: string) {
  const raw = await hussRequest(channel, '/videos/' + encodeURIComponent(taskId));
  const task = normalizeHussTask(raw, channel.baseUrl, taskId);
  if (['failed', 'cancelled'].includes(task.status)) task.error = hussFailure('任务 ' + taskId + ' ' + task.status, raw?.data || raw, undefined, undefined, channel.apiKey);
  return task;
}

/** Read-only lookup of the original synchronous submission; never repeats a paid POST. */
export async function recoverHussSubmission(channel: HussChannel, key: string) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new Error('HUSS 原提交编号无效');
  const raw = await hussRequest(channel, '/videos/submissions', undefined, key);
  const receipt = raw?.data && typeof raw.data === 'object' ? raw.data : raw;
  if (receipt?.status === 'accepted' && typeof receipt.task_id === 'string' && receipt.task_id.trim())
    return { state: 'accepted' as const, taskId: receipt.task_id.trim(), error: '' };
  if (['rejected', 'not_submitted'].includes(receipt?.status) && !receipt.task_id && receipt.submission_uncertain !== true && (receipt.error?.code || receipt.code) !== 'idempotency_conflict')
    return { state: 'rejected' as const, taskId: '', error: hussFailure('原提交回执 ' + receipt.status, receipt, undefined, undefined, channel.apiKey) };
  return { state: receipt?.status === 'processing' ? 'pending' as const : 'unknown' as const, taskId: '', error: hussFailure('原提交回执', receipt, undefined, undefined, channel.apiKey) };
}
