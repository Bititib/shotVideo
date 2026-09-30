import { randomUUID } from 'node:crypto';
import { sqlite } from '../db/index.js';
import { BalanceService } from './balanceService.js';

export function ensureBillingReservations() {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS billing_reservations (id TEXT PRIMARY KEY, amount REAL NOT NULL, actual REAL, state TEXT NOT NULL, receipt TEXT NOT NULL, context TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), settled_at TEXT)`);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS billing_resolution_audit (
    id INTEGER PRIMARY KEY, reservation_id TEXT NOT NULL UNIQUE, admin_id INTEGER NOT NULL,
    actual REAL NOT NULL, refunded REAL NOT NULL, note TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
  )`);
}

export function reserveCharge<T>(amount: number, deduct: (amount: number) => T, refund: (amount: number, receipt: T) => void, context: Record<string, unknown> = {}) {
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid reservation amount');
  ensureBillingReservations();
  const id = randomUUID();
  const receipt = sqlite.transaction(() => {
    const receipt = deduct(amount);
    sqlite.prepare('INSERT INTO billing_reservations(id,amount,state,receipt,context) VALUES(?,?,?,?,?)').run(id, amount, 'reserved', JSON.stringify(receipt), JSON.stringify(context));
    return receipt;
  })();
  const settle = (actual: number) => sqlite.transaction(() => {
    if (!Number.isFinite(actual) || actual < 0) throw new Error('Invalid settlement amount');
    const row = sqlite.prepare('SELECT state FROM billing_reservations WHERE id=?').get(id) as {state: string};
    if (row.state !== 'reserved') return;
    // Never release a consumed reservation when the provider exceeds its estimate.
    // Keep the original funds pending reconciliation instead of charging an unapproved excess.
    if (actual > amount + 0.000001) {
      sqlite.prepare("UPDATE billing_reservations SET actual=?,state='review' WHERE id=?").run(actual, id);
      return;
    }
    const difference = Math.max(0, Math.round((amount - actual) * 1e6) / 1e6);
    if (difference) refund(difference, receipt);
    sqlite.prepare('UPDATE billing_reservations SET actual=?,state=?,settled_at=datetime(\'now\') WHERE id=?').run(actual, actual === 0 ? 'refunded' : 'settled', id);
  })();
  const review = () => sqlite.prepare("UPDATE billing_reservations SET state='review' WHERE id=? AND state='reserved'").run(id);
  return { id, amount, receipt, settle, review, cancel: () => settle(0) };
}

export function reserveUserCharge(userId: number, amount: number, operation: string, context: Record<string, unknown> = {}) {
  return reserveCharge(amount, cost => {
    const receipt = BalanceService.deductWithSource(userId, cost, operation + '_prededuct');
    if (!receipt) throw Object.assign(new Error('余额不足，请充值后重试'), { status: 402 });
    return receipt;
  }, (cost, receipt) => { BalanceService.refundToSource(userId, cost, receipt.source, receipt.orgId, operation + '_refund'); }, { ...context, userId, operation });
}
