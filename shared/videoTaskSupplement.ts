import { isTaskIdPlaceholder } from './upstreamTaskId.js';

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
    && !meta.recoveryCharged && !meta.recoveredAt && !meta.upstreamStatus && !meta.upstreamGenerated
    && !record.resultUrl && !meta.upstreamResultUrl && !meta.recoverySourceUrls?.length
    && !meta.batchItemId && !meta.managedSpecification;
}
