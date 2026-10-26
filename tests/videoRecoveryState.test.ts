import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
      const value = typeof c.default === 'object' ? dialect.sqlToQuery(c.default as any).sql
        : typeof c.default === 'string' ? "'" + c.default.replace(/'/g, "''") + "'" : String(c.default);
      return '"' + c.name + '" ' + c.getSQLType() + (c.primary ? ' PRIMARY KEY' : '')
        + (c.default === undefined ? '' : ' DEFAULT ' + value);
    });
    sqlite.exec('CREATE TABLE "' + config.name + '" (' + columns.join(',') + ')');
  }
  return { sqlite, db: drizzle(sqlite, { schema }) };
});

import { db, sqlite } from '../server/db/index';
import { contents } from '../server/db/schema';
import { readVideoRecoveryState, reviewMissingVideoTaskId } from '../server/services/videoRecoveryState';
import { persistVideoSubmissionReceipt, findVideoSubmissionReceipt } from '../server/services/videoSubmissionReceiptService';
import { reserveLegacyVideo, markLegacyVideoSubmitting } from '../server/services/legacyVideoBilling';
import { claimVideoSubmission, acceptVideoSubmission, endVideoSubmission } from '../server/services/videoSubmissionGuard';

let video: typeof import('../server/routes/video');
const row = () => db.select().from(contents).all()[0];
const balance = () => (sqlite.prepare('SELECT balance FROM users WHERE id=1').get() as any).balance;
function seed(meta: Record<string, any> = {}, status = 'processing') {
  return Number(db.insert(contents).values({
    userId: 1, type: 'video', modelId: 'wan3.0-video-prime', cost: 3.9, status,
    metadata: JSON.stringify({ channelId: 1, ...meta }),
  }).run().lastInsertRowid);
}
beforeAll(async () => {
  video = await import('../server/routes/video');
  findVideoSubmissionReceipt(1);
});
beforeEach(() => {
  sqlite.exec(`DELETE FROM contents; DELETE FROM users; DELETE FROM channels;
    DELETE FROM video_submission_receipts; DROP TABLE IF EXISTS billing_reservations;
    INSERT INTO users(id,email,username,password_hash,balance) VALUES(1,'test','test','test',10);
    INSERT INTO channels(id,name,type,base_url,api_key,status)
      VALUES(1,'test','snumom','https://upstream.invalid','test',1);`);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('recovery reads durable IDs without falsely failing or refunding', () => {
  it('ignores historical HM placeholder IDs without polling, resubmitting or changing funds', async () => {
    sqlite.exec("UPDATE channels SET type='hmstudio' WHERE id=1");
    const id = seed({ videoId: '未取得上游任务 ID', upstreamTaskId: '未取得上游任务 ID',
      videoSubmissionState: 'unknown', error: 'HTTP 502: no receipt', billingStatus: 'review' }, 'review');
    const send = vi.fn(); vi.stubGlobal('fetch', send);
    await video.resumePollForTask(id, row());
    expect(send).not.toHaveBeenCalled();
    expect(row()).toMatchObject({status:'review', cost:3.9}); expect(balance()).toBe(10);
    expect(JSON.parse(row().metadata!)).toMatchObject({ error:'HTTP 502: no receipt', missingTaskIdReview:true, videoSubmissionState:'unknown' });
    expect(() => claimVideoSubmission(id)).toThrow('禁止重复提交');
  });
  it('recovers a real receipt hidden behind a placeholder', () => {
    const id = seed({ videoId:'未取得上游任务 ID', upstreamTaskId:'未取得上游任务ID', missingTaskIdReview:true }, 'review');
    persistVideoSubmissionReceipt({contentId:id,upstreamTaskId:'task_real',channelId:1,channelApiKeyId:null,provider:'snumom'});
    expect(readVideoRecoveryState(id)?.status).toBe('processing');
    expect(JSON.parse(row().metadata!)).toMatchObject({videoId:'task_real',upstreamTaskId:'task_real',submissionReceiptRecovered:true});
    expect(balance()).toBe(10);
  });
  it('does not restart an unrelated billing review merely because a submission receipt exists', () => {
    const id = seed({ billingShortfall: 2, requiresReview: true }, 'review');
    persistVideoSubmissionReceipt({ contentId: id, upstreamTaskId: 'task_receipt', channelId: 1, channelApiKeyId: null, provider: 'snumom' });
    expect(readVideoRecoveryState(id)?.status).toBe('review');
    expect(JSON.parse(row().metadata!)).toMatchObject({ billingShortfall: 2, requiresReview: true });
  });
  it('atomically rolls back receipt and ID if the task write fails, preserving funds', () => {
    const id = seed(); claimVideoSubmission(id);
    sqlite.exec("CREATE TRIGGER fail_accept BEFORE UPDATE ON contents BEGIN SELECT RAISE(ABORT,'simulated crash'); END");
    expect(() => acceptVideoSubmission(id, 'task_atomic', { provider: 'snumom', channelId: 1 })).toThrow('simulated crash');
    expect(findVideoSubmissionReceipt(id)).toBeNull(); expect(JSON.parse(row().metadata!).videoId).toBeUndefined();
    expect(row()).toMatchObject({ status: 'processing', cost: 3.9 }); expect(balance()).toBe(10);
    sqlite.exec('DROP TRIGGER fail_accept'); endVideoSubmission(id, 'unknown');
  });
  it('uses the independent receipt to prevent resubmission even after metadata is overwritten', () => {
    const id = seed(); claimVideoSubmission(id);
    acceptVideoSubmission(id, 'task_once', { provider: 'snumom', channelId: 1 });
    sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?').run('{"channelId":1}', id);
    expect(() => claimVideoSubmission(id)).toThrow('禁止重复提交');
    expect(JSON.parse(readVideoRecoveryState(id)!.metadata!).videoId).toBe('task_once');
  });
  it('skips malformed metadata without preventing another task from recovering', async () => {
    const broken = seed(); sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?').run('broken JSON', broken);
    const good = seed({ videoId: 'task_good' });
    vi.stubGlobal('fetch', vi.fn(async () => {
      sqlite.prepare("UPDATE contents SET status='completed' WHERE id=?").run(good);
      return Response.json({ status: 'processing' });
    }));
    video.resumeAllPendingVideoTasks();
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetch).toHaveBeenCalledOnce();
    expect((sqlite.prepare('SELECT status FROM contents WHERE id=?').get(good) as any).status).toBe('completed');
    expect((sqlite.prepare('SELECT metadata FROM contents WHERE id=?').get(broken) as any).metadata).toBe('broken JSON');
  });
  it.each(['upstreamTaskId', 'taskId', 'task_id', 'videoId'])('uses the saved %s for the real polling route', async field => {
    const id = seed({ [field]: 'task_saved' });
    const fetchMock = vi.fn(async () => {
      sqlite.prepare("UPDATE contents SET status='completed' WHERE id=?").run(id);
      return Response.json({ status: 'processing', progress: 5 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const poll = video.resumePollForTask(id, { ...row(), metadata: '{}' });
    await vi.advanceTimersByTimeAsync(10_000);
    await poll;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://upstream.invalid/v1/videos/task_saved');
    expect(balance()).toBe(10);
    expect(JSON.parse(row().metadata!)).toMatchObject({ videoId: 'task_saved' });
  });

  it('re-reads the DB after a caller fetched an empty snapshot', async () => {
    const id = seed();
    const stale = row();
    sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?')
      .run(JSON.stringify({ channelId: 1, videoId: 'task_late' }), id);
    vi.stubGlobal('fetch', vi.fn(async () => {
      sqlite.prepare("UPDATE contents SET status='completed' WHERE id=?").run(id);
      return Response.json({ status: 'processing' });
    }));
    const poll = video.resumePollForTask(id, stale);
    await vi.advanceTimersByTimeAsync(10_000);
    await poll;
    expect(fetch).toHaveBeenCalledWith('https://upstream.invalid/v1/videos/task_late', expect.anything());
    expect(row().cost).toBe(3.9);
  });

  it('recovers an ID from the independent receipt without submitting again', () => {
    const id = seed();
    persistVideoSubmissionReceipt({ contentId: id, upstreamTaskId: 'task_receipt', channelId: 1, channelApiKeyId: null, provider: 'snumom' });
    expect(JSON.parse(readVideoRecoveryState(id)!.metadata!)).toMatchObject({
      videoId: 'task_receipt', submissionReceiptRecovered: true,
    });
  });

  it('holds missing-ID historical tasks for review without refunding or using trace IDs', async () => {
    const id = seed({ requestId: 'trace_only', request_id: 'trace_also' });
    vi.stubGlobal('fetch', vi.fn());
    await video.resumePollForTask(id, row());
    expect(row()).toMatchObject({ status: 'review', cost: 3.9 });
    expect(JSON.parse(row().metadata!)).toMatchObject({ missingTaskIdReview: true, requiresReview: true });
    expect(balance()).toBe(10);
    expect(fetch).not.toHaveBeenCalled();
    expect(video.activePolls.has(id)).toBe(false);
  });

  it('keeps reserved funds in review and resumes when the missing ID arrives', () => {
    const reserved = reserveLegacyVideo(1, 3.9, charge => seed({ billingReservationId: charge.id }));
    markLegacyVideoSubmitting(reserved.contentId);
    reviewMissingVideoTaskId(reserved.contentId);
    expect(balance()).toBeCloseTo(6.1);
    expect((sqlite.prepare('SELECT state FROM billing_reservations WHERE id=?').get(reserved.charge.id) as any).state).toBe('review');
    const meta = JSON.parse(row().metadata!);
    sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?')
      .run(JSON.stringify({ ...meta, upstreamTaskId: 'task_arrived' }), reserved.contentId);
    expect(readVideoRecoveryState(reserved.contentId)).toMatchObject({ status: 'processing', cost: 3.9 });
    expect(balance()).toBeCloseTo(6.1);
  });

  it.each(['failed', 'completed'])('does not revive or alter a %s task using a stale processing snapshot', async status => {
    const id = seed({ upstreamTaskId: 'task_terminal' }, status);
    const before = row();
    await video.resumePollForTask(id, { ...before, status: 'processing', metadata: '{}' });
    expect(row()).toEqual(before);
    expect(balance()).toBe(10);
  });
});
