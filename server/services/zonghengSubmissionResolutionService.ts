import { isZonghengChannel } from './zonghengAdapter.js';
import { eq, sql } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { apiTokens, channels, contents, organizations, users } from '../db/schema.js';
import { BalanceService } from './balanceService.js';
import { TokenService } from './tokenService.js';
import { resolveBillingReservation } from './billingReconciliation.js';
import { withFundContext } from '../db/fundLedger.js';
import { isTaskIdPlaceholder } from '../../shared/upstreamTaskId.js';
import { videoReviewKind } from '../../shared/videoReview.js';
import { findVideoSubmissionReceipt } from './videoSubmissionReceiptService.js';
import { assertNoTaskIdVerification } from './videoRecoveryAction.js';

/** Synchronous: callers keep the balance change and content update in one transaction. */
function refundLegacyFunds(row: any, meta: Record<string, any>, amount: number): string {
  return withFundContext(sqlite, { contentId: row.id, kind: 'refund' }, () => {
  const owner = db.select().from(users).where(eq(users.id, row.userId)).get();
  if (!owner) fail(409, '原扣款用户不存在，请人工核查');
  const tokenId = Number(meta.tokenId) || 0;
  const token = tokenId ? db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get() : null;
  if (tokenId && (!token || token.userId !== row.userId)) fail(409, '原 API Token 不存在或归属不一致，请人工核查');
  if (meta.billingSource === 'token') {
    if (!token || token.balance === -1) fail(409, '原 Token 计费模式已变更，请人工核查');
    TokenService.refundBalance(tokenId, amount);
    return 'api_token';
  }
  const source = meta.billingBalanceSource === 'org' ? 'org' : meta.billingBalanceSource === 'user' ? 'user' : row.orgId ? 'org' : 'user';
  const orgId = Number(meta.billingOrgId || row.orgId) || undefined;
  if (source === 'org' && (!orgId || !db.select().from(organizations).where(eq(organizations.id, orgId)).get())) fail(409, '原扣款组织不存在，请人工核查');
  BalanceService.refundToSource(row.userId, amount, source, orgId, 'generate_video_refund');
  if (token) db.update(apiTokens).set({ usedAmount: sql`MAX(0, used_amount - ${amount})` }).where(eq(apiTokens.id, tokenId)).run();
  return source === 'org' ? 'organization_balance' : 'user_balance';
  });
}

const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };
/** Administrator-confirmed non-acceptance; no provider POST and exactly one refund. */
function confirmNotAccepted(contentId: number, adminId: number, confirmed: unknown, note: unknown, zonghengOnly: boolean) {
  assertNoTaskIdVerification(contentId);
  if (!Number.isSafeInteger(contentId) || contentId <= 0 || !Number.isSafeInteger(adminId) || adminId <= 0) fail(400, '记录或操作人无效');
  if (confirmed !== true || typeof note !== 'string' || note.trim().length < 6 || note.length > 500) fail(400, '请先核对上游未接单，并填写核对依据');
  const resolutionNote = String(note).trim();
  return sqlite.transaction(() => {
    const row = db.select().from(contents).where(eq(contents.id, contentId)).get();
    if (!row) fail(404, '记录不存在');
    let meta: Record<string, any>;
    try { meta = JSON.parse(row.metadata || '{}'); } catch { fail(409, '记录信息无法解析，请人工核查'); }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) fail(409, '记录信息无法解析，请人工核查');
    if (row.status === 'failed' && row.cost === 0 && (meta.adminFailureRefundResolution || meta.zonghengNotAcceptedResolution)) {
      return { id: contentId, status: 'failed', refundedAmount: Number(meta.refundAmount) || 0, alreadyResolved: true };
    }
    if (row.type !== 'video' || row.status !== 'review') fail(409, '仅可处理待核实的视频任务');
    const channel = meta.channelId ? db.select().from(channels).where(eq(channels.id, Number(meta.channelId))).get() : null;
    if (zonghengOnly && !isZonghengChannel(channel) && meta.actualChannel !== 'zongheng') fail(409, '该入口仅处理纵横渠道的待核实任务');
    if (!zonghengOnly && videoReviewKind(meta) !== 'submission') fail(409, '仅可处理提交待核实且未取得上游任务 ID 的视频');
    if (meta.batchItemId || meta.managedSpecification) fail(409, '请通过对应批次或销售路由处理该记录');
    const taskIds = [meta.videoId, meta.taskId, meta.task_id, meta.upstreamTaskId, meta.upstream_task_id, meta.requestId, meta.request_id,
      ...(Array.isArray(meta.upstreamTaskIds) ? meta.upstreamTaskIds : []), ...(Array.isArray(meta.recoveryTaskIds) ? meta.recoveryTaskIds : [])];
    const resultUrls = [row.resultUrl, meta.upstreamResultUrl, ...(Array.isArray(meta.recoverySourceUrls) ? meta.recoverySourceUrls : [])];
    if (taskIds.some(id => typeof id === 'string' ? id.trim() && !isTaskIdPlaceholder(id) : Boolean(id))
      || findVideoSubmissionReceipt(contentId) || resultUrls.some(url => typeof url === 'string' && url.trim())) fail(409, '记录已有任务 ID 或结果，请先查询原任务');
    if (meta.queueRefunded || ['refunded','settled'].includes(meta.billingStatus)) fail(409, '记录已结算，请刷新核查');
    const amount = Number(row.cost);
    if (!Number.isFinite(amount) || amount < 0 || Math.abs(amount * 1e6 - Math.round(amount * 1e6)) > 0.0001) fail(409, '预扣金额异常，请人工核查');
    let target = 'not_charged';
    if (meta.billingReservationId) {
      const reservation = sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(meta.billingReservationId) as any;
      if (!reservation || reservation.state !== 'review' || Math.abs(reservation.amount - amount) > 0.000001) fail(409, '预扣账本状态或金额不一致，请到异常账单核查');
      const receipt = JSON.parse(reservation.receipt), context = JSON.parse(reservation.context);
      if (context.userId !== row.userId || context.contentId != null && Number(context.contentId) !== contentId) fail(409, '预扣账本归属不一致');
      resolveBillingReservation(meta.billingReservationId, adminId, 0, resolutionNote);
      target = receipt.target || (receipt.source === 'org' ? 'organization_balance' : 'user_balance');
    } else if (amount > 0) {
      target = refundLegacyFunds(row, meta, amount);
    }
    const now = new Date().toISOString();
    const failureMessage = String(meta.error || meta.progressText || '管理员确认上游未接单并执行失败退款').slice(0, 1000);
    const resolution = { adminId, note: resolutionNote, confirmedAt: now, refundAmount: amount };
    const metadata = { ...meta, requiresReview: false, hayaNeedsReview: false, queueStatus: 'failed', queuePosition: 0,
      billingStatus: amount > 0 ? 'refunded' : 'not_charged', queueRefunded: amount > 0, refundAmount: amount, refundTarget: target,
      refundedAt: amount > 0 ? now : undefined, failedAt: now, error: failureMessage, progressText: failureMessage,
      adminFailureRefundResolution: resolution,
      ...(isZonghengChannel(channel) || meta.actualChannel === 'zongheng' ? { zonghengNotAcceptedResolution: resolution } : {}) };
    db.update(contents).set({status:'failed',cost:0,metadata:JSON.stringify(metadata)}).where(eq(contents.id,contentId)).run();
    return { id: contentId, status: 'failed', refundedAmount: amount, refundTarget: target, alreadyResolved: false };
  })();
}

