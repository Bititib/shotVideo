import { Agent } from 'undici';
import { DEFAULT_IMAGE_GENERATION_TIMEOUT_MS } from './imageGenerationTimeout.js';
import { extractImageUpstreamTaskId } from './imageTaskMetadataService.js';
import { pidoiTaskEvidence } from './pidoiImageEvidence.js';

const imageDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export function isPidoiImageChannel(channel: { baseUrl?: string; name?: string }) {
  try { const host = new URL(channel.baseUrl || '').hostname; return host === 'pidoi.com' || host.endsWith('.pidoi.com'); } catch { return false; }
}
type Channel = { baseUrl: string; apiKey: string; timeout?: unknown };
const apiBase = (c: Channel) => c.baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
const endpoint = (c: Channel) => apiBase(c) + '/v1/image/generations';
type PidoiImageTask = { taskId: string; status: 'processing' | 'completed' | 'failed'; progress: number; imageUrl: string; error: string; raw: any; pollPath?: string; protocol?: 'async' | 'openai-compatible' };
type SubmitOptions = {
  mode?: 'sync' | 'async-first';
  referenceImages?: string[];
  onResponse?: (response: Response, payload?: unknown) => void;
  onCompatibility?: () => void;
  onFallback?: (state: PidoiFallbackState) => void;
};
export type PidoiFallbackState = { protocol: 'async' | 'openai-compatible'; status: 'submitting' | 'accepted' | 'completed' | 'failed' | 'unknown'; reason: string; taskId?: string };
/** Snapshot this for a batch. Unknown/missing configuration safely selects one compatible POST. */
export function pidoiImageRequestMode(): 'sync' | 'async-first' {
  return process.env.PIDOI_IMAGE_REQUEST_MODE?.trim().toLowerCase() === 'async-first' ? 'async-first' : 'sync';
}
export class PidoiImageError extends Error {
  constructor(message: string, public confirmedFailure = false) { super(message); }
}
export function parsePidoiImageTask(raw: any): PidoiImageTask {
  const evidence = pidoiTaskEvidence(raw);
  if (evidence && raw?.code !== 'success') {
    const data = evidence.node;
    const state = String(data.status || data.task_status || '').toLowerCase();
    const status = ['completed', 'succeeded', 'success'].includes(state) ? 'completed'
      : ['failed', 'failure', 'cancelled', 'canceled'].includes(state) ? 'failed'
      : ['queued', 'pending', 'in_progress', 'processing', 'running'].includes(state) ? 'processing' : undefined;
    if (status) return { ...evidence, status, progress: Math.max(0, Math.min(100, parseFloat(data.progress) || 0)),
      imageUrl: status === 'completed' ? String(data.result_url || data.image_url || data.result?.image_url || data.metadata?.url || '') : '',
      error: status === 'failed' ? upstreamDiagnostic('Pidoi', '图片任务失败', { error: data.error, fail_reason: data.fail_reason, error_code: data.error_code }) : '', raw };
  }
  if (raw?.code !== 'success' || !raw.data) throw new PidoiImageError(upstreamDiagnostic('Pidoi', '图片任务查询失败', raw));
  const data = raw.data;
  const status = data.status === 'SUCCESS' ? 'completed' : data.status === 'FAILURE' ? 'failed' : 'processing';
  if (!['SUCCESS', 'FAILURE', 'IN_PROGRESS'].includes(data.status)) throw new PidoiImageError('Pidoi 返回未知任务状态');
  return { taskId: String(data.task_id || ''), pollPath: evidence?.pollPath, status, progress: Math.max(0, Math.min(100, parseFloat(data.progress) || 0)),
    imageUrl: status === 'completed' ? String(data.result_url || '') : '', error: status === 'failed' ? upstreamDiagnostic('Pidoi', '图片任务失败', { fail_reason: data.fail_reason, error: data.error, error_code: data.error_code }) : '', raw };
}

