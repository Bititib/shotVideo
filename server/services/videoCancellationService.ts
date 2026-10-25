import { sqlite } from '../db/index.js';
import { canCancelVideoContent } from './videoCancellationEligibility.js';
import { finalizeReservedContent } from './contentBillingService.js';
import { finalizeFailedSpecificationTask } from './specificationGenerationService.js';
import { hmStudioQueue } from './hmStudioQueueService.js';

const message = '任务已取消，尚未提交上游';
const fail = (reason: string, status: number) => Object.assign(new Error(reason), { status });

/** Cancellation and the existing refund finalizer share the dispatch lock's SQLite transaction. */
export function cancelVideoContent(id: number, userId: number): void {
  if (!Number.isSafeInteger(id) || id <= 0) throw fail('任务 ID 无效', 400);
  sqlite.transaction(() => {
    const row = sqlite.prepare('SELECT * FROM contents WHERE id=?').get(id) as any;
    if (!row) throw fail('任务不存在', 404);
    if (row.user_id !== userId) throw fail('无权取消此任务', 403);
    if (row.type !== 'video') throw fail('该记录不是视频任务', 400);
    let meta: Record<string, any>;
    try { meta = JSON.parse(row.metadata || '{}'); } catch { throw fail('任务提交状态无法确认，不能取消', 409); }
    if (row.status === 'failed' && meta.cancelledBeforeSubmission) return;
    if (!canCancelVideoContent({ ...row, resultUrl: row.result_url })) {
      throw fail('任务已开始提交、已被上游受理或提交结果待核实，不能取消', 409);
    }
    const reservation = sqlite.prepare('SELECT state,context FROM billing_reservations WHERE id=?').get(meta.billingReservationId) as any;
    if (!reservation || reservation.state !== 'reserved') throw fail('任务预扣状态无法确认，不能取消', 409);
    const context = JSON.parse(reservation.context);
    if (Number(context.userId) !== userId || Number(context.contentId) !== id) throw fail('任务预扣归属不一致，不能取消', 409);
    if (meta.managedSpecification) finalizeFailedSpecificationTask(id, message);
    else if (!finalizeReservedContent(id, 'failed', { error: message, failureReason: message, progressText: message })) {
      throw fail('任务退款未完成，取消未生效', 409);
    }
    const latest = sqlite.prepare('SELECT status,metadata FROM contents WHERE id=?').get(id) as any;
    if (latest.status !== 'failed') throw fail('任务未能结束，取消未生效', 409);
    sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(latest.metadata),
      cancelledBeforeSubmission: true, cancelledAt: new Date().toISOString(), videoSubmissionState: 'cancelled', queueStatus: 'cancelled' }), id);
  }).immediate();
  hmStudioQueue.cancelPending('video:' + id);
  hmStudioQueue.cancelPending('spec-' + id);
}