export function confirmZonghengNotAccepted(contentId: number, adminId: number, confirmed: unknown, note: unknown) {
  return confirmNotAccepted(contentId, adminId, confirmed, note, true);
}

export function confirmReviewedVideoFailureAndRefund(contentId: number, adminId: number, confirmed: unknown) {
  return confirmNotAccepted(contentId, adminId, confirmed, '管理员确认上游未接单并执行失败退款', false);
}

/** Only call for a proven unsent request, explicit rejection, or an upstream failed task. */
export function refundConfirmedZonghengVideo(contentId: number, message: string) {
  return sqlite.transaction(() => {
    const row = db.select().from(contents).where(eq(contents.id, contentId)).get();
    if (!row || ['failed','completed'].includes(row.status)) return;
    const meta = JSON.parse(row.metadata || '{}');
    const channel = db.select().from(channels).where(eq(channels.id, Number(meta.channelId))).get();
    if (row.type !== 'video' || !isZonghengChannel(channel) || meta.batchItemId || meta.managedSpecification) fail(409, '记录不属于普通纵横视频任务');
    const amount = Number(row.cost);
    if (!Number.isFinite(amount) || amount < 0) fail(409, '预扣金额异常');
    if (meta.queueRefunded || ['refunded','settled'].includes(meta.billingStatus)) fail(409, '账单已结算，请核查记录状态');
    let target = 'not_charged';
    if (meta.billingReservationId) {
      const reservation = sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(meta.billingReservationId) as any;
      if (!reservation || !['reserved','review'].includes(reservation.state) || Math.abs(reservation.amount - amount) > 0.000001) fail(409, '预扣账本状态或金额不一致');
      const receipt = JSON.parse(reservation.receipt), context = JSON.parse(reservation.context);
      if (context.userId !== row.userId) fail(409, '预扣账本归属不一致');
      const source = context.tokenId ? receipt.balanceDeduction : receipt;
      target = amount > 0 ? refundLegacyFunds(row, {tokenId:context.tokenId,billingSource:receipt.target === 'api_token'?'token':'user',billingBalanceSource:source?.source,billingOrgId:source?.orgId}, amount) : 'not_charged';
      sqlite.prepare("UPDATE billing_reservations SET actual=0,state='refunded',settled_at=datetime('now') WHERE id=?").run(reservation.id);
    } else if (amount > 0) target = refundLegacyFunds(row, meta, amount);
    const now = new Date().toISOString();
    db.update(contents).set({status:'failed',cost:0,metadata:JSON.stringify({...meta,requiresReview:false,queueStatus:'failed',queuePosition:0,
      billingStatus:amount>0?'refunded':'not_charged',queueRefunded:amount>0,refundAmount:amount,refundTarget:target,
      refundedAt:amount>0?now:undefined,failedAt:now,error:message,progressText:message})}).where(eq(contents.id,contentId)).run();
  })();
}
