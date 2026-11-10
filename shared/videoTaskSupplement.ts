import { isTaskIdPlaceholder } from './upstreamTaskId.js';
import { videoReviewKind } from './videoReview.js';

export function canDownloadV6kOriginal(record: { type: string; status: string }, meta: Record<string, any>): boolean {
  return record.type === 'video' && meta.managedSpecification === true && meta.zonghengProtocol === 'v6k'
    && Boolean(meta.channelId) && !meta.batchItemId
    && (['failed', 'error', 'review'].includes(record.status)
      || record.status === 'processing' && videoReviewKind(meta) === 'submission');
}

export function canRestoreOriginalVideo(record: { type: string; status: string; resultUrl?: unknown }, meta: Record<string, any>): boolean {
  return record.type === 'video' && !record.resultUrl
    && (['failed', 'error', 'review'].includes(record.status)
      || record.status === 'processing' && Boolean(videoReviewKind(meta) || meta.videoDeliveryUnavailable));
}

export function recordedVideoTaskIds(meta: Record<string, any>): string[] {
  return [meta.videoId, meta.upstreamTaskId, meta.upstream_task_id, meta.taskId, meta.task_id,
    ...(Array.isArray(meta.upstreamTaskIds) ? meta.upstreamTaskIds : [])]
    .map(value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '')
    .filter(value => value && !isTaskIdPlaceholder(value));
}

/** Only an unverified manual addition over a missing ID can be withdrawn. */
export function canWithdrawTaskSupplement(record: { type: string; status: string; resultUrl?: unknown }, meta: Record<string, any>): boolean {
  const audit = Array.isArray(meta.recoveryAudit) ? [...meta.recoveryAudit].reverse().find(a => a?.action === 'supplement_task_id') : null;
  const previous = audit?.previousTaskId;
  const ids = [meta.videoId, meta.upstreamTaskId, meta.upstream_task_id, meta.taskId, meta.task_id, meta.requestId, meta.request_id,
    ...(Array.isArray(meta.upstreamTaskIds) ? meta.upstreamTaskIds : []), ...(Array.isArray(meta.recoveryTaskIds) ? meta.recoveryTaskIds : [])]
    .filter(id => typeof id === 'string' ? id.trim() : Boolean(id));
  return record.type === 'video' && ['review', 'failed', 'error'].includes(record.status)
    && meta.recoveryTaskIdSupplemented === true && Boolean(audit?.taskId)
    && (!previous || isTaskIdPlaceholder(previous))
    && ids.length > 0 && ids.every(id => id === audit.taskId)
    && !meta.recoveryTaskIdVerifiedAt && !meta.recoveryPollingStartedAt && !meta.recoveryPollingProtected
    && !meta.recoveryCharged && !meta.recoveredAt
    // The literal unknown marker is not evidence that this manually added ID
    // was ever verified. Keep all actual task states and receipt guards intact.
    && (!meta.upstreamStatus || meta.upstreamStatus === 'unknown') && !meta.upstreamGenerated
    && !record.resultUrl && !meta.upstreamResultUrl && !meta.recoverySourceUrls?.length
    && !meta.batchItemId && !meta.managedSpecification;
}
