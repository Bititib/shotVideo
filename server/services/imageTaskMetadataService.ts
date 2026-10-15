export function extractImageUpstreamTaskId(
  payload: any,
  headers?: Pick<Headers, 'get'> | Record<string, string | string[] | undefined> | null,
): string {
  const data = Array.isArray(payload?.data) ? payload.data[0] : payload?.data;
  const values = [payload?.task_id, payload?.taskId, data?.task_id, data?.taskId,
    payload?.request_id, payload?.requestId, data?.request_id, data?.requestId, payload?.id, data?.id];
  for (const value of values) {
    if ((typeof value === 'string' || typeof value === 'number') && String(value).trim()) return String(value).trim();
  }

  const headerNames = ['x-request-id', 'request-id', 'x-task-id', 'x-trace-id'];
  for (const name of headerNames) {
    const value = headers && typeof (headers as Pick<Headers, 'get'>).get === 'function'
      ? (headers as Pick<Headers, 'get'>).get(name)
      : (headers as Record<string, string | string[] | undefined> | null)?.[name];
    const normalized = Array.isArray(value) ? value[0] : value;
    if (normalized && String(normalized).trim()) return String(normalized).trim();
  }
  return '';
}
