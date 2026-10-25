import { findVideoSubmissionReceipt } from './videoSubmissionReceiptService.js';

type VideoContent = { id?: number; type?: string; status?: string | null; resultUrl?: string | null; metadata?: unknown };

/** Only durable evidence that dispatch has not started permits cancellation. */
export function canCancelVideoContent(item: VideoContent | undefined): boolean {
  if (!item || item.type !== 'video' || !['queued', 'processing'].includes(item.status || '') || item.resultUrl) return false;
  let meta: Record<string, any>;
  try { meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata as Record<string, any>; }
  catch { return false; }
  if (!meta || meta.videoSubmissionState !== 'preparing' || !meta.billingReservationId || meta.batchItemId
    || meta.requiresReview || meta.hayaNeedsReview || meta.upstreamGenerated || meta.upstreamStatus
    || (meta.billingStatus && meta.billingStatus !== 'reserved')) return false;
  if (['videoId', 'upstreamTaskId', 'taskId', 'task_id', 'submissionId', 'submission_id', 'zonghengOrderId',
    'submissionStartedAt', 'videoRequestStartedAt', 'billingSubmissionStarted', 'batchSubmissionStarted',
    'videoSubmissionStartedAt', 'zonghengSubmissionStarted', 'hayaSubmissionStarted'].some(key => meta[key])) return false;
  return !item.id || !findVideoSubmissionReceipt(item.id);
}

export function assertVideoContentDeletable(item: VideoContent): void {
  if (item.type === 'video' && ['queued', 'processing', 'review'].includes(item.status || '')) {
    throw Object.assign(new Error('任务尚未结束，不能删除；只有尚未提交上游的任务可以取消'), { status: 409 });
  }
}
