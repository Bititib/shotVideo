import { createHash } from 'node:crypto';
import { wanfengBaseUrl, wanfengVideoLimits } from '../../shared/wanfengVideo.js';
import { diagnosticJson, responseDiagnostic, transportDiagnostic, upstreamDiagnostic } from './upstreamDiagnostic.js';

type Channel = { baseUrl: string; apiKey: string; timeout?: number };
type Input = {
  model: string; prompt: string; seconds: number; ratio: string; resolution: string;
  images: string[]; videos: string[]; audios: string[]; firstFrame: string; lastFrame: string; generateAudio?: boolean;
};

export class WanfengSubmissionError extends Error {
  constructor(message: string, readonly status = 0, readonly confirmedFailure = false) { super(message); }
}

export const wanfengCredential = (channel: Channel) =>
  createHash('sha256').update(JSON.stringify([wanfengBaseUrl(channel.baseUrl), channel.apiKey])).digest('hex');

export const wanfengTaskUrl = (channel: Channel, id: string) =>
  wanfengBaseUrl(channel.baseUrl) + '/v1/videos/' + encodeURIComponent(id);

export function buildWanfengVideoPayload(input: Input) {
  if (!wanfengVideoLimits(input.model)) throw new Error('晚风公开视频目录中没有该上游型号');
  const { images, videos, audios, firstFrame, lastFrame } = input;
  return {
    model: input.model, prompt: input.prompt, duration: input.seconds, resolution: input.resolution,
    aspect_ratio: input.ratio, generateAudio: input.generateAudio ?? true,
    ...(images.length ? { images } : {}), ...(videos.length ? { videos } : {}), ...(audios.length ? { audios } : {}),
    ...(firstFrame ? { first_image: firstFrame } : {}), ...(lastFrame ? { last_image: lastFrame } : {}),
  };
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]{1,160}$/.test(value);
}

function resultUrl(value: unknown) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch { /* Use the authenticated content endpoint. */ }
  return '';
}

function normalizeTask(channel: Channel, id: string, raw: any) {
  const status = raw?.status === 'in_progress' ? 'processing' : raw?.status;
  if (!['queued', 'processing', 'completed', 'failed'].includes(status)) {
    throw new Error(upstreamDiagnostic('晚风', '查询返回未知任务状态', { status }, channel.apiKey, 200, id));
  }
  return {
    status, progress: typeof raw.progress === 'number' ? raw.progress : status === 'completed' ? 100 : 0,
    resultUrl: status === 'completed' ? [raw.video_url, raw.result_url, raw.url, raw.data?.[0]?.url,
      Array.isArray(raw.output) ? raw.output.find((item: any) => item?.type === 'video')?.url : undefined]
      .map(resultUrl).find(Boolean) || wanfengTaskUrl(channel, id) + '/content' : '',
    error: status === 'failed' ? upstreamDiagnostic('晚风', '任务失败', { error: raw.error }, channel.apiKey, 200, id) : '',
  };
}

export async function createWanfengVideo(channel: Channel, payload: ReturnType<typeof buildWanfengVideoPayload>) {
  let response: Response;
  try {
    response = await fetch(wanfengBaseUrl(channel.baseUrl) + '/v1/videos', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(channel.timeout || 120_000),
      headers: { Authorization: 'Bearer ' + channel.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new WanfengSubmissionError(transportDiagnostic('晚风', '提交', error, channel.apiKey));
  }
  const requestId = response.headers.get('x-request-id') || undefined;
  let raw: any;
  try { raw = await diagnosticJson('晚风', '提交', response, channel.apiKey); }
  catch (error) { throw new WanfengSubmissionError((error as Error).message, response.status); }
  const id = validId(raw?.id) ? raw.id : undefined;
  const taskId = validId(raw?.task_id) ? raw.task_id : undefined;
  const code = raw?.error?.code;
  const reason = upstreamDiagnostic('晚风', '提交', { error: raw?.error, status: raw?.status }, channel.apiKey, response.status, requestId);
  if (id && taskId && id !== taskId) throw new WanfengSubmissionError(reason + '，创建回执的 id 与 task_id 不一致', response.status);
  const queryId = id || taskId;
  if (queryId) {
    return { id: queryId, taskId,
      initial: raw.status === 'completed' || raw.status === 'failed' ? normalizeTask(channel, queryId, raw) : undefined };
  }
  const rejected = code === 'invalid_request_error' && typeof raw.error.message === 'string'
    && (response.ok || [400, 422].includes(response.status)) && !['queued', 'processing', 'in_progress', 'completed'].includes(raw?.status);
  throw new WanfengSubmissionError(rejected ? reason : reason + '，未取得可查询任务编号', response.status, rejected);
}

export async function pollWanfengVideo(channel: Channel, id: string) {
  const response = await fetch(wanfengTaskUrl(channel, id), {
    headers: { Authorization: 'Bearer ' + channel.apiKey }, redirect: 'error', cache: 'no-store',
    signal: AbortSignal.timeout(Math.min(channel.timeout || 30_000, 30_000)),
  });
  if (!response.ok) {
    const message = await responseDiagnostic('晚风', '查询', response, channel.apiKey);
    throw Object.assign(new Error(message), { status: response.status });
  }
  const raw = await diagnosticJson('晚风', '查询', response, channel.apiKey);
  if (validId(raw?.id) && raw.id !== id && raw.task_id !== id) throw new Error('晚风查询回执与原任务编号不符');
  return normalizeTask(channel, id, raw);
}

export function matchesWanfengCredential(channel: Channel & { type?: string }, original: unknown) {
  if (channel.type !== 'wanfeng' || typeof original !== 'string' || !channel.apiKey) return false;
  try { return wanfengCredential(channel) === original; } catch { return false; }
}

function deliveryUrl(value: string) {
  const href = resultUrl(value);
  if (!href) return '';
  const url = new URL(href);
  return !url.port && ['api.pro666.top', 'video.pro666.top'].includes(url.hostname) ? href : '';
}

export async function fetchWanfengVideoContent(channel: Channel, id: string, source: string) {
  const content = wanfengTaskUrl(channel, id) + '/content';
  const direct = deliveryUrl(source);
  if (direct && direct !== content) {
    try {
      const response = await fetch(direct, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (response.ok) return response;
      await response.body?.cancel();
    } catch { /* Fall back to the original task's authenticated download. */ }
  }
  let response = await fetch(content, {
    headers: { Authorization: 'Bearer ' + channel.apiKey }, redirect: 'manual', signal: AbortSignal.timeout(300_000),
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    await response.body?.cancel();
    const redirected = location && deliveryUrl(new URL(location, content).href);
    if (!redirected || redirected === content) throw new Error('晚风下载返回了未确认的重定向地址');
    response = await fetch(redirected, { redirect: 'error', signal: AbortSignal.timeout(300_000) });
  }
  if (!response.ok) throw new Error(await responseDiagnostic('晚风', '下载', response, channel.apiKey));
  return response;
}
