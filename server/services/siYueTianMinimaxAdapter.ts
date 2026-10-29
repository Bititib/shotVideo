import { SI_YUE_TIAN_MINIMAX_MODEL, siYueTianMinimaxInputErrors, isSiYueTianVideoHost } from '../../shared/siYueTianMinimax.js';
import type { SpecificationRequest } from './specificationAdapters.js';
import { fetchVideoTaskResponse } from './videoPollDeadline.js';
import { upstreamDiagnostic, transportDiagnostic } from './upstreamDiagnostic.js';
import { videoRequestNotSent } from './videoSubmissionErrors.js';

const base = (url: string) => url.replace(/\/+$/, '').replace(/\/v1$/i, '');
const dataOf = (raw: any) => raw?.data && !Array.isArray(raw.data) ? raw.data : raw;
export function siYueTianMinimaxTaskId(raw: any): string {
  const data = dataOf(raw);
  const ids = [...new Set([raw?.task_id, raw?.taskId, raw?.id, data?.task_id, data?.taskId, data?.id].filter(id => typeof id === 'string' && /^task_[\w-]+$/.test(id)))];
  if (ids.length > 1) throw new Error('四月天响应的任务编号不一致，需核实原提交');
  return ids[0] || '';
}
export class SiYueTianMinimaxError extends Error {
  constructor(message: string, public uncertain: boolean, public status = 0) { super(message); }
}
export function buildSiYueTianMinimaxPayload(request: SpecificationRequest, publish: (url: string) => string) {
  const errors = siYueTianMinimaxInputErrors(request.input);
  if (errors.length) throw new SiYueTianMinimaxError(errors.join('；'), false);
  return { model: SI_YUE_TIAN_MINIMAX_MODEL, prompt: request.prompt, duration: request.input.seconds,
    // The fixed-2K model follows the supplied image's ratio; no competing ratio is sent.
    ...(!request.images.length && !request.firstFrame && !request.lastFrame ? { aspect_ratio: request.input.ratio } : {}),
    ...(request.images.length ? { image_refs: request.images.map(publish) } : {}),
    ...(request.videos.length ? { video_refs: request.videos.map(publish) } : {}),
    ...(request.audios.length ? { audio_refs: request.audios.map(publish) } : {}),
    ...(request.firstFrame ? { first_frame: publish(request.firstFrame) } : {}),
    ...(request.lastFrame ? { last_frame: publish(request.lastFrame) } : {}) };
}
export function normalizeSiYueTianMinimaxTask(raw: any, channel: any, taskId: string) {
  const returnedId = siYueTianMinimaxTaskId(raw);
  if (returnedId && returnedId !== taskId) throw new Error('四月天查询返回了不同任务编号，继续核实原任务');
  const data = dataOf(raw), status = String(data?.status || raw?.status || '').toLowerCase();
  const failure = ['failed', 'error', 'cancelled', 'canceled', 'failure'].includes(status);
  const success = ['completed', 'succeeded', 'success', 'done'].includes(status);
  const progress = Number(String(data?.progress ?? '').replace('%', ''));
  const source = data?.url || data?.video_url || data?.result_url || data?.output?.url || data?.output?.video_url
    || data?.result?.url || data?.result?.video_url || '';
  const diagnostic = upstreamDiagnostic('四月天 MiniMax H3', '任务 task_id=' + taskId, data, channel.apiKey);
  if (!status || !failure && data?.error) throw new Error(diagnostic);
  return { status, progress: success ? 100 : progress, progressKnown: success || data?.progress !== undefined && Number.isFinite(progress),
    resultUrl: success ? source ? new URL(source, base(channel.baseUrl) + '/').href : base(channel.baseUrl) + '/v1/videos/' + encodeURIComponent(taskId) + '/content' : '',
    error: failure ? diagnostic : '' };
}
export async function submitSiYueTianMinimax(channel: any, request: SpecificationRequest,
  publish: (url: string) => string, onStarting: (meta?: Record<string, unknown>) => void) {
  if (!isSiYueTianVideoHost(channel.baseUrl)) throw new SiYueTianMinimaxError('MiniMax H3 此线路须使用四月天渠道', false);
  const payload = buildSiYueTianMinimaxPayload(request, publish);
  onStarting();
  let response: Response;
  try {
    response = await fetchVideoTaskResponse(base(channel.baseUrl) + '/v1/videos', { method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer ' + channel.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, channel.timeout || 120_000);
  } catch (error: any) { throw new SiYueTianMinimaxError(transportDiagnostic('四月天 MiniMax H3', '提交', error, channel.apiKey), !videoRequestNotSent(error)); }
  const text = await response.text();
  let raw: any;
  try { raw = JSON.parse(text); }
  catch { throw new SiYueTianMinimaxError(upstreamDiagnostic('四月天 MiniMax H3', '提交响应非 JSON，受理结果未知', text, channel.apiKey, response.status), true, response.status); }
  let taskId: string;
  try { taskId = siYueTianMinimaxTaskId(raw); }
  catch (error: any) { throw new SiYueTianMinimaxError(error.message, true, response.status); }
  // Save the original receipt before interpreting a gateway HTTP error or a terminal task state.
  if (taskId) {
    const state = String(dataOf(raw)?.status || '').toLowerCase();
    onStarting({ videoId: taskId, upstreamTaskId: taskId,
      ...(['completed', 'succeeded', 'success', 'done', 'failed', 'error', 'cancelled', 'canceled', 'failure'].includes(state)
        ? { siYueTianMinimaxInitialTask: raw } : {}) });
    return taskId;
  }
  const data = dataOf(raw);
  const explicitError = typeof data?.error === 'string' && Boolean(data.error.trim())
    || typeof data?.error?.message === 'string' && Boolean(data.error.message.trim());
  const terminal = ['failed', 'error', 'cancelled', 'canceled', 'failure'].includes(String(data?.status || '').toLowerCase());
  // Follow the existing channel's OpenAI error envelope; HTTP status alone proves neither acceptance nor rejection.
  const rejected = terminal || explicitError && response.status < 500 && response.status !== 408;
  throw new SiYueTianMinimaxError(upstreamDiagnostic('四月天 MiniMax H3', rejected ? '提交被拒绝' : '提交未取得任务编号，受理结果未知', raw, channel.apiKey, response.status), !rejected, response.status);
}
export async function pollSiYueTianMinimax(channel: any, taskId: string) {
  const response = await fetchVideoTaskResponse(base(channel.baseUrl) + '/v1/videos/' + encodeURIComponent(taskId), {
    headers: { Authorization: 'Bearer ' + channel.apiKey, 'Cache-Control': 'no-cache, no-store' }, cache: 'no-store', redirect: 'error' });
  const text = await response.text();
  let raw: any; try { raw = JSON.parse(text); } catch { raw = text; }
  if (!response.ok || typeof raw !== 'object' || !raw) throw new Error(upstreamDiagnostic('四月天 MiniMax H3', '查询原任务 task_id=' + taskId, raw, channel.apiKey, response.status));
  return normalizeSiYueTianMinimaxTask(raw, channel, taskId);
}
