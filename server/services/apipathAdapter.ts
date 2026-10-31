import { randomUUID } from 'node:crypto';
import { transportDiagnostic } from './upstreamDiagnostic.js';
import { sanitizedGenerationReason } from '../../shared/generationErrorPrivacy.js';

export type ApipathChannel = { type?: string | null; baseUrl: string; apiKey: string; timeout?: number };
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
  const code = raw?.error?.code ?? raw?.code;
  const reason = raw?.error?.message ?? raw?.message ?? '上游未提供具体原因';
  const text = `[通联 ${stage}] HTTP ${status || '未提供'} code=${String(code ?? '未提供')}；原因：${sanitizedGenerationReason(reason)}`;
  return sanitizedGenerationReason(c.apiKey ? text.split(c.apiKey).join('[密钥已隐藏]') : text);
};

/** No POST retries: the provider explicitly does not implement idempotency. */
export async function apipathRequest(c: ApipathChannel, endpoint: string, body?: object | FormData,
  onStarting: (metadata: Record<string, unknown>) => void = () => {}, onTask: (id: string) => void = () => {}) {
  const submitting = body !== undefined;
  if (submitting) onStarting({ apipathLogicalRequestId: randomUUID() });
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
    const rejected = submitting && !id && ((response.status === 400 && raw?.error?.code === 'invalid_request_error')
      || (response.status === 401 && raw?.error?.code === 'invalid_api_key'));
    throw new ApipathError(diagnostic(c, submitting ? '提交' : '查询', raw, response.status), !rejected, response.status);
  }
  return raw;
}
export function normalizeApipathVideo(raw: any, c: ApipathChannel, id: string) {
  const returnedId = apipathTaskId(raw);
  if (returnedId && returnedId !== id) throw new ApipathError('通联查询返回了其他任务编号，保留原任务');
  const status = raw?.status;
  if (!['queued', 'pending', 'processing', 'completed', 'failed'].includes(status)) {
    throw new ApipathError(diagnostic(c, '查询状态未确认', { message: '未知状态：' + String(status) }));
  }
  let resultUrl = '';
  if (status === 'completed') {
    try { const url = new URL(raw.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); resultUrl = url.href; }
    catch { throw new ApipathError('通联已完成但未返回有效 url，继续核实原结果'); }
  }
  return { status, progress: status === 'completed' ? 100 : Math.max(0, Math.min(99, Number(raw.progress) || 0)), resultUrl,
    error: status === 'failed' ? diagnostic(c, '任务失败 task_no=' + id, raw) : '' };
}
export async function pollApipathVideo(c: ApipathChannel, id: string) {
  return normalizeApipathVideo(await apipathRequest(c, '/v1/video/generations/' + encodeURIComponent(id)), c, id);
}
