import { sanitizedGenerationReason } from '../../../shared/generationErrorPrivacy';

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
  // Older V6K orders saved transport evidence without an error string. Display
  // that evidence; it must never decide whether to refund or retry a generation.
  const diagnostic = meta.zonghengSubmissionDiagnostics;
  let submissionReason = '';
  if (diagnostic && typeof diagnostic === 'object') {
    if (typeof diagnostic.message === 'string' && diagnostic.message.trim()) submissionReason = sanitizedGenerationReason(diagnostic.message);
    else {
      const reasons: Record<string, string> = {
        http_error: '视频提交接口返回异常，原始错误正文未保存',
        timeout: '视频提交等待响应超时，受理结果尚未确认',
        network_error: '视频提交发生网络异常，受理结果尚未确认',
        invalid_json: '视频提交响应无法解析为 JSON',
        invalid_task_response: '视频提交响应未包含可识别的任务 ID 或状态',
      };
      submissionReason = reasons[diagnostic.reason] || '';
      if (submissionReason) {
        if (Number.isInteger(diagnostic.httpStatus) && diagnostic.httpStatus >= 100 && diagnostic.httpStatus <= 599) submissionReason += `；HTTP ${diagnostic.httpStatus}`;
        if (typeof diagnostic.networkCode === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(diagnostic.networkCode)) submissionReason += `；${diagnostic.networkCode}`;
        if (typeof diagnostic.elapsedMs === 'number' && Number.isFinite(diagnostic.elapsedMs) && diagnostic.elapsedMs >= 0) submissionReason += `；耗时 ${(diagnostic.elapsedMs / 1000).toFixed(2)} 秒`;
      }
    }
  }
  const candidates = [
    meta.error,
    meta.errorMessage,
    meta.failureReason,
    meta.failure_reason,
    meta.fail_reason,
    submissionReason,
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
