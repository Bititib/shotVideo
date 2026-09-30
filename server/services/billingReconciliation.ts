import { sqlite } from '../db/index.js';
import { ensureBillingReservations } from './billingReservation.js';
import { BalanceService } from './balanceService.js';
import { TokenService } from './tokenService.js';

const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };
export function listBillingReservations(page = 1, state = 'pending') {
  ensureBillingReservations();
  // Flag abandoned reservations, never infer a refund from elapsed time alone.
  sqlite.prepare("UPDATE billing_reservations SET state='review' WHERE state='reserved' AND created_at < datetime('now','-24 hours')").run();
  page = Number.isSafeInteger(page) && page > 0 ? page : 1;
  const where = state === 'all' ? '1=1' : "r.state IN ('review','reserved')";
  const total = (sqlite.prepare(`SELECT count(*) AS n FROM billing_reservations r WHERE ${where}`).get() as { n: number }).n;
  const items = sqlite.prepare(`SELECT r.id,r.amount,r.actual,r.state,r.context,r.created_at,r.settled_at,
    a.note,a.admin_id,a.refunded FROM billing_reservations r LEFT JOIN billing_resolution_audit a ON a.reservation_id=r.id
    WHERE ${where} ORDER BY CASE r.state WHEN 'review' THEN 0 WHEN 'reserved' THEN 1 ELSE 2 END,r.created_at DESC LIMIT 30 OFFSET ?`).all((page - 1) * 30).map((r: any) => ({ ...r, context: JSON.parse(r.context) }));
  return { items, total, page, pageSize: 30 };
}

export function resolveBillingReservation(id: string, adminId: number, actual: number, note: string) {
  ensureBillingReservations();
  if (!Number.isFinite(actual) || actual < 0 || Math.abs(actual * 1e6 - Math.round(actual * 1e6)) > 0.0001) fail(400, '实收金额需为非负数，最多六位小数');
  if (typeof note !== 'string' || note.trim().length < 6 || note.length > 2000) fail(400, '请填写至少六字的上游核对依据');
  return sqlite.transaction(() => {
    const row = sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(id) as any;
    if (!row) fail(404, '账单不存在');
    if (!['reserved','review'].includes(row.state)) {
      const audit = sqlite.prepare('SELECT actual,note FROM billing_resolution_audit WHERE reservation_id=?').get(id) as any;
      if (audit?.actual === actual && audit?.note === note.trim()) return { id, state: row.state, alreadyResolved: true };
      fail(409, '该账单已结算，请刷新后核对');
    }
    if (row.state === 'reserved') fail(409, '任务仍在预扣中，不能覆盖运行中的结算');
    if (actual > row.amount) fail(400, '实收不能超过原预扣金额，超额费用不自动追加扣款');
    const context = JSON.parse(row.context), receipt = JSON.parse(row.receipt);
    const difference = Math.max(0, Math.round((row.amount - actual) * 1e6) / 1e6);
    if (difference) {
      const source = context.tokenId ? receipt.balanceDeduction : receipt;
      const linked = context.tokenId && ['organization_balance','user_balance'].includes(receipt.target);
      if (!context.tokenId || linked) {
        if (!Number.isSafeInteger(context.userId) || !['org','user'].includes(source?.source)) fail(409, '原扣款来源不完整，无法安全退款');
        if (!sqlite.prepare('SELECT id FROM users WHERE id=?').get(context.userId)) fail(409, '原用户已删除，请人工核对');
        BalanceService.refundToSource(context.userId, difference, source.source, source.orgId, 'reconciliation_refund');
      }
      if (context.tokenId) {
        if (!sqlite.prepare('SELECT id FROM api_tokens WHERE id=?').get(context.tokenId)) fail(409, '原 API Key 已删除，请人工核对');
        if (!['api_token','organization_balance','user_balance'].includes(receipt.target)) fail(409, '无法识别原 API 扣款来源');
        TokenService.refundBalance(context.tokenId, difference);
      }
    }
    const state = actual === 0 ? 'refunded' : 'settled';
    sqlite.prepare("UPDATE billing_reservations SET actual=?,state=?,settled_at=datetime('now') WHERE id=?").run(actual,state,id);
    sqlite.prepare('INSERT INTO billing_resolution_audit(reservation_id,admin_id,actual,refunded,note) VALUES(?,?,?,?,?)').run(id,adminId,actual,difference,note.trim());
    // Historical content displays must agree with the authoritative reservation ledger.
    if (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contents'").get()) {
      sqlite.prepare(`UPDATE contents SET cost=?,metadata=json_set(metadata,'$.billingStatus',?,'$.refundAmount',?)
        WHERE json_valid(metadata) AND json_extract(metadata,'$.billingReservationId')=?`).run(actual,state,difference,id);
    }
    return { id, state, refunded: difference };
  })();
}
