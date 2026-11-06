import { parseUtcTimestamp } from '../../shared/time.js';
import { sqlite } from '../db/index.js';
import { isSuperAdmin } from '../middleware/admin.js';
import { resolveBillingReservation } from './billingReconciliation.js';
import { isPidoiImageChannel, PIDOI_IMAGE_MODEL } from './pidoiImageAdapter.js';
import { pidoiTaskEvidence } from './pidoiImageEvidence.js';
import { pidoiImageActive } from './pidoiImageWorker.js';

function conflict(message: string): never {
  throw Object.assign(new Error(message), { status: 409 });
}

function legacyImage(id: number) {
  const row = sqlite.prepare('SELECT * FROM contents WHERE id=?').get(id) as any;
  if (row?.type !== 'image' || row.model_id !== PIDOI_IMAGE_MODEL) conflict('仅支持旧版 Pidoi 网页图片任务');
  const meta = JSON.parse(row.metadata || '{}');
  if (!meta || meta.imageProtocol || meta.managedSpecification || meta.batchItemId) conflict('仅支持旧版 Pidoi 网页图片任务');
  return { row, meta };
}

function originalReservation(row: any, meta: any) {
  const channel = sqlite.prepare('SELECT base_url AS baseUrl FROM channels WHERE id=?')
    .get(Number(meta.channelId)) as { baseUrl: string } | undefined;
  if (!channel || !isPidoiImageChannel(channel)) conflict('无法核对原 Pidoi 渠道');
  const createdAt = parseUtcTimestamp(row.created_at);
  const minAge = Math.max(30 * 60_000, (Number(meta.requestTimeoutMs) || 0) + 60_000);
  if (!['processing', 'queued', 'review'].includes(row.status) || pidoiImageActive.has(row.id)
    || !(createdAt < performance.timeOrigin && Date.now() - createdAt > minAge))
    conflict('仅可取消当前进程启动前已超时的遗留任务');
  if (row.result_url || row.result_text || meta.completedAt || meta.upstreamStatus === 'completed'
    || meta.imageUrls?.some(Boolean) || meta.upstreamImageUrls?.some(Boolean)
    || meta.upstreamTaskId || meta.taskId || meta.upstreamTaskIds?.some(Boolean) || meta.pidoiImageJobs?.length
    || meta.upstreamResponses?.some((response: any) => String(response?.id || '').startsWith('task_'))
    || meta.submissionFailure?.taskId || pidoiTaskEvidence(meta.submissionFailure?.message) || pidoiTaskEvidence(meta.failureReason))
    conflict('已有结果或上游任务编号，请先核对原任务');
  if (!meta.billingReservationId || !['reserved', 'review'].includes(meta.billingStatus)
    || meta.refundedAt || meta.queueRefunded || meta.refundAmount)
    conflict('本地预扣状态不符，请核对原账本');

  const bill = sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(meta.billingReservationId) as any;
  if (!bill || !['reserved', 'review'].includes(bill.state) || bill.actual != null || !Number.isFinite(bill.amount)
    || bill.amount <= 0 || Math.abs(bill.amount - Number(row.cost)) > 0.000001)
    conflict('原预扣账本状态或金额不符');
  const context = JSON.parse(bill.context), receipt = JSON.parse(bill.receipt);
  const links = sqlite.prepare(`SELECT id FROM contents WHERE CASE WHEN json_valid(metadata)
    THEN json_extract(metadata,'$.billingReservationId') END=? LIMIT 2`).all(bill.id) as { id: number }[];
  if (!context || !receipt || links.length !== 1 || links[0].id !== row.id || context.userId !== row.user_id || context.tokenId
    || (context.contentId != null && Number(context.contentId) !== row.id) || !['user', 'org'].includes(receipt.source))
    conflict('原账本归属或扣款来源不符');
  if (receipt.source === 'org' && (!receipt.orgId || !sqlite.prepare('SELECT id FROM organizations WHERE id=?').get(receipt.orgId)))
    conflict('原扣款组织不存在，无法原路退款');
  return { bill, source: receipt.source };
}

export function canCancelLegacyPidoiImage(id: number): boolean {
  try {
    const { row, meta } = legacyImage(id);
    originalReservation(row, meta);
    return true;
  } catch (error: unknown) {
    if ((error as { status?: number }).status === 409 || error instanceof SyntaxError) return false;
    throw error;
  }
}

export function cancelLegacyPidoiImage(id: number, adminId: number) {
  if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error('记录 ID 无效'), { status: 400 });
  return sqlite.transaction(() => {
    const admin = sqlite.prepare('SELECT role,is_active FROM users WHERE id=?').get(adminId) as {role: string; is_active: number} | undefined;
    if (!admin?.is_active || !isSuperAdmin(admin.role))
      throw Object.assign(new Error('需要有效的超级管理员账号'), { status: 403 });
    const { row, meta } = legacyImage(id);
    if (row.status === 'failed' && meta.legacyPidoiFailureResolution && meta.billingStatus === 'refunded')
      return { id, status: 'failed', refundedAmount: Number(meta.refundAmount) || 0, alreadyResolved: true };

    const { bill, source } = originalReservation(row, meta);
    const note = '管理员主动取消遗留图片任务，上游结果未确认';
    sqlite.prepare("UPDATE billing_reservations SET state='review' WHERE id=? AND state='reserved'").run(bill.id);
    const refund = resolveBillingReservation(bill.id, adminId, 0, note);
    if (refund.state !== 'refunded' || typeof refund.refunded !== 'number'
      || Math.abs(refund.refunded - bill.amount) > 0.000001) conflict('原预扣退款金额核验失败');
    const at = new Date().toISOString();
    sqlite.prepare("UPDATE contents SET status='failed',cost=0,metadata=? WHERE id=?").run(JSON.stringify({
      ...meta, failedAt: at, requiresReview: false, billingStatus: 'refunded', queueRefunded: true,
      refundedAt: at, refundAmount: refund.refunded,
      refundTarget: source === 'org' ? 'organization_balance' : 'user_balance',
      failureReason: '管理员已取消遗留图片任务，预扣金额已退回',
      progressText: '已取消并退款', legacyPidoiFailureResolution: { adminId, note, at },
    }), id);
    return { id, status: 'failed', refundedAmount: refund.refunded, alreadyResolved: false };
  }).immediate();
}
