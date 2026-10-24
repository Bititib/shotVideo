import { upstreamDiagnostic, transportDiagnostic } from './upstreamDiagnostic.js';
import { videoErrorTaskId, videoRequestNotSent } from './videoSubmissionErrors.js';

export type HmSubmissionOutcome = 'accepted' | 'rejected' | 'unknown';
export class HmSubmissionError extends Error {
  constructor(message: string, readonly outcome: 'rejected' | 'unknown', readonly httpStatus = 0) { super(message); }
}

/** HM create responses only. Polling errors must never use this classifier. */
export function classifyHmSubmission(status: number, body: any, headers: Pick<Headers, 'get'>) {
  const taskId = body && typeof body === 'object' ? body.task_id || body.id || body.data?.task_id || body.data?.id : '';
  const evidence = videoErrorTaskId(body, headers);
  const acceptedState = ['queued', 'pending', 'processing', 'running', 'in_progress', 'completed', 'success', 'succeeded']
    .includes(String(body?.status || body?.data?.status || '').toLowerCase());
  const error = body?.error || body?.detail || body?.success === false
    || ['failed', 'error', 'rejected'].includes(String(body?.status || '').toLowerCase());
  if (status >= 200 && status < 300 && taskId && !error)
    return { outcome: 'accepted' as const, taskId: String(taskId) };
  // A receipt or accepted state conflicts with rejection. Preserve the original.
  if (evidence || acceptedState) return { outcome: 'unknown' as const, taskId: '' };
  const rejectedHttp = [400, 401, 402, 403, 404, 405, 413, 415, 422, 429].includes(status);
  // User-reported HM maintenance rejection; never scan echoed input or arbitrary nested text.
  const message = typeof body === 'string' ? body : typeof body?.error === 'string' ? body.error
    : body?.error?.message || body?.detail || body?.message;
  const maintenance = typeof message === 'string' && message.length <= 1000
    && /^临时修复(?:[，,。！!：:\s]|$)/.test(message.trim())
    && !/<|>|\{|\}/.test(message);
  if ([200, 400, 500, 503].includes(status) && maintenance)
    return { outcome: 'rejected' as const, taskId: '' };
  if (rejectedHttp || status >= 200 && status < 300 && error)
    return { outcome: 'rejected' as const, taskId: '' };
  // HM docs: 503 is busy/retry later, with a complete {"error": "..."} body.
  if (status === 503 && typeof body?.error === 'string' && body.error.trim())
    return { outcome: 'rejected' as const, taskId: '' };
  // Other 5xx bodies are not a verified HM refusal contract.
  return { outcome: 'unknown' as const, taskId: '' };
}

export async function readHmSubmission(response: Response, apiKey: string) {
  let body: any;
  try {
    const text = await response.text();
    try { body = JSON.parse(text); } catch { body = text; }
  } catch (error: any) {
    throw new HmSubmissionError(transportDiagnostic('HM Studio', '提交响应读取中断', error, apiKey), 'unknown', response.status);
  }
  const decision = classifyHmSubmission(response.status, body, response.headers);
  if (decision.outcome === 'accepted') return { taskId: decision.taskId, body };
  throw new HmSubmissionError(upstreamDiagnostic('HM Studio', decision.outcome === 'rejected' ? '提交被拒绝' : '提交结果待核实，请勿重复提交',
    body, apiKey, response.status, response.headers.get('x-request-id') || undefined), decision.outcome, response.status);
}

export function hmSubmissionTransportError(error: any, apiKey: string) {
  return new HmSubmissionError(transportDiagnostic('HM Studio', '提交连接', error, apiKey),
    videoRequestNotSent(error) ? 'rejected' : 'unknown');
}