async function readResponse(c: Channel, response: Response, options: SubmitOptions = {}, submission = true) {
  const text = await response.text();
  let raw: any;
  try { raw = JSON.parse(text); } catch { /* Gateways also return plain-text route errors. */ }
  options.onResponse?.(response, raw);
  if (!response.ok) {
    // Only a definite rejection can release funds or select a compatibility endpoint.
    // A task identifier overrides HTTP status: the submission may have been accepted.
    const evidence = pidoiTaskEvidence(raw || text);
    const headerId = response.headers.get('x-task-id') || '';
    const taskId = evidence?.taskId || (/^[A-Za-z0-9_-]{1,200}$/.test(headerId) ? headerId : '');
    const rejected = submission && !taskId && [400, 401, 402, 403, 404, 405, 413, 415, 422, 429, 451].includes(response.status);
    const message = String(raw?.error?.message || raw?.message || text).trim();
    const routeUnavailable = rejected && [404, 405].includes(response.status)
      && (/^(?:404\s+)?(?:page\s+)?not found[.!]?$/i.test(message)
        || /cannot\s+(?:post|get)\s+\/|(?:invalid|unknown)\s+(?:url|route|endpoint)|no\s+route/i.test(message)
        || (response.status === 405 && /method not allowed/i.test(message)));
    throw Object.assign(new PidoiImageError(upstreamDiagnostic('Pidoi', submission ? '图片提交' : '图片查询', raw || text, c.apiKey, response.status, response.headers.get('x-request-id') || undefined), rejected),
      { status: response.status, routeUnavailable, upstreamTaskId: taskId || undefined,
        acceptedTask: submission && taskId ? { taskId, pollPath: evidence?.pollPath, status: 'processing', progress: 0, imageUrl: '', error: '', protocol: 'async', raw: {} } : undefined });
  }
  if (!raw) throw new PidoiImageError(upstreamDiagnostic('Pidoi', '非 JSON 响应；提交结果待核对', text, c.apiKey, response.status));
  return raw;
}

