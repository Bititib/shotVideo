import { sanitizedGenerationReason } from './generationErrorPrivacy.js';
/** Display-only sanitization. Original diagnostics and state decisions stay unchanged. */
const messages = {
  submission: '任务未提交成功，请稍后重试。',
  duration: '视频时长不符合当前模型要求，请选择支持的时长后重试。',
  resolution: '分辨率不符合当前模型要求，请选择支持的分辨率后重试。',
  ratio: '画面比例不符合当前模型要求，请选择支持的比例后重试。',
  references: '参考素材不符合模型要求，请检查素材数量、格式和大小。',
  moderation: '生成内容未通过审核，请调整描述或参考素材。',
  parameters: '生成参数不符合模型要求，请检查时长、分辨率及参考素材。',
  review: '提交结果待核实，请在生成记录核实原任务，请勿重复提交。',
  query: '原任务查询异常，尚未确认生成失败；费用保留，请勿重复提交。',
  settlement: '生成结果已保留，费用结算待核实，请勿重复提交。',
  local: '本地处理异常，原任务和费用已保留，请联系管理员核查。',
  refundReview: '生成已失败，退款处理待核实；请勿重复提交。',
  timeout: '任务处理超时，请在生成记录核实原任务状态，请勿重复提交。',
  upstreamCredits: '上游积分不足，暂时无法生成，请联系管理员补充额度后重试。',
  unavailable: '生成服务暂时不可用，请稍后查看任务状态或联系管理员。',
  fallback: '生成未完成，请在生成记录查看任务状态，或联系管理员处理。',
};
export function publicGenerationError(value: unknown, privateNames: readonly string[] = []): string {
  const text = typeof value === 'string' ? value : value && typeof value === 'object' && 'message' in value ? String(value.message) : '';
  if (Object.values(messages).includes(text)) return text;
  if (text.startsWith('[HUSS ')) return sanitizedGenerationReason(text, privateNames);
  if (text.startsWith('[上游诊断 ')) return sanitizedGenerationReason(text, privateNames);
  if (/^(请先登录|请登录后重试)[。！!]?$/.test(text)) return '请先登录';
  if (/请求未发送|连接生成服务失败/i.test(text)) return messages.submission;
  if (/退款处理待核实/i.test(text)) return messages.refundReview;
  if (/结算待核实|费用结算失败|实际费用.*余额不足/i.test(text)) return messages.settlement;
  if (/查询.*(?:异常|不可用|暂停|不到|重试|被拒绝|时限)/i.test(text)) return messages.query;
  if (/本地处理异常/i.test(text)) return messages.local;
  if (/待核实|结果不确定|uncertain|请勿重复|禁止重复/i.test(text)) return messages.review;
  return sanitizedGenerationReason(value, privateNames);
}
export function publicGenerationStatus(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  if (/退款处理待核实|结算待核实|查询.*(?:异常|不可用|暂停|不到|重试|被拒绝|时限)|本地处理异常/i.test(value)) return publicGenerationError(value);
  if (/待核实|请勿重复|禁止重复/i.test(value)) return messages.review;
  // Only approved status templates can carry through; arbitrary names/URLs never do.
  if (['视频生成中', '图片生成中', '视频已生成，正在保存到本站存储', '视频已生成，正在等待结果交付', '图片生成完成', '图片生成失败', '正在提交视频生成任务...', '正在提交任务，等待生成结果...', '正在上传参考素材...', '已完成', '已提交过此任务，正在恢复结果，请勿重复提交'].includes(value)) return value;
  if (/^(?:视频生成中|图片生成中) ?\d{1,3}%$/.test(value)) return value;
  return '正在处理任务，请在生成记录查看进度。';
}
export function publicGenerationEvent<T extends { type?: string; message?: unknown }>(event: T): T {
  if (!event.message) return event;
  return { ...event, message: ['error', 'image_error'].includes(event.type || '')
    ? publicGenerationError(event.message) : publicGenerationStatus(event.message) };
}
/** Also cover failure messages saved by older clients in local/cloud canvas documents. */
export function publicCanvasJobMessage(job?: { status: string; message?: string }): string {
  if (!job?.message) return '';
  return job.status === 'error' || /提交失败|生成失败|invalid.parameters|upstream.error/i.test(job.message)
    ? publicGenerationError(job.message) : job.message;
}
