export type ContentFailureInfo = {
  message: string;
  failedAt?: string;
  hasRecordedReason: boolean;
  billingStatus?: string;
  refunded?: boolean;
  refundAmount?: number;
  refundTarget?: string;
  refundedAt?: string;
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

function parseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch { return value; }
  }
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart >= 0) {
    try { return JSON.parse(trimmed.slice(jsonStart)); } catch { /* retain original text */ }
  }
  return value;
}

function errorText(value: unknown, depth = 0): string {
  if (depth > 8 || value === null || value === undefined) return '';
  if (typeof value === 'string') {
    const parsed = parseJsonString(value);
    return parsed === value ? value.trim() : errorText(parsed, depth + 1);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const nested of [record.error, record.err_code, record.failure_reason, record.fail_reason, record.message, record.detail]) {
      const message = errorText(nested, depth + 1);
      if (message) return message;
    }
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
    ...(meta.billingStatus ? { billingStatus: String(meta.billingStatus) } : {}),
    ...(meta.queueRefunded !== undefined ? { refunded: Boolean(meta.queueRefunded) } : {}),
    ...(Number.isFinite(Number(meta.refundAmount)) ? { refundAmount: Number(meta.refundAmount) } : {}),
    ...(meta.refundTarget ? { refundTarget: String(meta.refundTarget) } : {}),
    ...(meta.refundedAt ? { refundedAt: String(meta.refundedAt) } : {}),
    hasRecordedReason: Boolean(message),
  };
}
