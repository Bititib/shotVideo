/** These connection failures prove that the paid HTTP request was not delivered. */
export function videoRequestNotSent(error: any): boolean {
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL'].includes(error?.cause?.code || error?.code);
}

/** Trace/request IDs in error envelopes are not generation task receipts. */
export function videoErrorTaskId(payload: any, headers?: Pick<Headers, 'get'>): string {
  const scopes = [payload, Array.isArray(payload?.data) ? payload.data[0] : payload?.data, payload?.task, payload?.result, payload?.output, payload?.response?.data];
  for (const scope of scopes) {
    if (!scope || typeof scope !== 'object') continue;
    for (const key of ['task_id', 'taskId', 'videoId', 'upstreamTaskId', 'id']) {
      if (['string', 'number'].includes(typeof scope[key]) && String(scope[key]).trim()) return String(scope[key]);
    }
  }
  return headers?.get('x-task-id') || headers?.get('task-id') || headers?.get('location') || '';
}

export function explicitVideoCreateError(payload: any, headers?: Pick<Headers, 'get'>): boolean {
  if (!payload || typeof payload !== 'object' || videoErrorTaskId(payload, headers)) return false;
  return typeof payload.error === 'string' && Boolean(payload.error.trim())
    || Boolean(payload.error && typeof payload.error.message === 'string' && payload.error.message.trim());
}
