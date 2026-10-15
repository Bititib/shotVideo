export function extractImageUpstreamTaskId(
  payload: any,
  headers?: Pick<Headers, 'get'> | Record<string, string | string[] | undefined> | null,
): string {
  const data = Array.isArray(payload?.data) ? payload.data[0] : payload?.data;
  const nodes = [payload, data, payload?.error, payload?.result, data?.error];
  // Prefer actual task IDs before request IDs used for provider support/tracing.
  for (const keys of [['task_id', 'taskId'], ['request_id', 'requestId'], ['id']]) {
    for (const node of nodes) for (const key of keys) {
      const value = node?.[key];
      if ((typeof value === 'string' || typeof value === 'number') && String(value).trim()) return String(value).trim();
    }
  }

  const headerNames = ['x-task-id', 'x-request-id', 'request-id', 'x-trace-id'];
  for (const name of headerNames) {
    const value = headers && typeof (headers as Pick<Headers, 'get'>).get === 'function'
      ? (headers as Pick<Headers, 'get'>).get(name)
      : Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name)?.[1];
    const normalized = Array.isArray(value) ? value[0] : value;
    if (normalized && String(normalized).trim()) return String(normalized).trim();
  }
  return '';
}

export interface ImageResponseEvidence {
  id: string;
  httpStatus?: number;
  state: 'awaiting_response' | 'headers_received' | 'captured' | 'response_without_id' | 'response_unreadable' | 'no_response';
}

/** Store only correlation identifiers and HTTP status, never raw provider payloads/headers. */
export function imageResponseEvidence(payload: unknown, headers: Headers, httpStatus: number,
  stage: 'headers_received' | 'response_without_id' | 'response_unreadable'): ImageResponseEvidence {
  const id = extractImageUpstreamTaskId(payload, headers);
  return { id, httpStatus, state: id ? 'captured' : stage };
}
