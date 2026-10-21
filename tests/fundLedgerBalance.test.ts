import {beforeEach,it,expect,vi} from 'vitest';
vi.mock('../server/db/index.js',async()=>{const {default:Database}=await import('better-sqlite3');const {drizzle}=await import('drizzle-orm/better-sqlite3');const schema=await import('../server/db/schema');const {getTableConfig,SQLiteSyncDialect}=await import('drizzle-orm/sqlite-core');const sqlite=new Database(':memory:');const dialect=new SQLiteSyncDialect();for(const table of [schema.users,schema.organizations,schema.apiTokens]){const cfg=getTableConfig(table);const cols=cfg.columns.map(c=>{let def='';if(c.default!==undefined){const value=typeof c.default==='object'?dialect.sqlToQuery(c.default as any).sql:typeof c.default==='string'?"'"+c.default.replace(/'/g,"''")+"'":String(c.default);def=' DEFAULT '+value;}return '"'+c.name+'" '+c.getSQLType()+(c.primary?' PRIMARY KEY':'')+def;});sqlite.exec('CREATE TABLE '+cfg.name+' ('+cols.join(',')+')');}return {sqlite,db:drizzle(sqlite,{schema})};});
import {sqlite} from '../server/db/index';import {BalanceService} from '../server/services/balanceService';import {TokenService} from '../server/services/tokenService';import {ensureFundLedger} from '../server/db/fundLedger';
beforeEach(()=>{ensureFundLedger(sqlite);sqlite.exec("DELETE FROM users;DELETE FROM organizations;DELETE FROM api_tokens;INSERT INTO users(id,username,balance) VALUES(1,'测试用户',100);INSERT INTO organizations(id,name,balance) VALUES(2,'组织',100);INSERT INTO api_tokens(id,user_id,name,token_key,balance) VALUES(3,1,'Token','secret-never-in-ledger',50);DELETE FROM fund_ledger;");});
const rows=()=>sqlite.prepare("SELECT * FROM fund_ledger WHERE account_type!='token_usage' ORDER BY id").all() as any[];
it('records real recharge, debit, refund and no ledger debit on insufficient balance',()=>{BalanceService.recharge(1,10);BalanceService.deductWithSource(1,2,'generate_video',{contentId:42});BalanceService.refundToSource(1,2,'user',undefined,'refund',{contentId:42});expect(BalanceService.deductWithSource(1,999,'generate_video')).toBeNull();expect(rows().map(r=>[r.kind,r.delta])).toEqual([['recharge',10],['charge',-2],['refund',2]]);expect(rows()[1].content_id).toBe(42);expect(BalanceService.getBalance(1)).toBe(110);});
it('records the actual organizational source once',()=>{sqlite.exec('UPDATE users SET org_id=2 WHERE id=1');BalanceService.deductWithSource(1,3,'generate_video');expect(rows()).toHaveLength(1);expect(rows()[0]).toMatchObject({account_type:'org',account_id:2,delta:-3});expect(BalanceService.getBalance(1)).toBe(100);});
it('records finite token quota independently and keeps API keys out',()=>{TokenService.deductBalance(3,2);TokenService.refundBalance(3,2);expect(rows().map(r=>[r.kind,r.delta])).toEqual([['charge',-2],['refund',2]]);expect(JSON.stringify(rows())).not.toContain('secret-never-in-ledger');});
it('records real unlimited Token charges and refunds without touching money or quota mode',()=>{
  sqlite.exec('UPDATE api_tokens SET balance=-1,used_amount=12 WHERE id=3;DELETE FROM fund_ledger;');
  TokenService.deductBalance(3,3.9);TokenService.refundBalance(3,3.9);
  const usage=sqlite.prepare("SELECT * FROM fund_ledger WHERE account_type='token_usage' ORDER BY id").all() as any[];
  expect(usage).toHaveLength(2);
  expect(usage[0]).toMatchObject({user_id:1,kind:'charge',operation:'token_charge',balance_before:12});
  expect(usage[0].delta).toBeCloseTo(3.9);expect(usage[0].balance_after).toBeCloseTo(15.9);
  expect(usage[1]).toMatchObject({kind:'refund',operation:'token_refund'});
  expect(usage[1].delta).toBeCloseTo(-3.9);expect(usage[1].balance_after).toBeCloseTo(12);
  expect(sqlite.prepare('SELECT balance,used_amount FROM api_tokens WHERE id=3').get()).toEqual({balance:-1,used_amount:12});
  expect(BalanceService.getBalance(1)).toBe(100);expect(rows()).toHaveLength(0);
  expect(JSON.stringify(usage)).not.toContain('secret-never-in-ledger');
});
it('records only the actual clamped usage refund and none for failed or zero charges',()=>{
  sqlite.exec('UPDATE api_tokens SET balance=-1,used_amount=2 WHERE id=3;DELETE FROM fund_ledger;');
  TokenService.refundBalance(3,8);TokenService.refundBalance(3,8);TokenService.deductBalance(3,0);
  const usage=sqlite.prepare("SELECT delta FROM fund_ledger WHERE account_type='token_usage'").all();
  expect(usage).toEqual([{delta:-2}]);
  sqlite.exec('UPDATE api_tokens SET balance=0 WHERE id=3;DELETE FROM fund_ledger;');
  expect(()=>TokenService.deductBalance(3,1)).toThrow('Insufficient');
  expect(sqlite.prepare('SELECT COUNT(*) n FROM fund_ledger').get()).toEqual({n:0});
});
it('an audit insert failure rolls back both the wallet charge and Token counter',()=>{
  sqlite.exec("UPDATE api_tokens SET balance=-1 WHERE id=3;DELETE FROM fund_ledger;CREATE TRIGGER audit_failure BEFORE INSERT ON fund_ledger WHEN NEW.account_type='token_usage' BEGIN SELECT RAISE(ABORT,'audit failure');END;");
  expect(()=>sqlite.transaction(()=>{
    BalanceService.deductWithSource(1,3.9,'api_call');TokenService.deductBalance(3,3.9);
  })()).toThrow('audit failure');
  expect(BalanceService.getBalance(1)).toBe(100);
  expect(sqlite.prepare('SELECT used_amount FROM api_tokens WHERE id=3').get()).toEqual({used_amount:0});
  expect(sqlite.prepare('SELECT COUNT(*) n FROM fund_ledger').get()).toEqual({n:0});
  sqlite.exec('DROP TRIGGER audit_failure');
});
