import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { getTableConfig, SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core');
  const schema = await import('../server/db/schema');
  const sqlite = new Database(':memory:'); const dialect = new SQLiteSyncDialect();
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
vi.mock('../server/config/env.js', () => ({ env: { NODE_ENV: 'test', JWT_SECRET: 'test', VIDEO_TASK_POLL_TIMEOUT_MS: 20_000 } }));
vi.mock('../server/middleware/quota.js', () => ({ quotaMiddleware: vi.fn(), logUsage: vi.fn() }));
vi.mock('../server/services/videoLocalizationService.js', () => ({ downloadAndLocalizeVideo: vi.fn(async () => '/uploads/videos/recovered.mp4'), preferredVideoDownloadPath: (p: string) => p }));
import { db, sqlite } from '../server/db/index';
import { contents } from '../server/db/schema';
import { protectsVideoPolling } from '../server/services/videoPollingSafety';
import { env } from '../server/config/env';
let video: typeof import('../server/routes/video');
const row = () => db.select().from(contents).get()!;
const balance = () => (sqlite.prepare('SELECT balance FROM users WHERE id=1').get() as any).balance;
beforeAll(async () => {
  const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => ({ unref() {} }) as any);
  try { video = await import('../server/routes/video'); } finally { interval.mockRestore(); }
});
beforeEach(() => {
  env.VIDEO_TASK_POLL_TIMEOUT_MS = 20_000;
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-20T03:00:00Z'));
  sqlite.exec("DELETE FROM contents; DELETE FROM channels; DELETE FROM users; INSERT INTO users(id,balance) VALUES(1,8);");
  sqlite.prepare("INSERT INTO channels(id,name,type,base_url,api_key,status) VALUES(5,'四月天','openai','https://llm.domie.studio','test',1)").run();
  sqlite.prepare("INSERT INTO contents(id,user_id,type,model_id,cost,status,created_at,metadata) VALUES(13738,1,'video','seedance-2.0-mini-720p',2,'processing','2026-10-20 02:00:00',?)").run(JSON.stringify({
    videoId: 'task_saved', channelId: 5, resolution: '720p', seconds: 15, billingBalanceSource: 'user',
    recoveryPrecharged: true, recoveryCharged: true, recoveryPollingProtected: true, queueRefunded: false,
    recoveryPollingStartedAt: new Date().toISOString(), billingStatus: 'recovery_precharged',
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
afterAll(() => sqlite.close());
it('四月天两个域名和补扣任务均保护查询，批量仍使用自己的结算', () => {
  expect(protectsVideoPolling({ baseUrl: 'https://llm.chre3.com' })).toBe(true);
  expect(protectsVideoPolling({ baseUrl: 'https://llm.domie.studio' })).toBe(true);
  expect(protectsVideoPolling({ baseUrl: 'https://other.test' }, { recoveryPollingProtected: true })).toBe(true);
  expect(protectsVideoPolling({ baseUrl: 'https://llm.chre3.com' }, { batchItemId: 1 })).toBe(false);
});
it('真实后台轮询经历 404 后仍继续，随后更新进度和完成，不退款、不重复扣费', async () => {
  const f = vi.fn().mockResolvedValueOnce(new Response('404 page not found', { status: 404 }))
    .mockResolvedValueOnce(Response.json({ id: 'task_saved', status: 'in_progress', progress: 60 }))
    .mockResolvedValueOnce(Response.json({ id: 'task_saved', status: 'completed', video_url: 'https://cdn.test/result.mp4' }));
  vi.stubGlobal('fetch', f);
  const task = video.resumePollForTask(13738, row());
  await vi.advanceTimersByTimeAsync(5000);
  expect(row().status).toBe('processing'); expect(balance()).toBe(8);
  expect(JSON.parse(row().metadata).upstreamQueryError).toContain('404');
  await vi.advanceTimersByTimeAsync(5000);
  expect(JSON.parse(row().metadata).progress).toBe(60); expect(balance()).toBe(8);
  expect(JSON.parse(row().metadata).progressText).toBe('视频生成中 60%');
  expect(JSON.parse(row().metadata).upstreamQueryError).toBeUndefined();
  await vi.advanceTimersByTimeAsync(5000); await task;
  expect(row()).toMatchObject({ status: 'completed', cost: 2, resultUrl: '/uploads/videos/recovered.mp4' });
  expect(balance()).toBe(8); expect(JSON.parse(row().metadata).billingStatus).toBe('charged_after_recovery');
  expect(f.mock.calls.every(c => !c[1]?.method || c[1].method === 'GET')).toBe(true);
});
it('200 包裹查询错误不会退款，后续明确任务失败才退款一次', async () => {
  const f = vi.fn().mockResolvedValueOnce(Response.json({ status_code: 404, error: 'task lookup failed' }))
    .mockResolvedValueOnce(Response.json({ id: 'task_saved', status: 'failed', error: 'generation rejected' }));
  vi.stubGlobal('fetch', f);
  const task = video.resumePollForTask(13738, row());
  await vi.advanceTimersByTimeAsync(5000); expect(balance()).toBe(8); expect(row().status).toBe('processing');
  await vi.advanceTimersByTimeAsync(5000); await task;
  expect(row()).toMatchObject({ status: 'failed', cost: 0 }); expect(balance()).toBe(10);
  expect(JSON.parse(row().metadata)).toMatchObject({ queueRefunded: true, recoveryCharged: false, refundAmount: 2 });
  await video.failHmQueuedVideo(13738, new Error('duplicate'), true); expect(balance()).toBe(10);
});
it('恢复使用新的查询窗口，持续查询异常到期暂停但不退款', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 502 })));
  const task = video.resumePollForTask(13738, row());
  await vi.advanceTimersByTimeAsync(5000); expect(row().status).toBe('processing');
  await vi.advanceTimersByTimeAsync(15_000); await task;
  expect(row().status).toBe('review'); expect(row().cost).toBe(2); expect(balance()).toBe(8);
  expect(JSON.parse(row().metadata).recoveryPollPausedAt).toBeTruthy();
});
it('查询响应体卡住也会超时释放，继续获取原任务成功结果', async () => {
  env.VIDEO_TASK_POLL_TIMEOUT_MS = 60_000;
  const f = vi.fn().mockResolvedValueOnce({
    status: 200, statusText: 'OK', headers: new Headers(), text: () => new Promise(() => {}),
  }).mockResolvedValueOnce(Response.json({ id: 'task_saved', status: 'completed', video_url: 'https://cdn.test/result.mp4' }));
  vi.stubGlobal('fetch', f);
  const task = video.resumePollForTask(13738, row());
  await vi.advanceTimersByTimeAsync(20_000);
  expect(row().status).toBe('processing'); expect(balance()).toBe(8);
  expect(JSON.parse(row().metadata).upstreamQueryError).toContain('timed out');
  await vi.advanceTimersByTimeAsync(5000); await task;
  expect(row().status).toBe('completed'); expect(balance()).toBe(8);
  expect(video.activePolls.has(13738)).toBe(false);
});
it('管理员已保存完成后，迟到的轮询进度不能覆盖成功状态', async () => {
  let respond!: (r: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { respond = resolve; })));
  const task = video.resumePollForTask(13738, row());
  await vi.advanceTimersByTimeAsync(5000);
  sqlite.prepare("UPDATE contents SET status='completed',result_url='/uploads/videos/admin-recovered.mp4' WHERE id=13738").run();
  respond(Response.json({ id: 'task_saved', status: 'in_progress', progress: 85 }));
  await vi.advanceTimersByTimeAsync(0); await task;
  expect(row()).toMatchObject({ status: 'completed', resultUrl: '/uploads/videos/admin-recovered.mp4' });
  expect(balance()).toBe(8);
});
