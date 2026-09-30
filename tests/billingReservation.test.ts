import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const schema = await import('../server/db/schema.js');
  const sqlite = new Database(':memory:');
  return { sqlite, db: drizzle(sqlite, { schema }) };
});
import { sqlite } from '../server/db/index.js';
import { reserveCharge, reserveUserCharge } from '../server/services/billingReservation.js';
import { BalanceService } from '../server/services/balanceService.js';
import { TokenService } from '../server/services/tokenService.js';
import { listBillingReservations, resolveBillingReservation } from '../server/services/billingReconciliation.js';

describe('manual reconciliation of interrupted billing', () => {
  it('flags stale reservations without issuing refunds, then refunds once with an audit trail', () => {
    const r=reserveUserCharge(1,8,'image');
    sqlite.prepare("UPDATE billing_reservations SET created_at=datetime('now','-25 hours') WHERE id=?").run(r.id);
    const list=listBillingReservations();expect(list.items.find(v=>v.id===r.id)?.state).toBe('review');expect(balance()).toBe(2);
    resolveBillingReservation(r.id,9,2,'上游确认已完成一张');expect(balance()).toBe(8);
    expect(resolveBillingReservation(r.id,9,2,'上游确认已完成一张').alreadyResolved).toBe(true);expect(balance()).toBe(8);
    expect(()=>resolveBillingReservation(r.id,9,0,'另一操作重复退款')).toThrow('已结算');
    expect(sqlite.prepare('SELECT admin_id,refunded FROM billing_resolution_audit WHERE reservation_id=?').get(r.id)).toEqual({admin_id:9,refunded:6});
  });
  it('refuses running tasks, overcharges, and unsupported refund sources', () => {
    const r=reserveUserCharge(1,5,'image');expect(()=>resolveBillingReservation(r.id,9,0,'任务尚未完成核对')).toThrow('仍在预扣');
    r.review();expect(()=>resolveBillingReservation(r.id,9,6,'上游成本超过预扣')).toThrow('不能超过');
    expect(()=>resolveBillingReservation(r.id,9,0,'短')).toThrow('至少六字');expect(balance()).toBe(5);
  });
  it('returns linked-token refunds to the original organization despite changed membership', () => {
    sqlite.exec('UPDATE users SET org_id=1 WHERE id=1; UPDATE api_tokens SET balance=-1,user_id=1 WHERE id=1');
    const r=reserveCharge(5,amount=>{const receipt=BalanceService.deductWithSource(1,amount,'api')!;TokenService.deductBalance(1,amount);return {target:'organization_balance',balanceDeduction:receipt};},()=>{}, {tokenId:1,userId:1,unlimitedToken:true});
    r.review();sqlite.exec('UPDATE users SET org_id=2 WHERE id=1');resolveBillingReservation(r.id,9,1,'上游确认仅消费一元');
    expect(BalanceService.getOrgBalance(1)).toBe(19);expect(BalanceService.getOrgBalance(2)).toBe(30);expect(token().used_amount).toBe(1);
  });
  it('rolls back a refund and leaves review pending when its token was deleted', () => {
    const r=reserveCharge(5,amount=>{const receipt=BalanceService.deductWithSource(1,amount,'api')!;TokenService.deductBalance(1,amount);return {target:'user_balance',balanceDeduction:receipt};},()=>{},{tokenId:1,userId:1,unlimitedToken:true});
    r.review();sqlite.exec('DELETE FROM api_tokens');expect(()=>resolveBillingReservation(r.id,9,0,'已核对上游没有消费')).toThrow('已删除');expect(balance()).toBe(5);expect(row(r.id).state).toBe('review');
  });
});

beforeEach(() => {
  sqlite.exec(`DROP TABLE IF EXISTS billing_reservations;
    DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS organizations; DROP TABLE IF EXISTS api_tokens;
    CREATE TABLE users (id INTEGER PRIMARY KEY, org_id INTEGER, balance REAL, updated_at TEXT);
    CREATE TABLE organizations (id INTEGER PRIMARY KEY, balance REAL, updated_at TEXT);
    CREATE TABLE api_tokens (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, token_key TEXT,
      allowed_models TEXT DEFAULT '[]', balance REAL, used_amount REAL DEFAULT 0, rate_limit INTEGER DEFAULT -1,
      status INTEGER DEFAULT 1, expires_at TEXT, last_used_at TEXT, created_at TEXT);
    INSERT INTO users(id,balance) VALUES(1,10);
    INSERT INTO organizations(id,balance) VALUES(1,20),(2,30);
    INSERT INTO api_tokens(id,name,token_key,balance) VALUES(1,'test','test-only',10);`);
});
const balance = () => BalanceService.getBalance(1);
const row = (id: string) => sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(id) as any;
const token = () => sqlite.prepare('SELECT * FROM api_tokens WHERE id=1').get() as any;
const tokenReservation = (amount: number) => reserveCharge(amount,
  amount => { TokenService.deductBalance(1, amount); return { tokenId: 1 }; },
  (amount, receipt) => TokenService.refundBalance(receipt.tokenId, amount));

