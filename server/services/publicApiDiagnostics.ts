import { publicGenerationError } from '../../shared/generationMessages.js';

// Response projection only. Never use these messages to classify acceptance,
// change a task, or decide whether to charge/refund it.
function withoutDiagnosticEnvelopes(text: string): string {
  while (true) {
    const start = text.search(/\[(?:上游诊断 |HUSS )/);
    if (start < 0) break;
    let depth = 0, end = start;
    for (; end < text.length; end++) {
      if (text[end] === '[') depth++;
      if (text[end] === ']' && --depth === 0) break;
    }
    // An incomplete diagnostic label must not expose a partial channel name.
    text = text.slice(0, start) + (end < text.length ? text.slice(end + 1) : '');
  }
  return text;
}

export function publicApiErrorReason(value: unknown, privateNames: readonly string[] = []): string {
  let text = withoutDiagnosticEnvelopes(publicGenerationError(value, privateNames));
  // Older diagnostic redaction may have removed a trailing "Channel: ..."
  // token from a configured display name; also hide the remaining name.
  const names = privateNames.flatMap(name => [name, name.replace(/\s+(?:channel|provider)$/i, '').trim()]);
  for (const name of names) {
    if (name.length < 3) continue;
    const pattern = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(pattern, 'gi'), '[服务]');
  }
  // The public task/request ID is returned separately; provider request IDs and
  // routing-attempt labels are administrator diagnostics.
  text = text.replace(/\brequest_?id=[^\s:：;；]+\s*/gi, '')
    .replace(/所有候选线路均未完成提交[：:]/g, '任务未提交成功：')
    .replace(/\s+/g, ' ').trim();
  return text || '生成服务返回异常，暂未提供可展示的失败原因。';
}

const INTERNAL_FIELDS = new Set([
  'channel', 'channelId', 'channel_id', 'channelName', 'channel_name', 'channelApiKeyId', 'channel_api_key_id',
  'channel_running', 'channel_limit', 'provider', 'baseUrl', 'base_url', 'apiKey', 'api_key',
  'actualChannel', 'actualModel', 'upstreamModel', 'upstream_model', 'upstream_task_id', 'upstream_status',
  'routingRouteId', 'routingHealthKey', 'routingAttempts', 'fallbackFrom', 'fallbackReason',
  'upstreamCreateResponse', 'upstreamSubmissionDiagnostics', 'upstreamTransportError',
]);
const ERROR_FIELDS = ['error_message', 'errorMessage', 'failure_reason', 'failureReason', 'error_detail', 'errorDetail', 'detail', 'reason'];

/** Copy only response diagnostics. Generated content, URLs and financial fields stay intact. */
export function publicApiDiagnostics(body: any, privateNames: readonly string[] = [], depth = 0): any {
  if (!body || typeof body !== 'object') return body;
  if (depth > 8) return undefined;
  if (Array.isArray(body)) return body.map(item => publicApiDiagnostics(item, privateNames, depth + 1));
  const names = [...privateNames, ...[body, body.error, body.metadata].filter(value => value && typeof value === 'object')
    .flatMap(value => ['channel', 'channelName', 'channel_name', 'provider', 'actualChannel'].map(key => value[key]))
    .filter((value): value is string => typeof value === 'string')];
  const result = { ...body };
  for (const key of Object.keys(result)) {
    if (INTERNAL_FIELDS.has(key) || /^(?:channel|upstream|routing)(?:_|[A-Z])/.test(key)) delete result[key];
  }
  const reason = (value: unknown) => publicApiErrorReason(value, names);
  if (result.error) {
    if (typeof result.error === 'object' && !Array.isArray(result.error)) {
      const original = result.error;
      result.error = { message: reason(typeof original.message === 'string' && original.message ? original.message : original) };
      for (const key of ['code', 'type', 'param']) {
        if (typeof original[key] === 'string' && /^[\w.-]{1,100}$/.test(original[key]) && reason(original[key]) === original[key]) result.error[key] = original[key];
      }
    } else result.error = reason(result.error);
  }
  for (const key of [...ERROR_FIELDS, 'message', 'progress_text', 'progressText']) {
    if (result[key]) result[key] = reason(result[key]);
  }
  // Usage/history lists and nested task envelopes can carry old diagnostics.
  // Do not traverse choices/output: those are user-generated content.
  for (const key of ['items', 'data', 'metadata']) {
    if (result[key] && typeof result[key] === 'object') result[key] = publicApiDiagnostics(result[key], names, depth + 1);
  }
  return result;
}
