import { sqlite } from '../db/index.js';
import { reservationContentId } from './billingReservation.js';
import { chargeRefundedVideo, recoveryChargeAmount } from './videoRecoveryService.js';
import { PricingService } from './pricingService.js';

const invalid = (message: string): never => { throw new Error(message); };
const amountOf = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return invalid('原订单金额缺失或无效，请核对账本');
  return value;
};

/** Nested transaction is a savepoint: a failed charge must not undo a recovered video.
 * Caller publishes this metadata and the content result in the surrounding transaction. */
export function settleOriginalVideoBilling(record: any, metadata: Record<string, any>) {
  return sqlite.transaction(() => {
    const meta = { ...metadata };
    let cost = amountOf(record.cost), chargedAmount = 0;
    const recharge = (amount: number, source: any, tokenId?: number, unlimitedToken = false) => {
      if (amount === 0) return;
      if (tokenId && !unlimitedToken) {
        meta.refundTarget = 'api_token';
      } else {
        if (!['user', 'org'].includes(source?.source) || source.source === 'org' && !source.orgId)
          return invalid('原扣退款账户记录缺失，请核对账本');
        meta.refundTarget = source.source === 'org' ? 'organization_balance' : 'user_balance';
        meta.billingOrgId = source.orgId;
      }
      meta.tokenId = tokenId || undefined;
      chargeRefundedVideo(record, meta, amount);
      chargedAmount = amount;
    };
    if (meta.batchItemId) {
      if (meta.billingReservationId) return invalid('订单同时关联两份预扣账本，请核对');
      const item = sqlite.prepare('SELECT * FROM video_batch_items WHERE id=?').get(meta.batchItemId) as any;
      if (!item || item.content_id !== record.id || item.user_id !== record.userId)
        return invalid('批量任务归属已变化，停止结算');
      cost = amountOf(item.unit_cost);
      if (item.billing_state === 'refunded') {
        if (amountOf(item.charged) !== 0) return invalid('批量退款账本金额不一致');
        recharge(cost, JSON.parse(item.receipt));
      } else if (item.billing_state === 'charged') {
        if (amountOf(item.charged) !== cost) return invalid('批量已结算金额不一致');
      } else if (item.billing_state !== 'reserved') return invalid('批量预扣状态无法结算');
      sqlite.prepare("UPDATE video_batch_items SET billing_state='charged',charged=unit_cost WHERE id=?").run(item.id);
      meta.batchSettled = true;
    } else if (meta.billingReservationId) {
      const reservation = sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(meta.billingReservationId) as any;
      if (!reservation) return invalid('原订单预扣账本缺失');
      const context = JSON.parse(reservation.context), receipt = JSON.parse(reservation.receipt);
      if (reservationContentId(reservation.id, context) !== record.id || Number(context.userId) !== record.userId)
        return invalid('预扣账本与原订单归属不一致');
      cost = amountOf(reservation.amount);
      if (['reserved', 'review'].includes(reservation.state) && Math.abs(amountOf(record.cost) - cost) > 0.000001)
        return invalid('订单金额与原预扣不一致，请核对账本');
      if (reservation.state === 'refunded') {
        if (amountOf(reservation.actual) !== 0) return invalid('原退款账本金额不一致');
        recharge(cost, context.tokenId ? receipt.balanceDeduction : receipt, context.tokenId, context.unlimitedToken);
      } else if (reservation.state === 'settled') {
        cost = amountOf(reservation.actual);
      } else if (!['reserved', 'review'].includes(reservation.state)) return invalid('原预扣状态无法结算');
      else if (reservation.actual != null && Math.abs(amountOf(reservation.actual) - cost) > 0.000001)
        return invalid('原账本实际费用与预扣不同，请核对后结算');
      sqlite.prepare("UPDATE billing_reservations SET state='settled',actual=?,settled_at=COALESCE(settled_at,datetime('now')) WHERE id=?")
        .run(cost, reservation.id);
    } else if (meta.billingStatus === 'refunded' || meta.queueRefunded === true) {
      if (!meta.refundTarget && meta.billingSource !== 'token' && !['user', 'org'].includes(meta.billingBalanceSource))
        return invalid('原退款来源缺失，费用待核实');
      cost = recoveryChargeAmount(record, meta);
      chargeRefundedVideo(record, meta, cost);
      chargedAmount = cost;
    } else if (!['reserved', 'review', 'charged', 'settled', 'charged_after_recovery'].includes(meta.billingStatus)
      && !['processing', 'queued', 'review'].includes(record.status)) {
      return invalid('缺少原扣款或退款凭据，请核对账本');
    }
    if (meta.snumomReferenceBilling) {
      if (!meta.upstreamBillingUsage || !meta.pricingSnapshot) return invalid('原任务实际用量记录缺失，费用待核实');
      const actual = PricingService.quoteSnapshot(meta.pricingSnapshot, {
        resolution: meta.upstreamBillingUsage.resolution || meta.resolution, seconds: meta.upstreamBillingUsage.billableSeconds, count: 1,
      }).cost;
      if (Math.abs(actual - cost) > 0.000001) return invalid('原任务实际用量与原金额不同，费用待核实');
    }
    Object.assign(meta, { billingStatus: 'settled', queueRefunded: false,
      originalVideoBilling: { settledAt: new Date().toISOString(), amount: cost, chargedAmount },
      ...(chargedAmount > 0 ? { recoveryCharged: true, recoveryChargeAmount: chargedAmount, refundReversedAt: new Date().toISOString() } : {}),
    });
    return { cost, chargedAmount, metadata: meta };
  })();
}
