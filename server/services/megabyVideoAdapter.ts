import { MEGABY_CHANNEL_TYPE, MEGABY_VIDEO_MODELS, megabyVideoLimits } from '../../shared/megabyVideo.js';
import { upstreamDiagnostic, transportDiagnostic } from './upstreamDiagnostic.js';
import { probeVideoDurationSeconds, probeAudioDurationSeconds } from './videoDurationProbe.js';
export class MegabyApiError extends Error {
  constructor(message: string, public code: string, public upstreamStatus = 0, public uncertain = false, public confirmedFailure = false) { super(message); }
}
const parseMegabyError = (raw: any) => ({ code: typeof raw?.error?.code === 'string' ? raw.error.code : '', message: typeof raw?.error?.message === 'string' ? raw.error.message : typeof raw?.error === 'string' ? raw.error : typeof raw?.message === 'string' ? raw.message : '' });
const upstreamProtocolError = (channel: any, code: string, message: string, phase: string, status = 0) => new MegabyApiError(upstreamDiagnostic('Megaby', phase, { code, message }, channel.apiKey, status), code, status, phase === 'submit');
async function fetchUpstream(channel: MegabyChannel, url: string, init: RequestInit, phase: string, fetchImpl: typeof fetch) {
  try { return await fetchImpl(url, init); }
  catch (cause: any) { throw new MegabyApiError(transportDiagnostic('Megaby', phase, cause, channel.apiKey), cause?.cause?.code || cause?.code || 'NETWORK_ERROR', 0, phase === 'submit'); }
}
export async function readMegabyJson(channel: MegabyChannel, response: Response, phase: 'submit' | 'query'): Promise<any> {
  let raw: any;
  try { raw = await response.json(); }
  catch { throw upstreamProtocolError(channel, 'INVALID_JSON', '响应正文无法解析或未完整读取', phase, response.status); }
  // Queries returning a failed task are task results, not failed HTTP queries.
  if (!response.ok || raw?.error && !(phase === 'query' && raw?.status === 'failed')) {
    const detail = parseMegabyError(raw);
    throw new MegabyApiError(upstreamDiagnostic('Megaby', phase, { error: detail }, channel.apiKey, response.status, response.headers.get('x-request-id') || (typeof raw?.request_id === 'string' ? raw.request_id : undefined)), detail.code || 'UPSTREAM_ERROR', response.status, phase === 'submit');
  }
  return raw;
}
const readUpstreamJson = readMegabyJson;

export type MegabyChannel = { type?: string | null; baseUrl: string; apiKey: string; timeout?: number };
export type MegabyVideoInput = {
  model: string; prompt: string; seconds: number; ratio: string; resolution: string;
  images: string[]; videos: string[]; audios: string[]; firstFrame: string; lastFrame: string;
};
export const isMegabyChannel = (channel: { type?: string | null; baseUrl?: string | null } | null | undefined): boolean => {
  if (channel?.type === MEGABY_CHANNEL_TYPE) return true;
  try { return new URL(channel?.baseUrl || '').hostname === 'newapi.megabyai.cc'; } catch { return false; }
};
export function megabyBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Megaby 接口地址无效');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '') || '/';
  return url.href.replace(/\/$/, '');
}
export const megabyCreateUrl = (baseUrl: string) => megabyBaseUrl(baseUrl) + '/v1/videos';
export const megabyTaskUrl = (baseUrl: string, taskId: string) => megabyCreateUrl(baseUrl) + '/' + encodeURIComponent(taskId);
export const megabyContentUrl = (baseUrl: string, taskId: string) => megabyTaskUrl(baseUrl, taskId) + '/content';
export const shouldSendMegabyAuthorization = (url: string, baseUrl: string, taskId: string) => url === megabyContentUrl(baseUrl, taskId);

/** The content endpoint may redirect to storage. Recompute credentials per hop. */
export async function fetchMegabyVideoContent(channel: MegabyChannel, source: string, taskId: string, fetchImpl: typeof fetch = fetch): Promise<Response> {
  let url = publicMediaUrl(source);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const headers: Record<string, string> = {};
    if (channel.apiKey && shouldSendMegabyAuthorization(url, channel.baseUrl, taskId)) headers.Authorization = 'Bearer ' + channel.apiKey;
    const response = await fetchUpstream(channel, url, { headers, signal: AbortSignal.timeout(300_000), redirect: 'manual' }, 'query', fetchImpl);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location || redirects === 5) throw upstreamProtocolError(channel, 'INVALID_VIDEO_REDIRECT', 'Megaby 视频下载跳转地址缺失或跳转次数过多', 'query', response.status);
    try { url = publicMediaUrl(new URL(location, url).href); }
    catch (cause) { throw upstreamProtocolError(channel, 'INVALID_VIDEO_REDIRECT', 'Megaby 视频下载跳转地址无效', 'query', response.status); }
  }
  throw upstreamProtocolError(channel, 'INVALID_VIDEO_REDIRECT', 'Megaby 视频下载跳转次数过多', 'query');
}

