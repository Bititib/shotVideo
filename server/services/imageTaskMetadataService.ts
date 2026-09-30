export function extractImageUpstreamTaskId(
  payload: any,
  headers?: Pick<Headers, 'get'> | Record<string, string | string[] | undefined> | null,
): string {
  const data = Array.isArray(payload?.data) ? payload.data[0] : payload?.data;
  const payloadValue = payload?.task_id
    || payload?.taskId
    || data?.task_id
    || data?.taskId
    || payload?.id
    || data?.id;
  if (payloadValue !== undefined && payloadValue !== null && String(payloadValue).trim()) {
    return String(payloadValue).trim();
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
