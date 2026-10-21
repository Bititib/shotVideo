import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { getTableConfig, SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core');
  const schema = await import('../server/db/schema');
  const sqlite = new Database(':memory:'), dialect = new SQLiteSyncDialect();
  for (const table of Object.values(schema)) {
    const config = getTableConfig(table as any);
    const columns = config.columns.map(c => {
      const value = typeof c.default === 'object' ? dialect.sqlToQuery(c.default as any).sql
        : typeof c.default === 'string' ? "'" + c.default.replace(/'/g,"''") + "'" : String(c.default);
      return '"' + c.name + '" ' + c.getSQLType() + (c.primary ? ' PRIMARY KEY' : '')
        + (c.default === undefined ? '' : ' DEFAULT ' + value);
    });
    sqlite.exec('CREATE TABLE "' + config.name + '" (' + columns.join(',') + ')');
  }
  return { sqlite, db: drizzle(sqlite, { schema }) };
});
import { sqlite } from '../server/db/index';
import { ensureFundLedger, captureFundEntries, linkFundEntries } from '../server/db/fundLedger';
import { reserveCharge, reserveUserCharge, linkReservationContent } from '../server/services/billingReservation';
import { BalanceService } from '../server/services/balanceService';
import { TokenService } from '../server/services/tokenService';
import { ContentService } from '../server/services/contentService';
import { reserveLegacyVideo } from '../server/services/legacyVideoBilling';
import { VideoBatchStore } from '../server/services/videoBatchStore';
import { listFundLedger } from '../server/services/fundLedgerQuery';

beforeEach(() => {
  ensureFundLedger(sqlite);
  sqlite.exec(`DELETE FROM contents;DELETE FROM api_tokens;DELETE FROM users;DELETE FROM organizations;DELETE FROM model_pricing;
    DROP TABLE IF EXISTS billing_reservations;
    DROP TABLE IF EXISTS video_submission_receipts;
    INSERT INTO users(id,username,email,balance) VALUES(1,'用户1','one@test',100),(2,'用户2','two@test',100);
    INSERT INTO api_tokens(id,user_id,name,token_key,balance) VALUES(3,1,'无限Token','secret-not-for-ledger',-1);
    INSERT INTO model_pricing(model_pattern,billing_type,input_price) VALUES('test-video','per_call',3.9);
    DELETE FROM fund_ledger;DELETE FROM fund_ledger_content_links;`);
});
const saved = (reservationId?: string, userId = 1) => ContentService.save({ userId, type: 'image', modelId: 'test-video', status: 'processing', cost: 3.9,
  metadata: { billingReservationId: reservationId, videoId: 'task_example', request_id: 'trace-not-task', apiKey: 'secret-not-for-ledger', reference_images: ['data:image/png;base64,not-public'] } });
const balance = () => (sqlite.prepare('SELECT balance FROM users WHERE id=1').get() as any).balance;

