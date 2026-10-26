import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
const poller = vi.hoisted(() => ({ resume: vi.fn().mockResolvedValue(undefined), fail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../server/routes/video.js', () => ({ resumePollForTask: poller.resume, failHmQueuedVideo: poller.fail }));
vi.mock('../server/services/mediaPreviewService.js', () => ({ createMediaPreview: vi.fn().mockResolvedValue(null) }));
vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { getTableConfig, SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core');
  const schema = await import('../server/db/schema');
  const sqlite = new Database(':memory:');
  const dialect = new SQLiteSyncDialect();
  for (const table of Object.values(schema)) {
    const config = getTableConfig(table as any);
    const columns = config.columns.map(c => {
      let def = '';
      if (c.default !== undefined) {
        const value = typeof c.default === 'object' ? dialect.sqlToQuery(c.default as any).sql
          : typeof c.default === 'string' ? "'" + c.default.replace(/'/g, "''") + "'" : String(c.default);
        def = ' DEFAULT ' + value;
      }
      return '"' + c.name + '" ' + c.getSQLType() + (c.primary ? ' PRIMARY KEY' : '') + def;
    });
    sqlite.exec('CREATE TABLE "' + config.name + '" (' + columns.join(',') + ')');
  }
  return { sqlite, db: drizzle(sqlite, { schema }) };
});

import fs from 'fs';
import path from 'path';
import { db, sqlite } from '../server/db/index.js';
import { contents, users } from '../server/db/schema.js';
import { eq } from 'drizzle-orm';
import { BalanceService } from '../server/services/balanceService.js';
import { ensureBillingReservations, reserveUserCharge } from '../server/services/billingReservation.js';
import { finalizeReservedContent } from '../server/services/contentBillingService.js';
import { VideoRecoveryService } from '../server/services/videoRecoveryService.js';
import { resumePollForTask } from '../server/routes/video.js';

let validVideo: Buffer;
beforeAll(async () => {
  expect((await import('../server/routes/video.js')).resumePollForTask).toBe(poller.resume);
  validVideo = execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','color=s=16x16:r=10:d=0.2','-c:v','libx264','-pix_fmt','yuv420p','-f','mp4','-movflags','frag_keyframe+empty_moov','pipe:1']);
});
afterAll(() => sqlite.close());
const TEST_EMAIL = 'video-recovery@test.local';
const TEST_CHANNEL_NAME = 'video-recovery-haidiyue';
let userId = 0;
let channelId = 0;
let contentId = 0;
const localizedVideoPath = path.join(process.cwd(), 'data', 'uploads', 'videos', 'video_sd2_5-haidiyue-face_upstream-task-1.mp4');

beforeEach(() => {
  vi.clearAllMocks();
  if (sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='fund_ledger'").get()) sqlite.exec('DELETE FROM fund_ledger');
  expect(resumePollForTask).toBe(poller.resume);
  sqlite.prepare('DELETE FROM contents WHERE title = ?').run('video-recovery-test');
  sqlite.prepare('DELETE FROM channels WHERE name = ?').run(TEST_CHANNEL_NAME);
  sqlite.prepare('DELETE FROM users WHERE email = ?').run(TEST_EMAIL);
  if (fs.existsSync(localizedVideoPath)) fs.unlinkSync(localizedVideoPath);
  const genericPath = path.join(process.cwd(), 'data/uploads/videos/video_generic-video-model_upstream-task-1.mp4');
  if (fs.existsSync(genericPath)) fs.unlinkSync(genericPath);

  userId = Number(sqlite.prepare(`
    INSERT INTO users (email, username, password_hash, role, tier_id, balance)
    VALUES (?, 'recovery-user', 'test', 'user', 1, 10)
  `).run(TEST_EMAIL).lastInsertRowid);
  channelId = Number(sqlite.prepare(`
    INSERT INTO channels (name, type, base_url, api_key, supported_models, model_mapping, status)
    VALUES (?, 'wx-haidiyue', 'https://recovery-upstream.test/v1', 'test-key', '["sd2.5-haidiyue-face"]', '{"sd2.5-haidiyue-face":"sd2.5"}', 1)
  `).run(TEST_CHANNEL_NAME).lastInsertRowid);
  contentId = Number(sqlite.prepare(`
    INSERT INTO contents (user_id, type, title, model_id, cost, status, metadata)
    VALUES (?, 'video', 'video-recovery-test', 'sd2.5-haidiyue-face', 0, 'failed', ?)
  `).run(userId, JSON.stringify({
    videoId: 'upstream-task-1',
    channelId,
    actualChannel: 'wx-haidiyue',
    resolution: '720p',
    seconds: 30,
    queueRefunded: true,
    billingStatus: 'refunded',
    refundAmount: 2,
    refundTarget: 'user_balance',
    error: 'temporary 502',
  })).lastInsertRowid);

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('upstream-task-1')) {
      return new Response(JSON.stringify({
        status: 'completed',
        video_url: 'https://recovery-upstream.test/media/recovered.mp4',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(validVideo, {
      status: 200,
      headers: { 'Content-Type': 'video/mp4' },
    });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  sqlite.prepare('DELETE FROM contents WHERE title = ?').run('video-recovery-test');
  sqlite.prepare('DELETE FROM channels WHERE name = ?').run(TEST_CHANNEL_NAME);
  sqlite.prepare('DELETE FROM users WHERE email = ?').run(TEST_EMAIL);
  if (fs.existsSync(localizedVideoPath)) fs.unlinkSync(localizedVideoPath);
  const genericPath = path.join(process.cwd(), 'data/uploads/videos/video_generic-video-model_upstream-task-1.mp4');
  if (fs.existsSync(genericPath)) fs.unlinkSync(genericPath);
});

describe('VideoRecoveryService', () => {
  it('rejects display placeholders instead of saving them as an accepted task ID', () => {
    const before = db.select().from(contents).where(eq(contents.id, contentId)).get();
    expect(() => VideoRecoveryService.supplementTaskId(contentId, 99, '未取得上游任务 ID')).toThrow('有效的上游任务 ID');
    expect(db.select().from(contents).where(eq(contents.id, contentId)).get()).toEqual(before);
  });
  it('does not query a historical placeholder or change funds while inspecting it', async () => {
    sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?').run(JSON.stringify({ channelId, videoId: '未取得上游任务 ID' }), contentId);
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const before = sqlite.prepare('SELECT balance FROM users WHERE id=?').get(userId);
    await expect(VideoRecoveryService.inspect(contentId)).rejects.toMatchObject({ status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT balance FROM users WHERE id=?').get(userId)).toEqual(before);
  });
  it('supplements a missing upstream task ID with an administrator audit record', () => {
    sqlite.prepare("UPDATE contents SET metadata = '{}' WHERE id = ?").run(contentId);

    expect(VideoRecoveryService.supplementTaskId(contentId, 99, ' recovered-task ')).toMatchObject({
      taskId: 'recovered-task',
    });

    const record = db.select().from(contents).where(eq(contents.id, contentId)).get();
    const metadata = JSON.parse(record!.metadata);
    expect(metadata).toMatchObject({
      videoId: 'recovered-task',
      upstreamTaskId: 'recovered-task',
      recoveryTaskIdSupplemented: true,
      recoverySupplementedBy: 99,
    });
    expect(metadata.recoveryAudit).toContainEqual(expect.objectContaining({
      action: 'supplement_task_id',
      actorId: 99,
      taskId: 'recovered-task',
    }));
  });

  it('rejects invalid task IDs and non-failed records', () => {
    expect(() => VideoRecoveryService.supplementTaskId(contentId, 99, '')).toThrow();
    sqlite.prepare("UPDATE contents SET status = 'completed' WHERE id = ?").run(contentId);
    expect(() => VideoRecoveryService.supplementTaskId(contentId, 99, 'task-id')).toThrow();
  });

  const read = () => db.select().from(contents).where(eq(contents.id, contentId)).get()!;
  function pending() {
    sqlite.prepare("UPDATE channels SET type='openai' WHERE id=?").run(channelId);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'upstream-task-1', status: 'in_progress', progress: 60 })));
  }
  it('补扣和恢复原任务状态一起完成，并发点击只扣一次', async () => {
    pending();
    const results = await Promise.all([VideoRecoveryService.recover(contentId), VideoRecoveryService.recover(contentId)]);
    expect(results.reduce((sum, r) => sum + (Number(r.chargedAmount) || 0), 0)).toBe(2);
    expect(BalanceService.getBalance(userId)).toBe(8);
    expect(read()).toMatchObject({ status: 'processing', cost: 2 });
    expect(JSON.parse(read().metadata)).toMatchObject({ recoveryPrecharged: true, queueRefunded: false, progress: 60, videoId: 'upstream-task-1', billingStatus: 'recovery_precharged' });
    expect(JSON.parse(read().metadata).recoveryCharges).toHaveLength(1);
    expect(JSON.parse(read().metadata).error).toBeUndefined();
    expect(poller.resume).toHaveBeenCalledWith(contentId, expect.objectContaining({ status: 'processing', cost: 2 }));
    expect(vi.mocked(fetch).mock.calls.every(c => !c[1]?.method || c[1]?.method === 'GET')).toBe(true);
  });
  it('余额不足不改状态、不启动轮询、不扣费', async () => {
    pending(); sqlite.prepare('UPDATE users SET balance=1 WHERE id=?').run(userId);
    await expect(VideoRecoveryService.recover(contentId)).rejects.toMatchObject({ status: 402 });
    expect(read().status).toBe('failed'); expect(BalanceService.getBalance(userId)).toBe(1);
    expect(poller.resume).not.toHaveBeenCalled();
  });
  it('状态更新失败时回滚扣费，不能只扣钱不恢复', async () => {
    pending();
    sqlite.exec("CREATE TRIGGER reject_recovery BEFORE UPDATE OF status ON contents WHEN NEW.status='processing' BEGIN SELECT RAISE(ABORT,'rollback test'); END;");
    try { await expect(VideoRecoveryService.recover(contentId)).rejects.toThrow('rollback test'); }
    finally { sqlite.exec('DROP TRIGGER reject_recovery'); }
    expect(BalanceService.getBalance(userId)).toBe(10); expect(read().status).toBe('failed');
    expect(poller.resume).not.toHaveBeenCalled();
  });
  it.each([404, 502])('查询 HTTP %s 不补扣、不恢复', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not available', { status })));
    await expect(VideoRecoveryService.recover(contentId)).rejects.toMatchObject({ status: 502 });
    expect(BalanceService.getBalance(userId)).toBe(10); expect(read().status).toBe('failed');
    expect(poller.resume).not.toHaveBeenCalled();
  });
  it.each([{ success: false }, { status: 'unknown' }, { status: 'in_progress', id: 'wrong-task' }, { status_code: 404, status: 'in_progress' }])('异常响应不能当作已确认生成中并补扣 %j', async payload => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload)));
    await expect(VideoRecoveryService.recover(contentId)).rejects.toMatchObject({ status: 502 });
    expect(BalanceService.getBalance(userId)).toBe(10); expect(poller.resume).not.toHaveBeenCalled();
  });
  it('上游明确失败不扣费', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'failed', error: 'rejected' })));
    expect(await VideoRecoveryService.recover(contentId)).toMatchObject({ status: 'failed' });
    expect(BalanceService.getBalance(userId)).toBe(10); expect(poller.resume).not.toHaveBeenCalled();
  });
  it('原退款为零时恢复不按新价格补扣', async () => {
    const m = { ...JSON.parse(read().metadata), refundAmount: 0 };
    sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?').run(JSON.stringify(m), contentId);
    expect(await VideoRecoveryService.recover(contentId)).toMatchObject({ status: 'completed', chargedAmount: 0 });
    expect(BalanceService.getBalance(userId)).toBe(10); expect(read().cost).toBe(0);
  });
  it('补扣只回到原退款账户，不随用户切换组织改变', async () => {
    pending();
    sqlite.exec('INSERT OR REPLACE INTO organizations(id,balance) VALUES(991,10),(992,20)');
    sqlite.prepare('UPDATE users SET org_id=992 WHERE id=?').run(userId);
    const metadata = { ...JSON.parse(read().metadata), refundTarget: 'organization_balance', billingOrgId: 991, billingBalanceSource: 'org' };
    sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?').run(JSON.stringify(metadata), contentId);
    await VideoRecoveryService.recover(contentId);
    expect(sqlite.prepare('SELECT balance FROM organizations WHERE id=991').get()).toEqual({ balance: 8 });
    expect(sqlite.prepare('SELECT balance FROM organizations WHERE id=992').get()).toEqual({ balance: 20 });
    expect(BalanceService.getBalance(userId)).toBe(10);
  });
  it('个人原退款账户余额不足不会改扣组织账户', async () => {
    pending(); sqlite.exec('INSERT OR REPLACE INTO organizations(id,balance) VALUES(992,20)');
    sqlite.prepare('UPDATE users SET org_id=992,balance=1 WHERE id=?').run(userId);
    await expect(VideoRecoveryService.recover(contentId)).rejects.toMatchObject({ status: 402 });
    expect(sqlite.prepare('SELECT balance FROM organizations WHERE id=992').get()).toEqual({ balance: 20 });
  });
  it('API Token 原退款只补扣对应额度，重复点击不重复记用量', async () => {
    pending();
    sqlite.prepare('INSERT OR REPLACE INTO api_tokens(id,user_id,balance,used_amount) VALUES(991,?,10,0)').run(userId);
    const m = { ...JSON.parse(read().metadata), refundTarget: 'api_token', tokenId: 991, billingSource: 'token' };
    sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?').run(JSON.stringify(m), contentId);
    await VideoRecoveryService.recover(contentId); await VideoRecoveryService.recover(contentId);
    expect(sqlite.prepare('SELECT balance,used_amount FROM api_tokens WHERE id=991').get()).toEqual({ balance: 8, used_amount: 2 });
    expect(BalanceService.getBalance(userId)).toBe(10);
  });
  it('关联 Token 归属不符会回滚个人扣款', async () => {
    pending();
    sqlite.prepare('INSERT OR REPLACE INTO api_tokens(id,user_id,balance,used_amount) VALUES(991,99999,-1,0)').run();
    const m = { ...JSON.parse(read().metadata), tokenId: 991 };
    sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?').run(JSON.stringify(m), contentId);
    await expect(VideoRecoveryService.recover(contentId)).rejects.toMatchObject({ status: 409 });
    expect(BalanceService.getBalance(userId)).toBe(10); expect(read().status).toBe('failed');
  });
  it('查询暂停但没有退款的原预扣任务，成功后不重复收费', async () => {
    const m = { ...JSON.parse(read().metadata), queueRefunded: false, billingStatus: 'charged', recoveryPollingProtected: true };
    sqlite.prepare("UPDATE contents SET status='review',cost=2,metadata=? WHERE id=?").run(JSON.stringify(m), contentId);
    sqlite.prepare('UPDATE users SET balance=8 WHERE id=?').run(userId);
    expect(await VideoRecoveryService.recover(contentId)).toMatchObject({ status: 'completed', chargedAmount: 0 });
    expect(BalanceService.getBalance(userId)).toBe(8);
  });
  it.each(['processing', 'review'])('普通旧视频 %s 未退款，没有计费标记也不重复扣费', async status => {
    sqlite.prepare("UPDATE channels SET type='openai',base_url='https://llm.domie.studio' WHERE id=?").run(channelId);
    sqlite.prepare('UPDATE contents SET status=?,cost=1.5,metadata=? WHERE id=?').run(status, JSON.stringify({
      videoId: 'upstream-task-1', channelId, progress: 85, upstreamStatus: 'in_progress',
    }), contentId);
    // Even an empty wallet must not block retrieval of an already paid result.
    sqlite.prepare('UPDATE users SET balance=0 WHERE id=?').run(userId);
    const results = await Promise.all([VideoRecoveryService.recover(contentId), VideoRecoveryService.recover(contentId)]);
    expect(results.every(r => !r.chargedAmount)).toBe(true);
    expect(BalanceService.getBalance(userId)).toBe(0);
    expect(read()).toMatchObject({ status: 'completed', cost: 1.5 });
    expect(JSON.parse(read().metadata)).toMatchObject({
      upstreamStatus: 'completed', progress: 100, queueStatus: 'completed', billingStatus: 'charged',
    });
    expect(JSON.parse(read().metadata).localizedAt).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.every(c => !c[1]?.method || c[1].method === 'GET')).toBe(true);
  });
  it('普通旧视频尚在生成，恢复轮询不补扣原费用', async () => {
    pending();
    sqlite.prepare("UPDATE contents SET status='processing',cost=1.5,metadata=? WHERE id=?").run(JSON.stringify({
      videoId: 'upstream-task-1', channelId, progress: 85,
    }), contentId);
    expect(await VideoRecoveryService.recover(contentId)).toMatchObject({ status: 'processing', chargedAmount: 0 });
    expect(BalanceService.getBalance(userId)).toBe(10);
    expect(read().cost).toBe(1.5);
    expect(poller.resume).toHaveBeenCalled();
  });
  it('独立预扣账本的视频仍在生成时恢复原轮询，不重复扣费', async () => {
    ensureBillingReservations();
    const charge = reserveUserCharge(userId, 2, 'generate_video', { contentId });
    sqlite.prepare("UPDATE channels SET type='openai' WHERE id=?").run(channelId);
    sqlite.prepare('UPDATE contents SET status=?,cost=?,metadata=? WHERE id=?').run('processing', 2, JSON.stringify({
      videoId: 'upstream-task-1', channelId, billingReservationId: charge.id, billingStatus: 'reserved', queueRefunded: false,
    }), contentId);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'upstream-task-1', status: 'in_progress', progress: 60 })));

    expect(await VideoRecoveryService.recover(contentId)).toMatchObject({ status: 'processing', chargedAmount: 0 });
    expect(BalanceService.getBalance(userId)).toBe(8);
    expect(sqlite.prepare('SELECT state FROM billing_reservations WHERE id=?').get(charge.id)).toEqual({ state: 'reserved' });
    expect(read()).toMatchObject({ status: 'processing', cost: 2 });
    expect(poller.resume).toHaveBeenCalledWith(contentId, expect.objectContaining({ status: 'processing' }));
  });
  it('独立预扣账本的任务成功恢复后只结算一次', async () => {
    ensureBillingReservations();
    const charge = reserveUserCharge(userId, 2, 'generate_video', { contentId });
    sqlite.prepare("UPDATE channels SET type='openai' WHERE id=?").run(channelId);
    sqlite.prepare('UPDATE contents SET status=?,cost=?,metadata=? WHERE id=?').run('processing', 2, JSON.stringify({
      videoId: 'upstream-task-1', channelId, billingReservationId: charge.id, billingStatus: 'reserved', queueRefunded: false,
    }), contentId);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).includes('upstream-task-1')
      ? Response.json({ id: 'upstream-task-1', status: 'completed', video_url: 'https://recovery-upstream.test/media/recovered.mp4' })
      : new Response(validVideo, { status: 200, headers: { 'Content-Type': 'video/mp4' } })));

    expect(await VideoRecoveryService.recover(contentId)).toMatchObject({ status: 'completed', chargedAmount: 0 });
    expect(BalanceService.getBalance(userId)).toBe(8);
    expect(sqlite.prepare('SELECT state,actual FROM billing_reservations WHERE id=?').get(charge.id)).toEqual({ state: 'settled', actual: 2 });
    expect(read()).toMatchObject({ status: 'completed', cost: 2 });
    expect(await VideoRecoveryService.recover(contentId)).toMatchObject({ status: 'completed', alreadyRecovered: true });
    expect(BalanceService.getBalance(userId)).toBe(8);
  });
  it('独立预扣账本任务上游明确失败时退款', async () => {
    ensureBillingReservations();
    const charge = reserveUserCharge(userId, 2, 'generate_video', { contentId });
    sqlite.prepare("UPDATE channels SET type='openai' WHERE id=?").run(channelId);
    sqlite.prepare('UPDATE contents SET status=?,cost=?,metadata=? WHERE id=?').run('processing', 2, JSON.stringify({
      videoId: 'upstream-task-1', channelId, billingReservationId: charge.id, billingStatus: 'reserved', queueRefunded: false,
    }), contentId);
    poller.fail.mockImplementation(async id => { finalizeReservedContent(id, 'failed', { error: 'upstream rejected' }); });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'upstream-task-1', status: 'failed', error: 'upstream rejected' })));

    expect(await VideoRecoveryService.recover(contentId)).toMatchObject({ status: 'failed' });
    expect(poller.fail).toHaveBeenCalledWith(contentId, expect.any(Error), true);
    expect(sqlite.prepare('SELECT state,actual FROM billing_reservations WHERE id=?').get(charge.id)).toEqual({ state: 'refunded', actual: 0 });
    expect(BalanceService.getBalance(userId)).toBe(10);
    expect(read()).toMatchObject({ status: 'failed', cost: 0 });
  });
  it('失败记录无退款凭据时，不猜测金额或重复扣费', async () => {
    sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?').run(JSON.stringify({
      videoId: 'upstream-task-1', channelId,
    }), contentId);
    await expect(VideoRecoveryService.recover(contentId)).rejects.toMatchObject({ status: 409 });
    expect(BalanceService.getBalance(userId)).toBe(10);
    expect(read().status).toBe('failed');
  });
  it('四月天成功响应无视频地址时，使用原任务 content 地址', async () => {
    sqlite.prepare("UPDATE channels SET type='openai',base_url='https://llm.domie.studio/v1' WHERE id=?").run(channelId);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'upstream-task-1', status: 'completed', progress: 100 })));
    expect(await VideoRecoveryService.inspect(contentId)).toMatchObject({
      upstreamResultUrl: 'https://llm.domie.studio/v1/videos/upstream-task-1/content',
    });
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://llm.domie.studio/v1/videos/upstream-task-1');
  });
  it('恢复后已经预扣，后来上游完成只保存，不再扣第二次', async () => {
    const nativeMock = fetch;
    pending(); await VideoRecoveryService.recover(contentId);
    vi.stubGlobal('fetch', nativeMock);
    expect(await VideoRecoveryService.recover(contentId)).toMatchObject({ status: 'completed', chargedAmount: 0 });
    expect(BalanceService.getBalance(userId)).toBe(8);
    expect(read()).toMatchObject({ status: 'completed', cost: 2 });
  });
  it('批量恢复统计包含正在生成任务的补扣金额', async () => {
    pending();
    const result = await VideoRecoveryService.recoverRecentFailed(3);
    expect(result.processingCount).toBe(1); expect(result.chargedAmount).toBe(2);
    expect(BalanceService.getBalance(userId)).toBe(8);
  });
  it('restores a successful task and charges the refunded amount only once', async () => {
    const recovered = await VideoRecoveryService.recover(contentId);
    expect(recovered.status).toBe('completed');
    expect(BalanceService.getBalance(userId)).toBe(8);

    const record = db.select().from(contents).where(eq(contents.id, contentId)).get();
    const metadata = JSON.parse(record!.metadata);
    expect(record).toMatchObject({ status: 'completed', cost: 2 });
    expect(record!.resultUrl).toBe('/uploads/videos/video_sd2_5-haidiyue-face_upstream-task-1.mp4');
    expect(metadata.recoveryCharged).toBe(true);
    expect(metadata.queueRefunded).toBe(false);
    expect(sqlite.prepare("SELECT kind,delta,content_id FROM fund_ledger WHERE content_id=? AND account_type='user'").all(contentId))
      .toEqual([{ kind: 'charge', delta: -2, content_id: contentId }]);

    const repeated = await VideoRecoveryService.recover(contentId);
    expect(repeated.alreadyRecovered).toBe(true);
    expect(BalanceService.getBalance(userId)).toBe(8);
  });

  it('uses the generic saved-channel polling protocol for other video providers', async () => {
    sqlite.prepare("UPDATE channels SET type = 'openai' WHERE id = ?").run(channelId);
    sqlite.prepare("UPDATE contents SET model_id = 'generic-video-model', metadata = ? WHERE id = ?").run(JSON.stringify({
      videoId: 'upstream-task-1',
      channelId,
      actualChannel: 'openai',
      queueRefunded: true,
      refundAmount: 2,
      refundTarget: 'user_balance',
    }), contentId);

    const recovered = await VideoRecoveryService.recover(contentId);
    expect(recovered.status).toBe('completed');
    expect(BalanceService.getBalance(userId)).toBe(8);
    expect(db.select().from(contents).where(eq(contents.id, contentId)).get()).toMatchObject({
      status: 'completed',
      cost: 2,
    });
  });

  it('uses Miaowu task and content endpoints when the completed payload omits a URL', async () => {
    sqlite.prepare("UPDATE channels SET type = 'miaowu', base_url = 'https://api.miaowuai.store/v1' WHERE id = ?").run(channelId);
    sqlite.prepare("UPDATE contents SET model_id = 'seedance-2.5-pro', metadata = ? WHERE id = ?").run(JSON.stringify({
      videoId: 'upstream-task-1',
      channelId,
      actualChannel: 'miaowu',
    }), contentId);

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'upstream-task-1',
      status: 'completed',
      progress: 100,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const inspection = await VideoRecoveryService.inspect(contentId);

    expect(inspection).toMatchObject({
      status: 'completed',
      upstreamResultUrl: 'https://api.miaowuai.store/v1/videos/upstream-task-1/content',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.miaowuai.store/v1/videos/upstream-task-1',
      expect.objectContaining({ headers: { Authorization: 'Bearer test-key' } }),
    );
  });

  it('previews and bulk-recovers eligible failed videos from the last three days', async () => {
    const oldContentId = Number(sqlite.prepare(`
      INSERT INTO contents (user_id, type, title, model_id, cost, status, metadata, created_at)
      VALUES (?, 'video', 'video-recovery-test', 'sd2.5-haidiyue-face', 0, 'failed', ?, datetime('now', '-4 days'))
    `).run(userId, JSON.stringify({
      videoId: 'old-upstream-task',
      channelId,
      refundAmount: 2,
      refundTarget: 'user_balance',
    })).lastInsertRowid);
    sqlite.prepare(`
      INSERT INTO contents (user_id, type, title, model_id, cost, status, metadata)
      VALUES (?, 'video', 'video-recovery-test', 'sd2.5-haidiyue-face', 0, 'failed', '{}')
    `).run(userId);

    const preview = VideoRecoveryService.previewRecentFailed(3);
    expect(preview.candidateIds).toContain(contentId);
    expect(preview.candidateIds).not.toContain(oldContentId);
    expect(preview.missingTaskIdCount).toBeGreaterThanOrEqual(1);

    const result = await VideoRecoveryService.recoverRecentFailed(3);
    expect(result.results).toContainEqual(expect.objectContaining({ id: contentId, status: 'recovered' }));
    expect(result.recoveredCount).toBeGreaterThanOrEqual(1);
    expect(result.chargedAmount).toBeGreaterThanOrEqual(2);
    expect(BalanceService.getBalance(userId)).toBe(8);
  });
});
