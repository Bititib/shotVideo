import { sqlite } from '../db/index.js';
import { BalanceService } from './balanceService.js';

/** Durable finalization also used by recovery pollers. Unknown upstream outcomes keep funds in review. */
export function finalizeReservedContent(contentId: number, outcome: 'completed' | 'failed' | 'review', patch: Record<string, any> = {}, resultUrl?: string): boolean {
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
    const actual = outcome === 'completed' ? reservation.amount : 0;
    const refund = reservation.amount - actual;
    const receipt = JSON.parse(reservation.receipt), context = JSON.parse(reservation.context);
    if (refund > 0) BalanceService.refundToSource(context.userId, refund, receipt.source, receipt.orgId, (context.operation || 'generate_video') + '_refund');
    const state = outcome === 'completed' ? 'settled' : 'refunded';
    sqlite.prepare("UPDATE billing_reservations SET actual=?,state=?,settled_at=datetime('now') WHERE id=?").run(actual, state, reservation.id);
    sqlite.prepare('UPDATE contents SET status=?,cost=?,result_url=COALESCE(?,result_url),metadata=? WHERE id=?').run(outcome, actual, resultUrl || null,
      JSON.stringify({ ...merged, billingStatus: state, requiresReview: false, queueStatus: outcome, queuePosition: 0,
        refundAmount: refund, queueRefunded: outcome === 'failed', ...(refund > 0 ? { refundedAt: new Date().toISOString(), refundTarget: receipt.source === 'org' ? 'organization_balance' : 'user_balance' } : {}) }), contentId);
    return true;
  })();
}
