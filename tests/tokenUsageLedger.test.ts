import Database from 'better-sqlite3';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { ensureFundLedger, withFundContext } from '../server/db/fundLedger';
import { listFundLedger } from '../server/services/fundLedgerQuery';
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,balance REAL);
    CREATE TABLE organizations(id INTEGER PRIMARY KEY,name TEXT,balance REAL);
    CREATE TABLE api_tokens(id INTEGER PRIMARY KEY,name TEXT,user_id INTEGER,balance REAL,used_amount REAL DEFAULT 0);
    CREATE TABLE model_pricing(id INTEGER PRIMARY KEY,input_price REAL);
    INSERT INTO users VALUES(98,'用户98',141.08),(99,'用户99',100);
    INSERT INTO organizations VALUES(1,'组织',50);
    INSERT INTO api_tokens VALUES(30,'无限Token',98,-1,1932.62),(31,'有限Token',98,50,20),(32,'其他用户',99,-1,1);
    INSERT INTO model_pricing VALUES(1,3.9);`);
});
afterEach(() => db.close());
const accounts = () => JSON.stringify({
  users: db.prepare('SELECT * FROM users').all(), orgs: db.prepare('SELECT * FROM organizations').all(),
  tokens: db.prepare('SELECT * FROM api_tokens').all(), prices: db.prepare('SELECT * FROM model_pricing').all(),
});
it('migrates an existing ledger without changing prices, historical balances or used amounts; snapshots only once', () => {
  db.exec(`CREATE TABLE fund_ledger(id INTEGER PRIMARY KEY AUTOINCREMENT,account_type TEXT NOT NULL,account_id INTEGER NOT NULL,
    account_name TEXT NOT NULL,user_id INTEGER,kind TEXT NOT NULL,delta REAL,balance_before REAL NOT NULL,balance_after REAL NOT NULL,
    actor_id INTEGER,content_id INTEGER,operation TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')));
    INSERT INTO fund_ledger(account_type,account_id,account_name,user_id,kind,delta,balance_before,balance_after,created_at)
    VALUES('user',98,'用户98',98,'charge',-3.9,144.98,141.08,'2026-10-20 15:22:17');`);
  const original = accounts(), oldRow = db.prepare('SELECT * FROM fund_ledger WHERE id=1').get();
  ensureFundLedger(db); ensureFundLedger(db);
  expect(accounts()).toBe(original);
  expect(db.prepare('SELECT * FROM fund_ledger WHERE id=1').get()).toEqual(oldRow);
  const baseline = db.prepare("SELECT * FROM fund_ledger WHERE account_type='token_usage'").all() as any[];
  expect(baseline).toHaveLength(3);
  expect(baseline.find(r => r.account_id === 30)).toMatchObject({ kind: 'usage_opening', delta: 0, balance_before: 1932.62, balance_after: 1932.62 });
});
it('captures direct SQL, no-op saves, transaction rollback and nested task context correctly', () => {
  ensureFundLedger(db);
  withFundContext(db, { kind: 'charge', contentId: 14001 }, () => db.exec('UPDATE api_tokens SET used_amount=used_amount+3.9 WHERE id=30'));
  db.exec('UPDATE api_tokens SET used_amount=used_amount WHERE id=30');
  expect(() => withFundContext(db, { kind: 'refund' }, () => {
    db.exec('UPDATE api_tokens SET used_amount=0 WHERE id=30'); throw Error('abort');
  })).toThrow('abort');
  const rows = listFundLedger(db, { userId: '98', accountType: 'token_usage', kind: 'charge' }).items as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ user_id: 98, user_name: '用户98', content_id: 14001, kind: 'charge', balance_before: 1932.62 });
  expect(rows[0].delta).toBeCloseTo(3.9);
  db.exec('UPDATE api_tokens SET used_amount=used_amount-1 WHERE id=30');
  expect((listFundLedger(db, { accountType: 'token_usage', kind: 'usage_decrease' }).items as any[])[0]).toMatchObject({ delta: -1, content_id: null });
});
it('filters one owner across multiple tokens, with kind/date/pagination and no other user leakage', () => {
  ensureFundLedger(db);
  withFundContext(db, { kind: 'charge' }, () => db.exec('UPDATE api_tokens SET used_amount=used_amount+2'));
  withFundContext(db, { kind: 'refund' }, () => db.exec('UPDATE api_tokens SET used_amount=used_amount-1 WHERE id=30'));
  db.exec("UPDATE fund_ledger SET created_at='2026-10-20 16:00:00' WHERE kind IN ('charge','refund')");
  const q = { userId: '98', accountType: 'token_usage', kind: 'charge', from: '2026-10-21', to: '2026-10-21', pageSize: '1' };
  expect(listFundLedger(db, q)).toMatchObject({ total: 2, page: 1, pageSize: 1 });
  expect((listFundLedger(db, q).items[0] as any).user_id).toBe(98);
  expect(listFundLedger(db, { ...q, page: '2' }).items).toHaveLength(1);
  expect(listFundLedger(db, { ...q, kind: 'refund' }).total).toBe(1);
  expect(listFundLedger(db, { ...q, accountId: '30' }).total).toBe(1);
  expect(listFundLedger(db, { ...q, userId: '999' }).total).toBe(0);
  expect(listFundLedger(db, { ...q, from: '2026-10-20', to: '2026-10-20' }).total).toBe(0);
  expect(listFundLedger(db, q).usageStartedAt).toBeTruthy();
  for (const userId of ['1 OR 1=1', ['98'], true, '0', -1]) expect(() => listFundLedger(db, { userId })).toThrow();
});
it('retains usage history through quota-mode changes and token deletion', () => {
  ensureFundLedger(db);
  withFundContext(db, { kind: 'charge' }, () => db.exec('UPDATE api_tokens SET used_amount=used_amount+1 WHERE id=30'));
  db.exec('UPDATE api_tokens SET balance=100 WHERE id=30;UPDATE api_tokens SET balance=-1 WHERE id=30;DELETE FROM api_tokens WHERE id=30');
  expect(listFundLedger(db, { accountType: 'token_usage', accountId: '30' }).total).toBe(2);
  expect(listFundLedger(db, { accountType: 'token', accountId: '30', kind: 'quota_mode' }).total).toBe(2);
});
it('records new token initial counters as a baseline, not a historical charge', () => {
  ensureFundLedger(db);
  db.exec("INSERT INTO api_tokens VALUES(33,'新Token',98,-1,8)");
  expect((listFundLedger(db, { accountType: 'token_usage', accountId: '33' }).items as any[])[0])
    .toMatchObject({ kind: 'usage_initial', delta: 0, balance_before: 8, balance_after: 8 });
});
