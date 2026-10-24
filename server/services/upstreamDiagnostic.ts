import { sanitizedGenerationReason } from '../../shared/generationErrorPrivacy.js';

// Presentation only: adapters retain their own status/retry/billing semantics.
export function upstreamDiagnostic(provider: string, stage: string, payload: unknown, secret = '', httpStatus?: number, requestId?: string) {
  const p = payload as any;
  const code = p?.error?.code ?? p?.error_code ?? p?.code;
  const id = requestId || p?.request_id || p?.requestId;
  const detail = sanitizedGenerationReason(payload);
  const text = `[上游诊断 ${provider} ${stage}]${httpStatus ? ' HTTP ' + httpStatus : ''}${code !== undefined ? ' code=' + String(code) : ''}${id ? ' request_id=' + String(id) : ''}：${detail}`;
  return sanitizedGenerationReason(secret ? text.split(secret).join('[密钥已隐藏]') : text);
}

export async function responseDiagnostic(provider: string, stage: string, response: Response, secret = '') {
  let payload: unknown;
  try { const text = await response.text(); try { payload = JSON.parse(text); } catch { payload = text || '上游返回空响应'; } }
  catch (error: any) { payload = { message: '响应正文读取失败', detail: error?.message, code: error?.cause?.code }; }
  return upstreamDiagnostic(provider, stage, payload, secret, response.status, response.headers.get('x-request-id') || response.headers.get('request-id') || undefined);
}