async function request(c: Channel, suffix: string, body: unknown, fetchImpl: typeof fetch, options: SubmitOptions = {}, pollPath?: string) {
  try {
  const safePath = pollPath && pidoiTaskEvidence({ task_id: decodeURIComponent(suffix.slice(1)), task_url: pollPath })?.pollPath;
  const response = await fetchImpl(safePath ? apiBase(c) + safePath : endpoint(c) + suffix, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
    headers: { Authorization: 'Bearer ' + c.apiKey, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return parsePidoiImageTask(await readResponse(c, response, options, body !== undefined));
  } catch (error: any) {
    throw Object.assign(error instanceof Error ? error : new Error('Pidoi 请求失败'), {
      imageRequestStage: body === undefined ? 'poll' : 'submit',
      upstreamTaskId: suffix ? decodeURIComponent(suffix.slice(1)) : error?.upstreamTaskId,
    });
  }
}
async function submitCompatibleImage(c: Channel, body: Record<string, any>, fetchImpl: typeof fetch, options: SubmitOptions): Promise<PidoiImageTask> {
  let stage = 'submit';
  try {
    const references = options.referenceImages || body.images || [];
    const payload: Record<string, any> = { model: body.model, prompt: body.prompt, n: 1, response_format: 'url' };
    for (const key of ['size', 'quality', 'output_format', 'background', 'output_compression']) {
      if (body[key] !== undefined) payload[key] = body[key];
    }
    let requestBody: string | FormData = JSON.stringify(payload);
    let path = '/v1/images/generations';
    const headers: Record<string, string> = { Authorization: 'Bearer ' + c.apiKey };
    if (references.length) {
      const form = new FormData();
      for (const [key, value] of Object.entries(payload)) if (value !== undefined) form.append(key, String(value));
      for (const source of references) {
        const match = source.match(/^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
        let blob: Blob;
        if (match) blob = new Blob([Buffer.from(match[2], 'base64')], { type: match[1] });
        else {
          stage = 'reference';
          const reference = await fetchImpl(source, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
          if (!reference.ok) throw new PidoiImageError('参考图读取失败，请重新上传', true);
          blob = await reference.blob();
          if (!blob.type.startsWith('image/')) throw new PidoiImageError('参考图不是有效图片，请重新上传', true);
        }
        form.append('image[]', blob, 'reference.png');
      }
      requestBody = form; path = '/v1/images/edits';
    } else headers['Content-Type'] = 'application/json';
    stage = 'submit';
    // One generation deadline governs response headers and body as well.
    const response = await fetchImpl(apiBase(c) + path, { method: 'POST', headers, body: requestBody,
      signal: AbortSignal.timeout(DEFAULT_IMAGE_GENERATION_TIMEOUT_MS), dispatcher: imageDispatcher, redirect: 'error' } as RequestInit);
    const raw = await readResponse(c, response, options);
    const evidence = pidoiTaskEvidence(raw);
    if (evidence) {
      try { return { ...parsePidoiImageTask(raw), protocol: 'async' }; }
      catch { /* A synchronous image result may also carry a correlation ID. */ }
    }
    const item = raw?.data?.[0];
    const source = item?.url || (item?.b64_json ? 'data:image/png;base64,' + item.b64_json : '');
    if (!source) throw new PidoiImageError('Pidoi 兼容接口未返回图片，结果待核对');
    const imageUrl = source.startsWith('/') ? new URL(source, apiBase(c)).href : source;
    return { taskId: extractImageUpstreamTaskId(raw, response.headers), status: 'completed', progress: 100, imageUrl, error: '', raw, protocol: 'openai-compatible' };
  } catch (error: any) {
    if (stage === 'reference') error.confirmedFailure = true; // Generation was never submitted.
    throw Object.assign(error, { imageRequestStage: 'submit' });
  }
}

export async function submitPidoiImage(c: Channel, body: Record<string, any>, fetchImpl = fetch, options: SubmitOptions = {}): Promise<PidoiImageTask> {
  if ((options.mode || pidoiImageRequestMode()) === 'sync') {
    options.onCompatibility?.();
    try { return await submitCompatibleImage(c, body, fetchImpl, options); }
    catch (error: any) {
      if (error.acceptedTask) return error.acceptedTask;
      // Network/timeout/5xx and input/auth errors never start another generation.
      if (!error.routeUnavailable) throw error;
      const state = { protocol: 'async' as const, reason: 'sync_endpoint_unavailable' };
      // Persist before POST. An interrupted attempt must never be sent again.
      options.onFallback?.({ ...state, status: 'submitting' });
      try {
        const task = await request(c, '', body, fetchImpl, options);
        if (!task.taskId) throw new PidoiImageError('Pidoi 异步备用未返回任务 ID，提交结果待核对');
        options.onFallback?.({ ...state, status: task.status === 'processing' ? 'accepted' : task.status, taskId: task.taskId });
        return { ...task, protocol: 'async' };
      } catch (backupError: any) {
        if (backupError.acceptedTask) {
          options.onFallback?.({ ...state, status: 'accepted', taskId: backupError.acceptedTask.taskId });
          return backupError.acceptedTask;
        }
        options.onFallback?.({ ...state, status: backupError.confirmedFailure ? 'failed' : 'unknown' });
        throw backupError; // Never cycle back to synchronous generation.
      }
    }
  }
  try {
    const task = await request(c, '', body, fetchImpl, options);
    if (!task.taskId) throw new PidoiImageError('Pidoi 未返回任务 ID，提交结果待核对');
    return { ...task, protocol: 'async' };
  } catch (error: any) {
    if (error.acceptedTask) return error.acceptedTask;
    // An explicit route-not-found response created no image task. Network errors,
    // gateway timeouts, invalid parameters and accepted tasks never trigger a POST retry.
    if (!error.routeUnavailable) throw error;
    options.onCompatibility?.();
    try { return await submitCompatibleImage(c, body, fetchImpl, options); }
    catch (compatibleError: any) {
      if (compatibleError.acceptedTask) return compatibleError.acceptedTask;
      throw compatibleError;
    }
  }
}
export async function pollPidoiImage(c: Channel, taskId: string, fetchImpl = fetch, pollPath?: string) {
  const task = await request(c, '/' + encodeURIComponent(taskId), undefined, fetchImpl, {}, pollPath);
  if (task.taskId && task.taskId !== taskId) throw new PidoiImageError('上游返回任务 ID 不一致，停止结算');
  return task;
}
export async function generatePidoiImage(c: Channel, body: Record<string, any>, onSubmitted: (id: string) => void, fetchImpl = fetch, options: SubmitOptions = {}) {
  let fallback: PidoiFallbackState | undefined;
  const onFallback = (state: PidoiFallbackState) => { fallback = state; options.onFallback?.(state); };
  let task = await submitPidoiImage(c, body, fetchImpl, { ...options, onFallback });
  if (task.taskId) onSubmitted(task.taskId);
  const id = task.taskId;
  const originalPollPath = task.pollPath;
  const deadline = Date.now() + 20 * 60_000;
  while (true) {
    if (task.status === 'failed') {
      if (fallback) onFallback({ ...fallback, status: 'failed', taskId: id });
      throw new PidoiImageError(task.error || 'Pidoi 图片生成失败', true);
    }
    if (task.status === 'completed' && task.imageUrl) {
      if (fallback) onFallback({ ...fallback, status: 'completed', taskId: id });
      return { ...task, taskId: id, reportedImageUrl: task.imageUrl };
    }
    if (Date.now() >= deadline) throw new PidoiImageError('图片仍在处理中，保留任务等待恢复');
    await new Promise(resolve => setTimeout(resolve, 5000));
    task = await pollPidoiImage(c, id, fetchImpl, task.pollPath || originalPollPath);
  }
}
import { upstreamDiagnostic } from './upstreamDiagnostic.js';
