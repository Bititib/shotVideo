import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const schema = await import('../server/db/schema.js');
  const sqlite = new Database(':memory:');
  return { sqlite, db: drizzle(sqlite, { schema }) };
});

import { sqlite } from '../server/db/index.js';
import { settleDirectVideoBilling, refundUnreservedVideo } from '../server/services/directVideoBillingService.js';

beforeEach(() => {
  sqlite.exec(`DROP TABLE IF EXISTS contents; DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS organizations; DROP TABLE IF EXISTS api_tokens;
    CREATE TABLE users(id INTEGER PRIMARY KEY,org_id INTEGER,balance REAL,updated_at TEXT,username TEXT DEFAULT 'test');
    CREATE TABLE organizations(id INTEGER PRIMARY KEY,balance REAL,updated_at TEXT,name TEXT DEFAULT 'test');
    CREATE TABLE api_tokens(id INTEGER PRIMARY KEY,user_id INTEGER,name TEXT,token_key TEXT,allowed_models TEXT DEFAULT '[]',balance REAL,used_amount REAL DEFAULT 0,rate_limit INTEGER DEFAULT -1,status INTEGER DEFAULT 1,expires_at TEXT,last_used_at TEXT,created_at TEXT);
    CREATE TABLE contents(id INTEGER PRIMARY KEY,user_id INTEGER,status TEXT,cost REAL,metadata TEXT,result_url TEXT);
    INSERT INTO users(id,org_id,balance,updated_at) VALUES(1,NULL,10,NULL);
    INSERT INTO api_tokens(id,user_id,name,token_key,balance,used_amount) VALUES(1,1,'test','test',10,4);
  `);
});

const token = () => sqlite.prepare('SELECT balance,used_amount FROM api_tokens WHERE id=1').get() as any;
const content = () => sqlite.prepare('SELECT * FROM contents WHERE id=1').get() as any;

describe('API 视频按上游实际用量结算', () => {
  it('重复完成和迟到失败均不再次扣款或退款', () => {
    sqlite.prepare("INSERT INTO contents VALUES(1,1,'processing',4,?,NULL)")
      .run(JSON.stringify({ source: 'api', tokenId: 1, billingSource: 'token' }));
    settleDirectVideoBilling(1, 6, {}, '/video.mp4');
    expect(token()).toMatchObject({ balance: 8, used_amount: 6 });
    settleDirectVideoBilling(1, 7, {}, '/late.mp4'); refundUnreservedVideo(1, '迟到失败');
    expect(token()).toMatchObject({ balance: 8, used_amount: 6 });
    expect(content()).toMatchObject({ status: 'completed', cost: 6, result_url: '/video.mp4' });
  });
  it('确认失败退款只执行一次，退款后迟到的完成不会自动扣款', () => {
    sqlite.prepare("INSERT INTO contents VALUES(1,1,'processing',4,?,NULL)")
      .run(JSON.stringify({ source: 'api', tokenId: 1, billingSource: 'token' }));
    refundUnreservedVideo(1, '确认失败'); refundUnreservedVideo(1, '重复回调');
    settleDirectVideoBilling(1, 4, {}, '/late.mp4');
    expect(token()).toMatchObject({ balance: 14, used_amount: 0 });
    expect(content()).toMatchObject({ status: 'failed', cost: 0, result_url: null });
  });
  it('退款后写入任务失败时余额和退款整体回滚，重试只退一次', () => {
    sqlite.prepare("INSERT INTO contents VALUES(1,1,'processing',4,?,NULL)")
      .run(JSON.stringify({ source: 'api', tokenId: 1, billingSource: 'token' }));
    sqlite.exec("CREATE TRIGGER fail_refund BEFORE UPDATE ON contents BEGIN SELECT RAISE(ABORT,'simulated crash'); END");
    expect(() => refundUnreservedVideo(1, '确认失败')).toThrow('simulated crash');
    expect(token()).toMatchObject({ balance: 10, used_amount: 4 }); expect(content().status).toBe('processing');
    sqlite.exec('DROP TRIGGER fail_refund');
    refundUnreservedVideo(1, '确认失败'); refundUnreservedVideo(1, '确认失败');
    expect(token()).toMatchObject({ balance: 14, used_amount: 0 });
  });
  it('实际费用较低时退回 Token 差额', () => {
    sqlite.prepare("INSERT INTO contents VALUES(1,1,'processing',4,?,NULL)")
      .run(JSON.stringify({ source: 'api', tokenId: 1, billingSource: 'token' }));
    expect(settleDirectVideoBilling(1, 3, { upstreamBillingUsage: { billableSeconds: 3 } }, '/video.mp4'))
      .toMatchObject({ settled: true, review: false, actualCost: 3 });
    expect(token()).toMatchObject({ balance: 11, used_amount: 3 });
    expect(content()).toMatchObject({ status: 'completed', cost: 3, result_url: '/video.mp4' });
  });

  it('实际费用较高且 Token 余额不足时保留结果进入待核实', () => {
    sqlite.prepare('UPDATE api_tokens SET balance=0 WHERE id=1').run();
    sqlite.prepare("INSERT INTO contents VALUES(1,1,'processing',4,?,NULL)")
      .run(JSON.stringify({ source: 'api', tokenId: 1, billingSource: 'token' }));
    expect(settleDirectVideoBilling(1, 6, {}, '/held.mp4')).toMatchObject({ settled: true, review: true });
    expect(content()).toMatchObject({ status: 'review', cost: 4, result_url: '/held.mp4' });
    expect(JSON.parse(content().metadata)).toMatchObject({ billingShortfall: 2, requiresReview: true });
  });
});
