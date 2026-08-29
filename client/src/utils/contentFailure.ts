export type ContentFailureInfo = {
  message: string;
  failedAt?: string;
  hasRecordedReason: boolean;
};

function parseMetadata(metadata: unknown): Record<string, any> {
  if (metadata && typeof metadata === 'object') return metadata as Record<string, any>;
  if (typeof metadata !== 'string') return {};
  try {
    const parsed = JSON.parse(metadata || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function errorText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const nested = record.message || record.detail || record.error;
    if (typeof nested === 'string') return nested.trim();
    try { return JSON.stringify(value); } catch { return ''; }
  }
  return '';
}

export function getContentFailureInfo(metadata: unknown, resultText?: unknown): ContentFailureInfo {
  const meta = parseMetadata(metadata);
  const candidates = [
    meta.error,
    meta.errorMessage,
    meta.failure_reason,
    meta.fail_reason,
    resultText,
  ];
  const message = candidates.map(errorText).find(Boolean);
  return {
    message: message || '未记录失败原因（历史任务或上游未返回错误详情）',
    ...(meta.failedAt ? { failedAt: String(meta.failedAt) } : {}),
    hasRecordedReason: Boolean(message),
  };
}