it('links a wallet and unlimited Token charge/refund even when content is created after settlement', () => {
  const charge = reserveCharge(3.9, amount => {
    const receipt = BalanceService.deductWithSource(1, amount, 'api_call');
    TokenService.deductBalance(3, amount); return receipt;
  }, amount => { BalanceService.refundToSource(1, amount, 'user'); TokenService.refundBalance(3, amount); }, { userId: 1, tokenId: 3 });
  charge.cancel();
  const id = saved(charge.id);
  const rows = sqlite.prepare('SELECT * FROM fund_ledger ORDER BY id').all() as any[];
  expect(rows).toHaveLength(4); expect(rows.every(r => r.content_id === id)).toBe(true);
  expect(balance()).toBe(100);
  expect(sqlite.prepare('SELECT used_amount FROM api_tokens WHERE id=3').get()).toEqual({used_amount:0});
  const result = listFundLedger(sqlite, { scope:'wallet',contentId:String(id),userId:'1' });
  expect(result.total).toBe(2);
  expect(result.items.every(r => r.tasks?.[0].id === id)).toBe(true);
  expect(result.items[0].tasks?.[0].upstreamIds).toEqual(['task_example']);
  const text = JSON.stringify(result);
  expect(text).not.toContain('secret-not-for-ledger'); expect(text).not.toContain('trace-not-task'); expect(text).not.toContain('base64');
  expect(sqlite.prepare('SELECT input_price FROM model_pricing').get()).toEqual({input_price:3.9});
});
it('links website precharges exactly and does not match earlier equal-amount charges by timestamp', () => {
  BalanceService.deductWithSource(1,3.9,'old-unlinked');
  const oldId = (sqlite.prepare('SELECT MAX(id) AS id FROM fund_ledger').get() as any).id;
  const result = reserveLegacyVideo(1,3.9, charge => saved(charge.id));
  expect((sqlite.prepare('SELECT content_id FROM fund_ledger WHERE id=?').get(oldId) as any).content_id).toBeNull();
  expect(listFundLedger(sqlite,{scope:'wallet',contentId:String(result.contentId)}).total).toBe(1);
  const before = balance(); linkReservationContent(result.charge.id,result.contentId); linkReservationContent(result.charge.id,result.contentId);
  expect(balance()).toBe(before); expect(listFundLedger(sqlite,{contentId:String(result.contentId)}).total).toBe(1);
});
it('does not fabricate old links and rejects cross-owner or conflicting associations', () => {
  const charge = reserveUserCharge(1,3.9,'test');
  const context = JSON.parse((sqlite.prepare('SELECT context FROM billing_reservations WHERE id=?').get(charge.id) as any).context);
  delete context.fundLedgerEntryIds;
  sqlite.prepare('UPDATE billing_reservations SET context=? WHERE id=?').run(JSON.stringify(context),charge.id);
  const id = saved(charge.id);
  expect(listFundLedger(sqlite,{contentId:String(id)}).total).toBe(0);
  const other = reserveUserCharge(1,3.9,'test');
  const count = (sqlite.prepare('SELECT COUNT(*) AS n FROM contents').get() as any).n;
  const amount = balance();
  expect(() => saved(other.id,2)).toThrow('归属不一致');
  expect(balance()).toBe(amount); expect((sqlite.prepare('SELECT COUNT(*) AS n FROM contents').get() as any).n).toBe(count);
  const linked = saved(other.id);
  const entry = (sqlite.prepare('SELECT id FROM fund_ledger WHERE content_id=?').get(linked) as any).id;
  expect(() => linkFundEntries(sqlite,[entry],id)).toThrow('其他任务');
});
it('rolls back content association with an enclosing failed charge/save transaction', () => {
  expect(() => sqlite.transaction(() => {
    const charge = reserveUserCharge(1,3.9,'test'); saved(charge.id); throw Error('interrupted');
  })()).toThrow('interrupted');
  expect(balance()).toBe(100);
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM contents').get()).toEqual({n:0});
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM fund_ledger').get()).toEqual({n:0});
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM fund_ledger_content_links').get()).toEqual({n:0});
});
it('links a new refund through a unique old reservation pointer without inventing its historical debit link', () => {
  const charge = reserveUserCharge(1,3.9,'test');
  const id = saved(charge.id);
  sqlite.prepare("UPDATE fund_ledger SET content_id=NULL").run();
  sqlite.exec('DELETE FROM fund_ledger_content_links');
  sqlite.prepare("UPDATE billing_reservations SET context=json_remove(context,'$.contentId','$.fundLedgerEntryIds') WHERE id=?").run(charge.id);
  charge.cancel();
  const debit = sqlite.prepare("SELECT content_id FROM fund_ledger WHERE kind='charge'").get() as any;
  const refund = sqlite.prepare("SELECT content_id FROM fund_ledger WHERE kind='refund'").get() as any;
  expect(debit.content_id).toBeNull(); expect(refund.content_id).toBe(id); expect(balance()).toBe(100);
});
it('filters an explicitly linked organization payment by its content owner without changing wallet source', () => {
  sqlite.exec("INSERT INTO organizations(id,name,balance) VALUES(5,'组织',100);UPDATE users SET org_id=5 WHERE id=1;");
  const r = reserveLegacyVideo(1,3.9, charge => saved(charge.id));
  const rows = listFundLedger(sqlite,{scope:'wallet',userId:'1',contentId:String(r.contentId)}).items;
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({account_type:'org',account_id:5,user_id:1});
  expect(listFundLedger(sqlite,{scope:'wallet',userId:'2',contentId:String(r.contentId)}).total).toBe(0);
  expect(balance()).toBe(100);
});
it('uses the durable task receipt when metadata is missing and does not change audit history while querying', () => {
  const r = reserveLegacyVideo(1,3.9, charge => saved(charge.id));
  sqlite.prepare("UPDATE contents SET metadata='invalid-json' WHERE id=?").run(r.contentId);
  sqlite.exec('CREATE TABLE video_submission_receipts(content_id INTEGER PRIMARY KEY,upstream_task_id TEXT)');
  sqlite.prepare('INSERT INTO video_submission_receipts VALUES(?,?)').run(r.contentId,'task_0x_saved');
  const before = sqlite.prepare('SELECT * FROM fund_ledger ORDER BY id').all();
  const rows = listFundLedger(sqlite,{scope:'wallet',contentId:String(r.contentId)}).items;
  expect(rows[0].tasks?.[0].upstreamIds).toEqual(['task_0x_saved']);
  expect(sqlite.prepare('SELECT * FROM fund_ledger ORDER BY id').all()).toEqual(before);
  for (const q of [{scope:'invalid'}, {scope:['wallet']}, {contentId:'0'}, {contentId:['1']}, {contentId:'1 OR 1=1'}]) {
    expect(()=>listFundLedger(sqlite,q)).toThrow('参数无效');
  }
});
it('shows one batch precharge linked to multiple tasks without duplicating its amount or page count', () => {
  const store = new VideoBatchStore(sqlite, {
    deduct: (user, amount) => { const c = captureFundEntries(sqlite, () => BalanceService.deductWithSource(user,amount,'video_batch_prededuct')); return c.value ? {...c.value,fundLedgerEntryIds:c.entryIds} : null; },
    refund: (user, amount, receipt, contentId) => { BalanceService.refundToSource(user,amount,receipt.source,receipt.orgId,'video_batch_refund',{contentId}); },
  });
  const batch = store.create(1,'batch-key',{name:'批次',model:'test-video',resolution:'720p',aspect_ratio:'16:9',video_length:5,autoRetry:false,maxRetries:0,creatives:[{prompt:'test',count:2,reference_images:[]}]},3.9,'https://example.com');
  const ids: number[] = [];
  for (const item of store.detail(batch,1).items) {
    const claimed = store.claim(item.id); ids.push(store.attach(item.id,claimed.attempts,1,()=>saved()));
  }
  const result = listFundLedger(sqlite,{scope:'wallet',userId:'1'});
  expect(result.total).toBe(1); expect(result.items[0].tasks?.map(t => t.id)).toEqual(ids);
  expect(result.items[0].delta).toBeCloseTo(-7.8); expect(balance()).toBeCloseTo(92.2);
  expect(listFundLedger(sqlite,{scope:'wallet',contentId:String(ids[1])}).total).toBe(1);
  store.fail(store.detail(batch,1).items[0].id,'明确失败',true);
  expect(listFundLedger(sqlite,{scope:'wallet',kind:'refund',contentId:String(ids[0])}).total).toBe(1);
});
