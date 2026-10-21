import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const schema = await import('../server/db/schema.js');
  const sqlite = new Database(':memory:');
  return { sqlite, db: drizzle(sqlite, { schema }) };
});
import { sqlite } from '../server/db/index.js';
import { reserveLegacyVideo, finalizeLegacyVideo, failLegacyVideo, markLegacyVideoSubmitting } from '../server/services/legacyVideoBilling.js';

const balance = () => (sqlite.prepare('SELECT balance FROM users WHERE id=1').get() as any).balance;
const content = (id: number) => sqlite.prepare('SELECT * FROM contents WHERE id=?').get(id) as any;
const ledger = (id: string) => sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(id) as any;
function reserve() {
  return reserveLegacyVideo(1, 4, charge => Number(sqlite.prepare("INSERT INTO contents(user_id,status,cost,metadata) VALUES(1,'processing',4,?)").run(JSON.stringify({ billingReservationId: charge.id, billingStatus: 'reserved' })).lastInsertRowid));
}
beforeEach(() => {
  sqlite.exec(`DROP TABLE IF EXISTS billing_reservations; DROP TABLE IF EXISTS contents; DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS organizations;
    CREATE TABLE users(id INTEGER PRIMARY KEY,org_id INTEGER,balance REAL,updated_at TEXT,username TEXT DEFAULT 'test');
    CREATE TABLE organizations(id INTEGER PRIMARY KEY,balance REAL,updated_at TEXT,name TEXT DEFAULT 'test');
    CREATE TABLE contents(id INTEGER PRIMARY KEY,user_id INTEGER,status TEXT,cost REAL,metadata TEXT,result_url TEXT);
    INSERT INTO users(id,org_id,balance,updated_at) VALUES(1,NULL,10,NULL);
    INSERT INTO organizations(id,balance,updated_at) VALUES(1,20,NULL),(2,30,NULL);`);
});

