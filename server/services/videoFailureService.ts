function parseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch { return value; }
  }
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart >= 0) {
    try { return JSON.parse(trimmed.slice(jsonStart)); } catch { /* keep the original text */ }
  }
  return value;
}

/** Extract the most useful human-readable message from nested/escaped gateway errors. */
export function extractVideoFailureMessage(value: unknown, depth = 0): string {
  if (depth > 8 || value === null || value === undefined) return '';
  if (typeof value === 'string') {
    const parsed = parseJsonString(value);
    return parsed === value ? value.trim() : extractVideoFailureMessage(parsed, depth + 1);
  }
  if (value instanceof Error) return extractVideoFailureMessage(value.message, depth + 1);
  if (typeof value !== 'object') return String(value);

  const record = value as Record<string, unknown>;
  const candidates = [
    record.error,
    record.err_code,
    record.failure_reason,
    record.fail_reason,
    record.message,
    record.detail,
  ];
  for (const candidate of candidates) {
    const message = extractVideoFailureMessage(candidate, depth + 1);
    if (message) return message;
  }
  try { return JSON.stringify(value); } catch { return ''; }
}

const VIDEO_FAILURE_STATUSES = new Set([
  'failed',
  'failure',
  'error',
  'errored',
  'rejected',
  'cancelled',
  'canceled',
  'expired',
  'terminated',
]);

/** Return true for every known terminal failure state used by video providers. */
export function isVideoFailureStatus(value: unknown): boolean {
  return VIDEO_FAILURE_STATUSES.has(String(value ?? '').trim().toLowerCase());
}

/**
 * Detect terminal failures wrapped in an otherwise successful HTTP response.
 * Providers variously use status/state/task_status, an embedded HTTP status,
 * or success=false, so checking only the top-level `status` leaves tasks stuck.
 */
export function isVideoFailurePayload(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, any>;
  const nested = record.data && typeof record.data === 'object' ? record.data : {};
  const statuses = [
    record.status,
    record.state,
    record.task_status,
    record.taskStatus,
    nested.status,
    nested.state,
    nested.task_status,
    nested.taskStatus,
  ];
  if (statuses.some(isVideoFailureStatus)) return true;

  const embeddedStatus = Number(
    record.status_code ?? record.statusCode ?? record.http_status ?? record.httpStatus
      ?? nested.status_code ?? nested.statusCode ?? nested.http_status ?? nested.httpStatus,
  );
  if (Number.isFinite(embeddedStatus) && embeddedStatus >= 400) return true;
  return record.success === false || nested.success === false;
}

export function formatVideoPollHttpFailure(status: number, body: unknown): string {
  const detail = extractVideoFailureMessage(body);
  return detail
    ? `上游任务查询失败 (${status}): ${detail}`
    : `上游任务查询失败 (${status})`;
}

export function clarifyVideoCapacityFailure(message: string, hmStudioTask: boolean): string {
  if (hmStudioTask) return message;
  const capacityPattern = /(任务)?并发(数|量|额度|限制)?不足|concurrency.{0,30}(insufficient|limit|exceeded|full)/i;
  return capacityPattern.test(message)
    ? '上游渠道当前容量不足，请稍后重试（非本站并发限制）'
    : message;
}

export function withVideoFailureMetadata(
  metadata: unknown,
  error: unknown,
  failedAt = new Date().toISOString(),
): Record<string, unknown> {
  let current: Record<string, unknown> = {};
  if (metadata && typeof metadata === 'object') current = metadata as Record<string, unknown>;
  else if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata || '{}');
      if (parsed && typeof parsed === 'object') current = parsed;
    } catch { /* retain an empty metadata object */ }
  }
  return {
    ...current,
    error: extractVideoFailureMessage(error) || '视频生成失败',
    failedAt,
    queueStatus: 'failed',
  };
}
