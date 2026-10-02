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
let video: typeof import('../server/routes/video');
beforeAll(async()=>{
  const intervals=vi.spyOn(globalThis,'setInterval').mockImplementation(()=>({unref(){}}) as any);
  try { video=await import('../server/routes/video'); } finally { intervals.mockRestore(); }
});
afterAll(()=>sqlite.close());

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