describe('旧视频分支统一账本：仅使用内存数据库', () => {
  it('保留已有图片按完成比例结算的第五参数语义', () => {
    const r = reserve();
    finalizeLegacyVideo(r.contentId, 'completed', {}, '/partial.png', 0.5);
    expect(balance()).toBe(8);
    expect(ledger(r.charge.id)).toMatchObject({ state: 'settled', actual: 2 });
  });
  it('补扣与任务写入在一个事务中，写入失败不会先扣掉差额', () => {
    const r = reserve();
    sqlite.exec("CREATE TRIGGER supplement_crash BEFORE UPDATE ON contents BEGIN SELECT RAISE(ABORT,'模拟结算中断'); END;");
    expect(() => finalizeLegacyVideo(r.contentId, 'completed', {}, '/actual.mp4', 1, 5)).toThrow('模拟结算中断');
    expect(balance()).toBe(6); expect(ledger(r.charge.id).state).toBe('reserved');
    sqlite.exec('DROP TRIGGER supplement_crash');
    finalizeLegacyVideo(r.contentId, 'completed', {}, '/actual.mp4', 1, 5);
    finalizeLegacyVideo(r.contentId, 'completed', {}, '/actual.mp4', 1, 5);
    expect(balance()).toBe(5); expect(ledger(r.charge.id)).toMatchObject({ state: 'settled', actual: 5 });
  });
  it('预扣、内容记录、账本关联原子提交，保存异常则全部回滚', () => {
    expect(() => reserveLegacyVideo(1, 4, charge => {
      sqlite.prepare("INSERT INTO contents(status,metadata) VALUES('processing',?)").run(JSON.stringify({ billingReservationId: charge.id }));
      throw new Error('模拟保存中断');
    })).toThrow('保存中断');
    expect(balance()).toBe(10);
    expect(sqlite.prepare('SELECT * FROM billing_reservations').all()).toHaveLength(0);
    expect(sqlite.prepare('SELECT * FROM contents').all()).toHaveLength(0);
    const r = reserve(); expect(balance()).toBe(6);
    expect(JSON.parse(ledger(r.charge.id).context).contentId).toBe(r.contentId);
  });
  it('重启后通过持久化 ID 结算成功，不重复扣费或因迟到失败退款', () => {
    const r = reserve(); markLegacyVideoSubmitting(r.contentId);
    finalizeLegacyVideo(r.contentId, 'completed', { progress: 100 }, '/video.mp4');
    finalizeLegacyVideo(r.contentId, 'completed'); failLegacyVideo(r.contentId, '迟到失败', true);
    expect(balance()).toBe(6); expect(ledger(r.charge.id)).toMatchObject({ state: 'settled', actual: 4 });
    expect(content(r.contentId)).toMatchObject({ status: 'completed', result_url: '/video.mp4', cost: 4 });
  });
  it('在退款和内容更新之间异常时整体回滚，重试只能退款一次', () => {
    const r = reserve();
    sqlite.exec("CREATE TRIGGER simulate_crash BEFORE UPDATE ON contents BEGIN SELECT RAISE(ABORT,'模拟更新中断'); END;");
    expect(() => failLegacyVideo(r.contentId, '确认失败', true)).toThrow('模拟更新中断');
    expect(balance()).toBe(6); expect(ledger(r.charge.id).state).toBe('reserved');
    sqlite.exec('DROP TRIGGER simulate_crash');
    failLegacyVideo(r.contentId, '确认失败', true); failLegacyVideo(r.contentId, '重复回调', true);
    expect(balance()).toBe(10); expect(content(r.contentId)).toMatchObject({ status: 'failed', cost: 0 });
    expect(ledger(r.charge.id)).toMatchObject({ state: 'refunded', actual: 0 });
  });
  it('提交超时或进程中断保留待核实，禁止重复提交；确认失败后才退款', () => {
    const r = reserve(); expect(markLegacyVideoSubmitting(r.contentId)).toBe(true);
    failLegacyVideo(r.contentId, '网络超时');
    expect(balance()).toBe(6); expect(ledger(r.charge.id).state).toBe('review');
    expect(markLegacyVideoSubmitting(r.contentId)).toBe(false);
    failLegacyVideo(r.contentId, '上游确认失败', true);
    expect(balance()).toBe(10); expect(ledger(r.charge.id).state).toBe('refunded');
  });
  it('待核实任务恢复成功只消费原预扣；未提交任务失败可以直接退回', () => {
    const r = reserve(); markLegacyVideoSubmitting(r.contentId); failLegacyVideo(r.contentId, '连接中断');
    finalizeLegacyVideo(r.contentId, 'completed', {}, '/original.mp4');
    expect(balance()).toBe(6); expect(content(r.contentId).status).toBe('completed');
    const second = reserve(); failLegacyVideo(second.contentId, '本地准备失败');
    expect(balance()).toBe(6); expect(ledger(second.charge.id).state).toBe('refunded');
  });
  it('按上游明确返回的实际费用多退少补', () => {
    const refund = reserve();
    finalizeLegacyVideo(refund.contentId, 'completed', { upstreamBillingUsage: { billableSeconds: 3 } }, '/a.mp4', 1, 3);
    expect(balance()).toBe(7);
    expect(ledger(refund.charge.id)).toMatchObject({ state: 'settled', actual: 3 });
    expect(content(refund.contentId)).toMatchObject({ status: 'completed', cost: 3 });

    const supplement = reserve();
    finalizeLegacyVideo(supplement.contentId, 'completed', { upstreamBillingUsage: { billableSeconds: 5 } }, '/b.mp4', 1, 5);
    expect(balance()).toBe(2);
    expect(ledger(supplement.charge.id)).toMatchObject({ state: 'settled', actual: 5 });
    expect(JSON.parse(content(supplement.contentId).metadata)).toMatchObject({ billingSupplementAmount: 1 });
  });
  it('实际费用超预扣且余额不足时保留结果并进入待核实', () => {
    const r = reserve();
    finalizeLegacyVideo(r.contentId, 'completed', {}, '/held.mp4', 1, 11);
    expect(balance()).toBe(6);
    expect(ledger(r.charge.id)).toMatchObject({ state: 'review', actual: 11 });
    expect(content(r.contentId)).toMatchObject({ status: 'review', result_url: '/held.mp4' });
  });
  it('退款始终退回原组织，不受用户随后切换组织影响', () => {
    sqlite.prepare('UPDATE users SET org_id=1').run(); const r = reserve();
    sqlite.prepare('UPDATE users SET org_id=2').run(); failLegacyVideo(r.contentId, '确认失败', true);
    expect((sqlite.prepare('SELECT balance FROM organizations WHERE id=1').get() as any).balance).toBe(20);
    expect((sqlite.prepare('SELECT balance FROM organizations WHERE id=2').get() as any).balance).toBe(30); expect(balance()).toBe(10);
  });
});
