export type ImageRequestStage = 'submit' | 'poll' | 'download' | 'persist';
export interface ImageRequestContext {
  stage: ImageRequestStage;
  contentId?: number;
  channelId?: number;
  taskId?: string;
  index?: number;
}
export const imageStageLabel = { submit: '提交失败', poll: '查询失败', download: '下载失败', persist: '保存或结算失败' };

/** Allowlist diagnostics only: never serialize errors, URLs, headers or upstream bodies. */
export function imageRequestDiagnostic(context: ImageRequestContext, error: unknown) {
  const codes = new Set<string>();
  const seen = new Set<unknown>();
  let status: number | undefined;
  const visit = (value: any, depth = 0) => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 5) return;
    seen.add(value);
    if (typeof value.code === 'string' && /^(?:E[A-Z0-9_]+|UND_ERR_[A-Z_]+|CERT_[A-Z_]+|ERR_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_[A-Z_]+)$/.test(value.code)) codes.add(value.code);
    const http = Number(value.status || value.statusCode || String(value.message || '').match(/HTTP\s+(\d{3})/i)?.[1]);
    if (!status && http >= 100 && http <= 599) status = http;
    visit(value.cause, depth + 1);
    if (Array.isArray(value.errors)) value.errors.slice(0, 8).forEach((item: unknown) => visit(item, depth + 1));
  };
  visit(error);
  const name = (error as any)?.name;
  return {
    stage: context.stage, contentId: context.contentId, channelId: context.channelId,
    // Do not let unexpected provider fields introduce credentials or signed URLs.
    taskId: context.taskId && /^(?:task_|req_|request_|img_|image_)[A-Za-z0-9_-]{1,180}$/.test(context.taskId) ? context.taskId : undefined,
    index: context.index, httpStatus: status,
    errorType: ['AbortError', 'TimeoutError', 'TypeError', 'SyntaxError', 'AggregateError'].includes(name) ? name : 'Error',
    networkCodes: [...codes],
  };
}
export function logImageRequestFailure(context: ImageRequestContext, error: unknown) {
  const detail = imageRequestDiagnostic(context, error);
  console.warn(`[image-request] ${imageStageLabel[context.stage]}`, JSON.stringify(detail));
  return detail;
}
