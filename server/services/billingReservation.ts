import { randomUUID } from 'node:crypto';
import { sqlite } from '../db/index.js';
import { BalanceService } from './balanceService.js';
import { captureFundEntries, linkFundEntries, withFundContext } from '../db/fundLedger.js';

export function ensureBillingReservations() {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS billing_reservations (id TEXT PRIMARY KEY, amount REAL NOT NULL, actual REAL, state TEXT NOT NULL, receipt TEXT NOT NULL, context TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), settled_at TEXT)`);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS billing_resolution_audit (
    id INTEGER PRIMARY KEY, reservation_id TEXT NOT NULL UNIQUE, admin_id INTEGER NOT NULL,
    actual REAL NOT NULL, refunded REAL NOT NULL, note TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
  )`);
}

/** A unique stored reservation pointer is evidence; time/amount matching is not. */
export function reservationContentId(reservationId: string, context: Record<string, any>): number | undefined {
  if (Number.isSafeInteger(context.contentId) && context.contentId > 0) return context.contentId;
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='contents'").get()) return undefined;
  const rows = sqlite.prepare("SELECT id FROM contents WHERE CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.billingReservationId') ELSE NULL END=? LIMIT 2").all(reservationId) as Array<{id:number}>;
  return rows.length === 1 ? rows[0].id : undefined;
}

export function reserveCharge<T>(amount: number, deduct: (amount: number) => T, refund: (amount: number, receipt: T) => void, context: Record<string, unknown> = {}) {
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid reservation amount');
  ensureBillingReservations();
  const id = randomUUID();
  const receipt = sqlite.transaction(() => {
    const captured = captureFundEntries(sqlite, () => withFundContext(sqlite, { contentId: context.contentId as number | undefined }, () => deduct(amount)));
    const receipt = captured.value;
    sqlite.prepare('INSERT INTO billing_reservations(id,amount,state,receipt,context) VALUES(?,?,?,?,?)').run(id, amount, 'reserved', JSON.stringify(receipt), JSON.stringify({ ...context, fundLedgerEntryIds: captured.entryIds }));
    return receipt;
  })();
  const settle = (actual: number) => sqlite.transaction(() => {
    if (!Number.isFinite(actual) || actual < 0) throw new Error('Invalid settlement amount');
    const row = sqlite.prepare('SELECT state,context FROM billing_reservations WHERE id=?').get(id) as {state: string;context:string};
    if (row.state !== 'reserved') return;
    // Never release a consumed reservation when the provider exceeds its estimate.
    // Keep the original funds pending reconciliation instead of charging an unapproved excess.
    if (actual > amount + 0.000001) {
      sqlite.prepare("UPDATE billing_reservations SET actual=?,state='review' WHERE id=?").run(actual, id);
      return;
    }
    const difference = Math.max(0, Math.round((amount - actual) * 1e6) / 1e6);
    const storedContext = JSON.parse(row.context);
    const captured = captureFundEntries(sqlite, () => {
      if (difference) withFundContext(sqlite, { contentId: reservationContentId(id,storedContext), kind: 'refund' }, () => refund(difference, receipt));
    });
    sqlite.prepare('UPDATE billing_reservations SET actual=?,state=?,context=?,settled_at=datetime(\'now\') WHERE id=?').run(actual, actual === 0 ? 'refunded' : 'settled', JSON.stringify({ ...storedContext, fundLedgerEntryIds: [...new Set([...(storedContext.fundLedgerEntryIds || []), ...captured.entryIds])] }), id);
  })();
  const review = () => sqlite.prepare("UPDATE billing_reservations SET state='review' WHERE id=? AND state='reserved'").run(id);
  return { id, amount, receipt, settle, review, cancel: () => settle(0) };
}

/** Bind explicitly captured reservation entries after its content row exists. */
export function linkReservationContent(reservationId: string, contentId: number) {
  return sqlite.transaction(() => {
    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='billing_reservations'").get()) return;
    const row = sqlite.prepare('SELECT context FROM billing_reservations WHERE id=?').get(reservationId) as any;
    if (!row) return;
    const context = JSON.parse(row.context || '{}');
    const content = sqlite.prepare('SELECT user_id FROM contents WHERE id=?').get(contentId) as any;
    if (!content) throw new Error('生成任务不存在，停止关联资金流水');
    if ((context.contentId && Number(context.contentId) !== contentId)
      || (context.userId != null && Number(context.userId) !== content.user_id)) throw new Error('预扣账本与生成任务归属不一致');
    if (context.fundLedgerEntryIds?.length) linkFundEntries(sqlite, context.fundLedgerEntryIds, contentId);
    sqlite.prepare('UPDATE billing_reservations SET context=? WHERE id=?').run(JSON.stringify({ ...context, contentId }), reservationId);
  })();
}

export function reserveUserCharge(userId: number, amount: number, operation: string, context: Record<string, unknown> = {}) {
  return reserveCharge(amount, cost => {
    const receipt = BalanceService.deductWithSource(userId, cost, operation + '_prededuct');
    if (!receipt) throw Object.assign(new Error('余额不足，请充值后重试'), { status: 402 });
    return receipt;
  }, (cost, receipt) => { BalanceService.refundToSource(userId, cost, receipt.source, receipt.orgId, operation + '_refund'); }, { ...context, userId, operation });
}