describe('isolated precharge accounting', () => {
  it('deducts before work, then keeps only successful image charges', () => {
    const r = reserveUserCharge(1, 8, 'image');
    expect(balance()).toBe(2);
    r.settle(2); r.cancel(); r.settle(2);
    expect(balance()).toBe(8);
    expect(row(r.id)).toMatchObject({amount:8, actual:2, state:'settled'});
  });
  it('refunds failure exactly once', () => {
    const r=reserveUserCharge(1,7,'tts'); r.cancel(); r.cancel();
    expect(balance()).toBe(10); expect(row(r.id).state).toBe('refunded');
  });
  it('rejects an overlapping request without losing the first reservation', () => {
    const r=reserveUserCharge(1,7,'image');
    expect(() => reserveUserCharge(1,7,'image')).toThrow('余额不足');
    expect(balance()).toBe(3); r.cancel(); expect(balance()).toBe(10);
  });
  it('returns org funds to the original org after membership changes', () => {
    sqlite.exec('UPDATE users SET org_id=1 WHERE id=1');
    const r=reserveUserCharge(1,12,'image');
    sqlite.exec('UPDATE users SET org_id=2 WHERE id=1'); r.cancel();
    expect(BalanceService.getOrgBalance(1)).toBe(20);
    expect(BalanceService.getOrgBalance(2)).toBe(30); expect(balance()).toBe(10);
  });
  it('returns personal fallback funds to the user, not their org', () => {
    sqlite.exec('UPDATE users SET org_id=1 WHERE id=1; UPDATE organizations SET balance=1 WHERE id=1');
    const r=reserveUserCharge(1,8,'image'); r.cancel();
    expect(balance()).toBe(10); expect(BalanceService.getOrgBalance(1)).toBe(1);
  });
  it('allows a zero priced model without deducting', () => {
    const r=reserveUserCharge(1,0,'free');r.settle(0);expect(balance()).toBe(10);
  });
  it('does not turn an exceeded provider estimate into a free generation', () => {
    const r=reserveUserCharge(1,5,'chat');r.settle(6);r.cancel();
    expect(balance()).toBe(5);expect(row(r.id)).toMatchObject({state:'review',actual:6});
  });
  it('keeps missing usage pending reconciliation instead of fabricating actual usage', () => {
    const r=reserveUserCharge(1,5,'chat');r.review();r.cancel();
    expect(balance()).toBe(5);expect(row(r.id)).toMatchObject({state:'review',actual:null});
  });
  it('rejects invalid amounts before touching balances', () => {
    for (const amount of [-1,NaN,Infinity]) expect(() => reserveUserCharge(1,amount,'image')).toThrow();
    expect(balance()).toBe(10);
  });
  it('atomically rolls back the deduction if ledger persistence fails', () => {
    const circular:any={};circular.self=circular;
    expect(() => reserveCharge(4,cost => BalanceService.deductWithSource(1,cost,'test'),()=>{},circular)).toThrow();
    expect(balance()).toBe(10);
  });
  it('rolls back a failing refund and allows a retry', () => {
    let fail=true;
    const r=reserveCharge(6,cost=>BalanceService.deductWithSource(1,cost,'test')!,cost=>{
      BalanceService.refundToSource(1,cost,'user');if(fail)throw new Error('write failed');
    });
    expect(()=>r.cancel()).toThrow();expect(balance()).toBe(4);expect(row(r.id).state).toBe('reserved');
    fail=false;r.cancel();expect(balance()).toBe(10);
  });
  it('rejects API key overspending atomically instead of clamping balance to zero', () => {
    const r=tokenReservation(7);expect(()=>tokenReservation(7)).toThrow('Insufficient token balance');
    expect(token()).toMatchObject({balance:3,used_amount:7});r.cancel();
    expect(token()).toMatchObject({balance:10,used_amount:0});
  });
  it('settles API key partial results and usage counters exactly once', () => {
    const r=tokenReservation(8);r.settle(4);r.cancel();
    expect(token()).toMatchObject({balance:6,used_amount:4});
  });
  it('rolls back linked-user charges if the token update fails', () => {
    expect(()=>reserveCharge(4,cost=>{
      BalanceService.deductWithSource(1,cost,'api');TokenService.deductBalance(999,cost);return {};
    },()=>{})).toThrow();expect(balance()).toBe(10);
  });
  it('tracks unlimited API key usage without converting it to a finite balance', () => {
    sqlite.exec('UPDATE api_tokens SET balance=-1 WHERE id=1');
    const r=tokenReservation(8);r.settle(2);r.cancel();
    expect(token()).toMatchObject({balance:-1,used_amount:2});
  });
});
