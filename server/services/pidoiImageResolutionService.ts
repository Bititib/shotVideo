import { sqlite } from '../db/index.js';
import { isSuperAdmin } from '../middleware/admin.js';
import { resolveBillingReservation } from './billingReconciliation.js';
import { recoverPidoiImage, pidoiImageActive } from './pidoiImageWorker.js';

const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };
function authorize(contentId: number, adminId: number) {
  if (!Number.isSafeInteger(contentId) || contentId <= 0) fail(400, '记录 ID 无效');
  const admin = sqlite.prepare('SELECT role,is_active FROM users WHERE id=?').get(adminId) as any;
  if (!admin?.is_active || !isSuperAdmin(admin.role)) fail(403, '需要有效的超级管理员账号');
  const row = sqlite.prepare('SELECT * FROM contents WHERE id=?').get(contentId) as any;
  if (!row) fail(404, '记录不存在');
  let meta: any;
  try { meta = JSON.parse(row.metadata || '{}'); } catch { fail(409, '记录信息损坏，请人工核查'); }
  if (row.type !== 'image' || meta?.imageProtocol !== 'pidoi-async-v1' || meta.managedSpecification || meta.batchItemId) fail(409, '该入口仅处理 Pidoi 网页图片任务');
  return { row, meta };
}

export async function recheckPidoiImage(contentId: number, adminId: number) {
  authorize(contentId, adminId);
  if (pidoiImageActive.has(contentId)) fail(409, '原任务正在提交或查询，请稍后刷新');
  await recoverPidoiImage(contentId);
  const { row, meta } = authorize(contentId, adminId);
  return { id: contentId, status: row.status, taskId: meta.upstreamTaskId || meta.taskId || '',
    message: row.status === 'completed' ? '图片已保存，已完成结算' : row.status === 'failed' ? '任务已结束，请查看退款信息'
      : meta.recoveryStage === 'download' ? '图片已生成，后台继续重试保存，不会重新生成'
      : meta.lastRecoveryError ? '查询暂未成功，未重新生成或退款；请核对原上游任务'
      : !meta.pidoiImageJobs?.length ? '未找到可查询任务 ID，请核对上游；确认未成功后可退款' : '已查询原任务，后台将继续跟进，不会重新生成' };
}

/** Explicit operator confirmation, ledger audit and content transition are one transaction.
 * Does not call upstream, resubmit, or allow full refunds for any known successful image. */
export function confirmPidoiImageFailure(contentId: number, adminId: number, confirmed: unknown, note: unknown) {
  if (confirmed !== true || typeof note !== 'string' || note.trim().length < 6 || note.length > 500) fail(400, '请核对上游未成功并填写 6–500 字的核实依据');
  return sqlite.transaction(() => {
    const { row, meta } = authorize(contentId, adminId);
    if (row.status === 'failed' && meta.pidoiFailureResolution && meta.billingStatus === 'refunded')
      return { id: contentId, status: 'failed', refundedAmount: Number(meta.refundAmount) || 0, alreadyResolved: true };
    if (pidoiImageActive.has(contentId)) fail(409, '任务正在提交或恢复，暂不能退款');
    if (row.status !== 'review') fail(409, '只允许处理结果待确认的任务');
    if (row.result_url || meta.imageUrls?.length || meta.upstreamImageUrls?.length
      || meta.pidoiImageJobs?.some((job: any) => job.localUrl || job.sourceUrl || job.status === 'completed'))
      fail(409, '已有成功结果或部分图片成功，请先恢复结果，不能全额退款');
    const bill = meta.billingReservationId && sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(meta.billingReservationId) as any;
    if (!bill || bill.state !== 'review' || !Number.isFinite(bill.amount) || bill.amount < 0 || Math.abs(bill.amount - Number(row.cost)) > 0.000001)
      fail(409, '预扣账本状态或金额不一致，请到异常账单核查');
    const context = JSON.parse(bill.context), receipt = JSON.parse(bill.receipt);
    if (context.userId !== row.user_id || Number(context.contentId) !== contentId || context.tokenId || !['user', 'org'].includes(receipt.source))
      fail(409, '原扣款来源或账单归属不一致，停止退款');
    if (receipt.source === 'org' && (!receipt.orgId || !sqlite.prepare('SELECT id FROM organizations WHERE id=?').get(receipt.orgId)))
      fail(409, '原扣款组织不存在，请人工核对，不能退入其他账户');
    resolveBillingReservation(bill.id, adminId, 0, String(note).trim());
    const at = new Date().toISOString();
    sqlite.prepare("UPDATE contents SET status='failed',cost=0,metadata=? WHERE id=?").run(JSON.stringify({ ...meta,
      billingStatus: 'refunded', refundAmount: bill.amount, refundedAt: at, queueRefunded: true,
      refundTarget: receipt.source === 'org' ? 'organization_balance' : 'user_balance',
      requiresReview: false, failedAt: at, progressText: '管理员核实未成功，已退款', failureReason: '管理员核实未成功，已退回原扣款来源',
      pidoiFailureResolution: { adminId, note: String(note).trim(), at },
    }), contentId);
    return { id: contentId, status: 'failed', refundedAmount: bill.amount, alreadyResolved: false };
  })();
}
