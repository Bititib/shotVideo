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
