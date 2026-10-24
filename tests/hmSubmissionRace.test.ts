import { afterAll, beforeAll, expect, it, vi } from 'vitest';
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
import { db, sqlite } from '../server/db/index';
import { contents, users, channels } from '../server/db/schema';
import { hmStudioQueue } from '../server/services/hmStudioQueueService';
import { BalanceService } from '../server/services/balanceService';
import { reserveLegacyVideo } from '../server/services/legacyVideoBilling.js';
import { eq } from 'drizzle-orm';
let video: typeof import('../server/routes/video');
beforeAll(async()=>{
  const intervals=vi.spyOn(globalThis,'setInterval').mockImplementation(()=>({unref(){}}) as any);
  try { video=await import('../server/routes/video'); } finally { intervals.mockRestore(); }
});
afterAll(()=>sqlite.close());
let sequence = 20;
it.each([400, 401, 402, 422, 429, 503])('HM queue HTTP %s rejection closes the actual reserved order and refunds once', async status => {
  const id = ++sequence;
  db.insert(users).values({ id, email: id + '@test.invalid', username: 'test', passwordHash: 'test', balance: 100 }).run();
  db.insert(channels).values({ id, name: 'HM test', type: 'hmstudio', baseUrl: 'https://hm.test', apiKey: 'test', supportedModels: '["seedance_v2.5"]', status: 1 }).run();
  const { contentId } = reserveLegacyVideo(id, 2, charge => {
    db.insert(contents).values({ id, userId: id, type: 'video', modelId: 'seedance_v2.5', status: 'queued', cost: 2,
      metadata: JSON.stringify({ channelId: id, prompt: 'test', resolution: '720p', seconds: 6,
        billingReservationId: charge.id, videoSubmissionState: 'preparing' }) }).run();
    return id;
  });
  const reason = status === 503 ? '临时修复' : status === 429 ? '当前有 3 个任务正在生成中，请等待完成后再提交' : '参数或账户不符合要求';
  const fetcher = vi.fn(async () => Response.json({ error: reason, ...(status === 429 ? { code: 'GENERATING_LIMIT' } : {}) }, { status }));
  vi.stubGlobal('fetch', fetcher);
  try {
    video.enqueueHmStudioVideoContent(contentId);
    await vi.waitFor(() => expect(db.select().from(contents).where(eq(contents.id, id)).get()?.status).toBe('failed'));
    expect(db.select().from(users).where(eq(users.id, id)).get()?.balance).toBe(100);
    const meta = JSON.parse(db.select().from(contents).where(eq(contents.id, id)).get()!.metadata);
    expect(meta).toMatchObject({ requiresReview: false, billingStatus: 'refunded', videoSubmissionState: 'rejected' });
    expect(meta.error).toContain(reason);
    await video.failHmQueuedVideo(id, new Error('duplicate'), true);
    await video.resumePollForTask(id, db.select().from(contents).where(eq(contents.id, id)).get());
    expect(db.select().from(users).where(eq(users.id, id)).get()?.balance).toBe(100);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(db.select().from(channels).where(eq(channels.id, id)).get()?.status).toBe(1);
  } finally { vi.unstubAllGlobals(); }
});

it('does not fail or refund an HM job while its create request is still waiting for a task ID',async()=>{
  db.insert(users).values({id:1,email:'race@test',username:'race',passwordHash:'test',balance:8}).run();
  db.insert(channels).values({id:1,name:'hm-race',type:'hmstudio',baseUrl:'https://hm.test',apiKey:'test',supportedModels:'["seedance_v2.5"]',status:1}).run();
  db.insert(contents).values({id:1,userId:1,type:'video',modelId:'seedance_v2.5',status:'processing',cost:2,
    metadata:JSON.stringify({channelId:1,queueStatus:'running',reference_images:['/uploads/history-assets/test.jpg']})}).run();
  let release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  const job=hmStudioQueue.enqueue({id:'video:1',userKey:1,task:()=>pending});
  const refund=vi.spyOn(BalanceService,'refundToSource');
  try {
    const record=db.select().from(contents).get()!;
    for(let i=0;i<3;i++) await video.resumePollForTask(1,record);
    const current=db.select().from(contents).get()!;
    expect(current.status).toBe('processing');
    expect(current.cost).toBe(2);
    expect(JSON.parse(current.metadata!)).not.toHaveProperty('error');
    expect(refund).not.toHaveBeenCalled();
    expect(video.activePolls.has(1)).toBe(false);
    expect(hmStudioQueue.has('video:1')).toBe(true);
  } finally { release();await job.completion;refund.mockRestore(); }
});
