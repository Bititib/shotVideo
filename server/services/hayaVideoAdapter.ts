import { HAYA_BASE_URL } from '../../shared/hayaVideo.js';

export function isHayaChannel(channel: { type?: string | null; baseUrl?: string | null } | null | undefined): boolean {
  if (channel?.type === 'haya') return true;
  try { return new URL(channel?.baseUrl || '').hostname === new URL(HAYA_BASE_URL).hostname; } catch { return false; }
}
export function hayaApiBaseUrl(baseUrl: string): string { return baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, ''); }
export function hayaTaskUrl(baseUrl: string, taskId: string): string {
  if (!/^task_[A-Za-z0-9_-]+$/.test(taskId)) throw new Error('Haya 未返回有效的公开 task_ 任务 ID');
  return `${hayaApiBaseUrl(baseUrl)}/v1/videos/${encodeURIComponent(taskId)}`;
}
export function hayaTaskId(payload: any): string {
  const id = payload?.task_id || payload?.id;
  hayaTaskUrl(HAYA_BASE_URL, id);
  return id;
}
export function shouldSendHayaAuthorization(url: string, baseUrl: string): boolean {
  const target = new URL(url);
  return target.origin === new URL(hayaApiBaseUrl(baseUrl)).origin
    && !(target.searchParams.has('signature') && target.searchParams.has('expires'));
}
export function normalizeHayaTask(payload: any, baseUrl: string, taskId: string) {
  const status = String(payload.status || '');
  // Do not interpret a transient error envelope as a terminal task failure.
  if (!['queued', 'in_progress', 'completed', 'failed'].includes(status)) throw new Error('Haya 查询响应未包含有效任务状态');
  const code = String(payload.error?.code || '');
  const message = String(payload.error?.message || '');
  return {
    status,
    progress: Math.max(0, Math.min(100, Number(payload.progress) || 0)),
    resultUrl: status === 'completed' ? String(payload.metadata?.url || `${hayaTaskUrl(baseUrl, taskId)}/content`) : '',
    error: [code, message].filter(Boolean).join(': '),
  };
}
export function hayaPollDelay(failures: number): number { return Math.min(60_000, 12_000 * 2 ** Math.min(failures, 3)); }

export interface HayaVideoInput {
  model: string; prompt: string; seconds: number; ratio: string; resolution: string;
  images: string[]; videos: string[]; audios: string[]; metadata?: Record<string, unknown>;
}
export function buildHayaVideoPayload(input: HayaVideoInput) {
  return { model: input.model, prompt: input.prompt.trim(), seconds: input.seconds, ratio: input.ratio, resolution: input.resolution,
    ...(input.images.length ? { images: input.images } : {}), ...(input.videos.length ? { videos: input.videos } : {}),
    ...(input.audios.length ? { audios: input.audios } : {}), ...(input.metadata ? { metadata: input.metadata } : {}) };
}

export class HayaSubmissionError extends Error {
  constructor(message: string, readonly uncertain: boolean, readonly requestId = '') { super(message); }
}
/** A failed transport or malformed successful response may still represent a billed task. Never retry POST here. */
export async function submitHayaVideo(baseUrl: string, apiKey: string, input: HayaVideoInput,
  beforeSubmit: () => void, onRequestId: (requestId: string) => void = () => {}) {
  const body = JSON.stringify(buildHayaVideoPayload(input));
  beforeSubmit();
  let requestId = '';
  try {
    const response = await fetch(`${hayaApiBaseUrl(baseUrl)}/v1/videos`, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body,
      signal: AbortSignal.timeout(120_000), redirect: 'error',
    });
    requestId = response.headers.get('x-request-id') || response.headers.get('request-id') || '';
    onRequestId(requestId);
    if (!response.ok) {
      const uncertain = response.status === 408 || response.status >= 500;
      throw new HayaSubmissionError(`Haya 创建视频任务失败 (${response.status}): ${(await response.text()).slice(0, 500)}`, uncertain, requestId);
    }
    return { taskId: hayaTaskId(await response.json()), requestId };
  } catch (error: any) {
    if (error instanceof HayaSubmissionError) throw error;
    throw new HayaSubmissionError('Haya 提交结果待核实，请勿重复创建任务', true, requestId);
  }
}
