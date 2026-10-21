import { sqlite } from '../db/index.js';
import { BalanceService } from './balanceService.js';
import { TokenService } from './tokenService.js';
import { withFundContext } from '../db/fundLedger.js';

type SettlementResult = { settled: boolean; review: boolean; actualCost: number };

/** The refund and terminal record are one write transaction, even for old API tasks. */
export function refundUnreservedVideo(contentId: number, message: string): void {
  sqlite.transaction(() => withFundContext(sqlite, { contentId, kind: 'refund' }, () => {
    const row = sqlite.prepare('SELECT * FROM contents WHERE id=?').get(contentId) as any;
    if (!row || ['failed', 'completed'].includes(row.status)) return;
    const meta = JSON.parse(row.metadata || '{}');
    const amount = Math.max(0, Number(row.cost) || 0);
    if (amount > 0 && !meta.queueRefunded) {
      if (meta.billingSource === 'token' && meta.tokenId) {
        TokenService.refundBalance(Number(meta.tokenId), amount);
        meta.refundTarget = 'api_token';
      } else {
        const source = meta.billingBalanceSource || (row.org_id ? 'org' : 'user');
        BalanceService.refundToSource(row.user_id, amount, source, Number(meta.billingOrgId || row.org_id) || undefined,
          'generate_video_refund', { contentId });
        if (meta.tokenId) TokenService.refundBalance(Number(meta.tokenId), amount);
        meta.refundTarget = source === 'org' ? 'organization_balance' : 'user_balance';
      }
      Object.assign(meta, { queueRefunded: true, billingStatus: 'refunded', refundAmount: amount, refundedAt: new Date().toISOString() });
    }
    if (meta.recoveryPrecharged) meta.recoveryCharged = false;
    Object.assign(meta, { queueStatus: 'failed', queuePosition: 0, error: message, failedAt: new Date().toISOString() });
    sqlite.prepare("UPDATE contents SET status='failed',cost=0,metadata=? WHERE id=?").run(JSON.stringify(meta), contentId);
  })).immediate();
}

/** Settle API-created videos that predate/use no billing reservation ledger. */
export function settleDirectVideoBilling(
  contentId: number,
  actualCost: number,
  patch: Record<string, any>,
  resultUrl: string,
): SettlementResult {
  if (!Number.isFinite(actualCost) || actualCost < 0) throw new Error('视频实际费用无效，停止结算');
  return sqlite.transaction(() => {
    const row = sqlite.prepare('SELECT * FROM contents WHERE id=?').get(contentId) as any;
    if (!row) throw new Error('视频记录不存在，停止结算');
    if (['completed', 'failed'].includes(row.status)) return { settled: true, review: false, actualCost: Number(row.cost) || 0 };
    const metadata = { ...JSON.parse(row.metadata || '{}'), ...patch };
    const reserved = Math.max(0, Number(row.cost) || 0);
    const tokenId = Number(metadata.tokenId) || 0;
    if (!tokenId || metadata.source !== 'api') return { settled: false, review: false, actualCost };

    const difference = Math.round(Math.abs(actualCost - reserved) * 1e6) / 1e6;
    try {
      sqlite.transaction(() => withFundContext(sqlite, { contentId }, () => {
      if (actualCost < reserved && difference > 0) {
        if (metadata.billingSource === 'user') {
          BalanceService.refundToSource(row.user_id, difference, metadata.billingBalanceSource || 'user', metadata.billingOrgId,
            'generate_video_actual_refund', { contentId });
        }
        TokenService.refundBalance(tokenId, difference);
      } else if (actualCost > reserved && difference > 0) {
        if (metadata.billingSource === 'user') {
          const supplement = BalanceService.deductWithSource(row.user_id, difference, 'generate_video_actual_supplement', { contentId });
          if (!supplement) throw Object.assign(new Error('余额不足，无法补扣实际费用'), { status: 402 });
          metadata.billingSupplementSource = supplement.source;
        }
        TokenService.deductBalance(tokenId, difference);
        metadata.billingSupplementAmount = difference;
      }
      }))();
    } catch (error: any) {
      metadata.billingStatus = 'review';
      metadata.requiresReview = true;
      metadata.billingShortfall = actualCost > reserved ? difference : 0;
      metadata.progressText = error?.message || '实际费用结算失败，请人工核实';
      sqlite.prepare("UPDATE contents SET status='review',result_url=COALESCE(?,result_url),metadata=? WHERE id=?")
        .run(resultUrl || null, JSON.stringify(metadata), contentId);
      return { settled: true, review: true, actualCost };
    }

    metadata.billingStatus = 'charged';
    metadata.requiresReview = false;
    metadata.refundAmount = actualCost < reserved ? difference : 0;
    sqlite.prepare("UPDATE contents SET status='completed',cost=?,result_url=COALESCE(?,result_url),metadata=? WHERE id=?")
      .run(actualCost, resultUrl || null, JSON.stringify(metadata), contentId);
    return { settled: true, review: false, actualCost };
  })();
}
