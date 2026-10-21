import { sqlite } from '../db/index.js';
import { BalanceService } from './balanceService.js';

/** Durable finalization also used by recovery pollers. Unknown upstream outcomes keep funds in review. */
export function finalizeReservedContent(
  contentId: number,
  outcome: 'completed' | 'failed' | 'review',
  patch: Record<string, any> = {},
  resultUrl?: string,
  completedFraction = 1,
  completedActual?: number,
): boolean {
  if (!Number.isFinite(completedFraction) || completedFraction <= 0 || completedFraction > 1) throw new Error('完成比例无效，停止结算');
  return sqlite.transaction(() => {
    const content = sqlite.prepare('SELECT * FROM contents WHERE id=?').get(contentId) as any;
    if (!content) return false;
    const metadata = JSON.parse(content.metadata || '{}');
    if (!metadata.billingReservationId || metadata.managedSpecification) return false;
    const reservation = sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(metadata.billingReservationId) as any;
    if (!reservation) throw new Error('视频预扣账本缺失，停止结算');
    if (!['reserved', 'review'].includes(reservation.state)) return true;
    const merged = { ...metadata, ...patch };
    if (outcome === 'review') {
      sqlite.prepare("UPDATE billing_reservations SET state='review' WHERE id=?").run(reservation.id);
      sqlite.prepare("UPDATE contents SET status='review', metadata=? WHERE id=?").run(JSON.stringify({ ...merged, billingStatus: 'review', requiresReview: true }), contentId);
      return true;
    }
    if (completedActual !== undefined && (!Number.isFinite(completedActual) || completedActual < 0)) {
      throw new Error('视频实际费用无效，停止结算');
    }
    const actual = outcome === 'completed'
      ? completedActual ?? (completedFraction === 1 ? reservation.amount : Math.round(reservation.amount * completedFraction * 1e6) / 1e6) : 0;
    const receipt = JSON.parse(reservation.receipt), context = JSON.parse(reservation.context);
    let supplement: ReturnType<typeof BalanceService.deductWithSource> | null = null;
    if (outcome === 'completed' && actual > reservation.amount + 0.000001) {
      const shortfall = Math.round((actual - reservation.amount) * 1e6) / 1e6;
      supplement = BalanceService.deductWithSource(context.userId, shortfall, 'generate_video_supplement', { contentId, reservationId: reservation.id });
      if (!supplement) {
        sqlite.prepare("UPDATE billing_reservations SET actual=?,state='review' WHERE id=?").run(actual, reservation.id);
        sqlite.prepare("UPDATE contents SET status='review',result_url=COALESCE(?,result_url),metadata=? WHERE id=?").run(resultUrl || null,
          JSON.stringify({ ...merged, billingStatus: 'review', reviewKind: 'settlement', upstreamStatus: 'completed', requiresReview: true, billingShortfall: shortfall,
            progressText: '视频已生成，实际费用高于预扣且余额不足，请补充余额后结算' }), contentId);
        return true;
      }
    }
    const refund = Math.max(0, Math.round((reservation.amount - actual) * 1e6) / 1e6);
    if (refund > 0) BalanceService.refundToSource(context.userId, refund, receipt.source, receipt.orgId, (context.operation || 'generate_video') + '_refund', { contentId });
    const state = outcome === 'completed' ? 'settled' : 'refunded';
    sqlite.prepare("UPDATE billing_reservations SET actual=?,state=?,settled_at=datetime('now') WHERE id=?").run(actual, state, reservation.id);
    sqlite.prepare('UPDATE contents SET status=?,cost=?,result_url=COALESCE(?,result_url),metadata=? WHERE id=?').run(outcome, actual, resultUrl || null,
      JSON.stringify({ ...merged, billingStatus: state, requiresReview: false, reviewKind: null, upstreamQueryError: null, queueStatus: outcome, queuePosition: 0,
        ...(supplement ? { billingSupplementAmount: Math.max(0, actual - reservation.amount), billingSupplementSource: supplement.source } : {}),
        refundAmount: refund, queueRefunded: outcome === 'failed', ...(refund > 0 ? { refundedAt: new Date().toISOString(), refundTarget: receipt.source === 'org' ? 'organization_balance' : 'user_balance' } : {}) }), contentId);
    return true;
  })();
}