function publicMediaUrl(source: string): string {
  let url: URL;
  try { url = new URL(source); } catch { throw new Error('Megaby 参考素材必须使用公网 HTTP/HTTPS 链接'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Megaby 参考素材必须使用公网 HTTP/HTTPS 链接');
  return source;
}
export function validateMegabyVideoInput(input: MegabyVideoInput): void {
  const limits = megabyVideoLimits();
  if (!(MEGABY_VIDEO_MODELS as readonly string[]).includes(input.model)) throw new Error('Megaby 视频模型不受支持');
  if (!input.prompt.trim()) throw new Error('请输入视频提示词');
  if (input.firstFrame || input.lastFrame) throw new Error('Megaby 暂不支持独立首尾帧，请使用普通参考图');
  if (!Number.isInteger(input.seconds) || input.seconds < 4 || input.seconds > 15) throw new Error('Megaby 视频时长必须为 4–15 秒整数');
  if (!limits.ratios.includes(input.ratio)) throw new Error('Megaby 仅支持 16:9、9:16、1:1');
  if (!limits.resolutions.includes(input.resolution)) throw new Error('Megaby 仅支持 720p、480p');
  if (input.images.length > 9 || input.videos.length > 3 || input.audios.length > 3) throw new Error('Megaby 最多支持 9 张参考图、3 个参考视频和 3 个参考音频');
}
export function buildMegabyVideoPayload(input: MegabyVideoInput) {
  validateMegabyVideoInput(input);
  return { model: input.model, prompt: input.prompt.trim(), duration: input.seconds, ratio: input.ratio, resolution: input.resolution,
    ...(input.images.length ? { referenceImages: input.images.map(publicMediaUrl) } : {}),
    ...(input.videos.length ? { referenceVideos: input.videos.map(publicMediaUrl) } : {}),
    ...(input.audios.length ? { referenceAudios: input.audios.map(publicMediaUrl) } : {}) };
}

/** Probe actual media, rather than trusting client-supplied durations. */
export async function validateMegabyReferenceDurations(videos: string[], audios: string[]): Promise<void> {
  const [videoDurations, audioDurations] = await Promise.all([
    Promise.all(videos.map(source => probeVideoDurationSeconds(source, { allowHttp: true, maxBytes: 200 * 1024 * 1024 }))),
    Promise.all(audios.map(source => probeAudioDurationSeconds(source, { allowHttp: true, maxBytes: 50 * 1024 * 1024 }))),
  ]);
  for (const [label, durations] of [['视频', videoDurations], ['音频', audioDurations]] as const) {
    if (durations.some(n => !Number.isFinite(n) || n <= 0) || durations.reduce((sum, n) => sum + n, 0) > 15) {
      throw new Error('Megaby 参考' + label + '总时长不能超过 15 秒');
    }
  }
}
async function getJson(channel: MegabyChannel, url: string, fetchImpl: typeof fetch) {
  const response = await fetchUpstream(channel, url, { headers: { Authorization: 'Bearer ' + channel.apiKey },
    signal: AbortSignal.timeout(channel.timeout || 30_000), redirect: 'error' }, 'query', fetchImpl);
  return readUpstreamJson(channel, response, 'query');
}
export async function fetchMegabyVideoModels(channel: MegabyChannel, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const raw = await getJson(channel, megabyBaseUrl(channel.baseUrl) + '/v1/models', fetchImpl);
  if (!Array.isArray(raw?.data) || raw.data.some((item: any) => typeof item?.id !== 'string' || !item.id.trim())) {
    throw upstreamProtocolError(channel, 'INVALID_MODEL_LIST', 'Megaby 模型列表格式无效', 'query');
  }
  return [...new Set<string>(raw.data.map((item: any) => item.id))].filter(id => (MEGABY_VIDEO_MODELS as readonly string[]).includes(id));
}
export function normalizeMegabyTask(raw: any, baseUrl: string, taskId: string, secret = '') {
  const channel = { type: MEGABY_CHANNEL_TYPE, baseUrl };
  if ([raw?.task_id, raw?.id].some(id => id !== undefined && id !== null && String(id) !== taskId)) {
    throw upstreamProtocolError(channel, 'TASK_ID_MISMATCH', 'Megaby 返回的任务 ID 不一致，继续核实原任务', 'query');
  }
  const status = raw?.status;
  if (!['queued', 'in_progress', 'completed', 'failed'].includes(status)) {
    throw upstreamProtocolError(channel, 'INVALID_TASK_STATUS', 'Megaby 返回了未知任务状态', 'query');
  }
  let resultUrl = '';
  if (status === 'completed') {
    const source = raw.video_url || raw.url || raw.metadata?.content_url || raw.metadata?.local_url || megabyContentUrl(baseUrl, taskId);
    try { resultUrl = publicMediaUrl(source); }
    catch (cause) { throw upstreamProtocolError(channel, 'INVALID_VIDEO_URL', 'Megaby 视频结果地址无效', 'query'); }
  }
  const error = parseMegabyError(raw);
  return { status, progress: status === 'completed' || status === 'failed' ? 100 : Math.max(0, Math.min(100, Number(raw.progress) || 0)),
    resultUrl, error: status === 'failed' ? upstreamDiagnostic('Megaby', '任务失败 task_id=' + taskId, { error }, secret, 200) : '', errorCode: error.code };
}
export async function pollMegabyVideo(channel: MegabyChannel, taskId: string, fetchImpl: typeof fetch = fetch) {
  return normalizeMegabyTask(await getJson(channel, megabyTaskUrl(channel.baseUrl, taskId), fetchImpl), channel.baseUrl, taskId, channel.apiKey);
}

/** Megaby has no documented submission lookup or POST idempotency guarantee. */
export async function submitMegabyVideo(channel: MegabyChannel, payload: ReturnType<typeof buildMegabyVideoPayload>, onStarting: (metadata?: Record<string, unknown>) => void, fetchImpl: typeof fetch = fetch): Promise<string> {
  onStarting();
  const response = await fetchUpstream(channel, megabyCreateUrl(channel.baseUrl), {
    method: 'POST', headers: { Authorization: 'Bearer ' + channel.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(channel.timeout || 120_000), redirect: 'error',
  }, 'submit', fetchImpl);
  let raw: any;
  try { raw = await response.json(); }
  catch { throw upstreamProtocolError(channel, 'INVALID_JSON', '提交响应未完整读取或不是 JSON，无法确认是否受理', 'submit', response.status); }
  const detail = parseMegabyError(raw);
  const message = upstreamDiagnostic('Megaby', '提交', { error: detail, message: detail.message || '未返回有效任务回执' }, channel.apiKey, response.status, response.headers.get('x-request-id') || (typeof raw?.request_id === 'string' ? raw.request_id : undefined));
  const validId = (value: any): value is string => typeof value === 'string' && Boolean(value.trim());
  const ids = [raw?.task_id, raw?.id].filter(value => value !== undefined && value !== null);
  if (ids.length) {
    if (ids.some(id => !validId(id)) || new Set(ids).size !== 1) throw new MegabyApiError(message + '；任务编号无效或冲突', 'INVALID_TASK_ID', response.status, true);
    const taskId = ids[0] as string;
    // Persist receipt BEFORE processing errors or querying: an error field does not erase acceptance.
    onStarting({ videoId: taskId, upstreamTaskId: taskId,
      ...(response.ok && ['completed', 'failed'].includes(raw?.status) ? { megabyInitialTask: { ...raw, error: { code: detail.code, message: detail.message.split(channel.apiKey || '\0').join('[密钥已隐藏]') } } } : {}) });
    return taskId;
  }
  const validationCodes = ['unsupported_material', 'material_policy_violation', 'unsupported_request', 'content_policy_violation', 'material_limit_exceeded'];
  const terminal = raw?.status === 'failed';
  const conflicting = ['queued', 'in_progress', 'completed'].includes(raw?.status);
  // Explicit client rejection envelopes, excluding timeout/conflict and proxy HTML.
  const clientRejection = [400, 401, 402, 403, 404, 405, 413, 415, 422, 429].includes(response.status) && Boolean(detail.code || detail.message) && Boolean(raw?.error);
  const rejected = !conflicting && (terminal || clientRejection || response.status < 500 && response.status !== 408 && validationCodes.includes(detail.code));
  throw new MegabyApiError(message, detail.code || 'MISSING_TASK_ID', response.status, !rejected, rejected);
}
