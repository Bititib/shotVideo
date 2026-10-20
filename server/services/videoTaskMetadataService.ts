function scalarId(value: unknown): string {
  return (typeof value === 'string' || typeof value === 'number') && String(value).trim()
    ? String(value).trim()
    : '';
}

/**
 * Read only explicit task identifiers. Request/trace headers are deliberately
 * excluded because they are not guaranteed to be valid polling identifiers.
 */
export function extractVideoUpstreamTaskId(
  payload: any,
  headers?: Pick<Headers, 'get'> | Record<string, string | string[] | undefined> | null,
): string {
  const firstData = Array.isArray(payload?.data) ? payload.data[0] : payload?.data;
  const scopes = [payload, firstData, payload?.result, payload?.output, payload?.task, payload?.response?.data]
    .filter(value => value && typeof value === 'object');

  for (const fields of [['task_id', 'taskId'], ['request_id', 'requestId'], ['id']]) {
    for (const scope of scopes) {
      for (const field of fields) {
        const value = scalarId(scope?.[field]);
        if (value) return value;
      }
    }
  }

  for (const name of ['x-task-id', 'task-id']) {
    const value = headers && typeof (headers as Pick<Headers, 'get'>).get === 'function'
      ? (headers as Pick<Headers, 'get'>).get(name)
      : (headers as Record<string, string | string[] | undefined> | null)?.[name];
    const normalized = scalarId(Array.isArray(value) ? value[0] : value);
    if (normalized) return normalized;
  }

  const location = headers && typeof (headers as Pick<Headers, 'get'>).get === 'function'
    ? (headers as Pick<Headers, 'get'>).get('location')
    : (headers as Record<string, string | string[] | undefined> | null)?.location;
  const locationValue = Array.isArray(location) ? location[0] : location;
  const match = String(locationValue || '').match(/\/v1\/(?:videos|video\/generations)\/([^/?#]+)(?:[?#]|$)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

/** Small, redacted diagnostic copy for manual reconciliation. */
export function sanitizeUpstreamCreateResponse(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeUpstreamCreateResponse(item, depth + 1));
  if (!value || typeof value !== 'object') return String(value ?? '');
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
    result[key] = /authorization|cookie|token|api[-_]?key|password|secret/i.test(key)
      ? '[redacted]'
      : sanitizeUpstreamCreateResponse(item, depth + 1);
  }
  return result;
}
