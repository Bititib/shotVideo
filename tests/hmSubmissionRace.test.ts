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
vi.mock('../server/services/videoLocalizationService.js', async importOriginal => ({
  ...await importOriginal<typeof import('../server/services/videoLocalizationService.js')>(),
  downloadAndLocalizeVideo: vi.fn(async () => '/uploads/videos/h3-test.mp4'),
}));
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
it.each(['invalid-local-audio', 'invalid-local-video'])('refunds a proven local HM preparation failure without sending: %s', async kind => {
  const id = ++sequence;
  db.insert(users).values({ id, email: id + '@test.invalid', username: 'test', passwordHash: 'test', balance: 100 }).run();
  db.insert(channels).values({ id, name: 'HM preparation', type: 'hmstudio', baseUrl: 'https://hm.test', apiKey: 'test',
    supportedModels: '["sd2.5-933"]', modelMapping: '{"sd2.5-933":"30-10-10"}', status: 1 }).run();
  reserveLegacyVideo(id, 7, charge => {
    db.insert(contents).values({ id, userId: id, type: 'video', modelId: 'sd2.5-933', status: 'queued', cost: 7,
      metadata: JSON.stringify({ channelId: id, prompt: 'test', resolution: '720p', seconds: 30,
        publicBaseUrl: 'https://public.test',
        ...(kind === 'invalid-local-audio' ? { audio_urls: ['/not-an-upload/audio.mp3'] } : { reference_videos: ['/not-an-upload/video.mp4'] }),
        billingReservationId: charge.id, videoSubmissionState: 'preparing' }) }).run();
    return id;
  });
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  try {
    video.enqueueHmStudioVideoContent(id);
    await vi.waitFor(() => expect(db.select().from(contents).where(eq(contents.id, id)).get()?.status).toBe('failed'));
    const row = db.select().from(contents).where(eq(contents.id, id)).get()!;
    expect(JSON.parse(row.metadata!)).toMatchObject({ billingStatus: 'refunded', requiresReview: false, videoSubmissionState: 'rejected' });
    expect(JSON.parse(row.metadata!).error).toContain('未发送上游');
    expect(JSON.parse(row.metadata!).error).toContain('参考素材路径不安全');
    await video.failHmQueuedVideo(id, new Error('duplicate'), true);
    await video.resumePollForTask(id, row);
    expect(db.select().from(users).where(eq(users.id, id)).get()?.balance).toBe(100);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
it.each(['720p'])('actual HM queue overrides a stale lumen channel for nova at %s', async resolution => {
  const id = ++sequence;
  db.insert(users).values({ id, email: id + '@test.invalid', username: 'test', passwordHash: 'test', balance: 100 }).run();
  db.insert(channels).values({ id, name: 'HM nova test', type: 'hmstudio', baseUrl: 'https://hm.test', apiKey: 'test',
    supportedModels: '["sd2.5-933"]', modelMapping: '{"sd2.5-933":"30-10-10"}', status: 1 }).run();
  const { contentId } = reserveLegacyVideo(id, 2, charge => {
    db.insert(contents).values({ id, userId: id, type: 'video', modelId: 'sd2.5-933', status: 'queued', cost: 2,
      metadata: JSON.stringify({ channelId: id, prompt: 'test', resolution, seconds: 30, upstream_channel: 'lumen',
        reference_images: Array(9).fill('https://example.test/image.jpg'),
        reference_videos: Array(3).fill('https://example.test/video.mp4'), audio_urls: Array(3).fill('https://example.test/audio.mp3'),
        billingReservationId: charge.id, videoSubmissionState: 'preparing' }) }).run();
    return id;
  });
  // Existing HM rejection contract, not a paid nova probe or evidence of nova capability limits.
  const fetcher = vi.fn(async () => Response.json({ error: '该渠道不支持模型：30-10-10' }, { status: 400 }));
  vi.stubGlobal('fetch', fetcher);
  try {
    video.enqueueHmStudioVideoContent(contentId);
    await vi.waitFor(() => expect(db.select().from(contents).where(eq(contents.id, id)).get()?.status).toBe('failed'));
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://hm.test/v1/videos/generations');
    expect(new Headers(options.headers).get('content-type')).toBe('application/json');
    const payload = JSON.parse(String(options.body));
    expect(payload.channel).toBe('DDLONG');
    expect(payload.model).toBe('DDLONG-SD2.5');
    expect(payload.video_resolution).toBe(resolution);
    expect(payload.duration).toBe(30);
    expect(payload.face).toBe(true);
    expect(payload.function_mode).toBe('omni_reference');
    expect(payload.materials).toHaveLength(15);
    expect(db.select().from(users).where(eq(users.id, id)).get()?.balance).toBe(100);
    await video.failHmQueuedVideo(id, new Error('duplicate'), true);
    await video.resumePollForTask(id, db.select().from(contents).where(eq(contents.id, id)).get());
    expect(db.select().from(users).where(eq(users.id, id)).get()?.balance).toBe(100);
    expect(fetcher).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});
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

it('sends a long queued prompt to HM and refunds an explicit upstream rejection exactly once', async () => {
  const id = ++sequence;
  db.insert(users).values({ id, email:id+'@test.invalid', username:'test', passwordHash:'test', balance:100 }).run();
  db.insert(channels).values({ id, name:'HM old queue',type:'hmstudio',baseUrl:'https://hm.test',apiKey:'test',
    supportedModels:'["sd2.5-933"]',modelMapping:'{"sd2.5-933":"30-10-10"}',status:1 }).run();
  reserveLegacyVideo(id,7,charge => {
    db.insert(contents).values({id,userId:id,type:'video',modelId:'sd2.5-933',status:'queued',cost:7,
      metadata:JSON.stringify({channelId:id,prompt:'字'.repeat(8001),resolution:'720p',seconds:4,
        billingReservationId:charge.id,videoSubmissionState:'preparing'})}).run();
    return id;
  });
  const fetcher = vi.fn(async (_url: any, options: any) => {
    expect(JSON.parse(options.body).prompt).toBe('字'.repeat(8001));
    return Response.json({error:'测试上游拒绝长提示词'}, {status:400});
  });
  vi.stubGlobal('fetch',fetcher);
  try {
    video.enqueueHmStudioVideoContent(id);
    await vi.waitFor(() => expect(db.select().from(contents).where(eq(contents.id,id)).get()?.status).toBe('failed'));
    const row = db.select().from(contents).where(eq(contents.id,id)).get()!;
    expect(JSON.parse(row.metadata!)).toMatchObject({billingStatus:'refunded',requiresReview:false,videoSubmissionState:'rejected'});
    expect(JSON.parse(row.metadata!).error).toContain('测试上游拒绝长提示词');
    await video.failHmQueuedVideo(id,new Error('duplicate'),true);
    await video.resumePollForTask(id,row);
    expect(db.select().from(users).where(eq(users.id,id)).get()?.balance).toBe(100);
    expect(fetcher).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});

it.each(['timeout', '502', 'reset', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL'])('settles HM %s according to delivery evidence and never resubmits during recovery', async failure => {
  const notSent = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL'].includes(failure);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const id = ++sequence;
  db.insert(users).values({ id, email: id + '@test.invalid', username: 'test', passwordHash: 'test', balance: 100 }).run();
  db.insert(channels).values({ id, name: 'HM nova unknown', type: 'hmstudio', baseUrl: 'https://hm.test', apiKey: 'test',
    supportedModels: '["sd2.5-933"]', modelMapping: '{"sd2.5-933":"30-10-10"}', status: 1 }).run();
  reserveLegacyVideo(id, 7, charge => {
    db.insert(contents).values({ id, userId: id, type: 'video', modelId: 'sd2.5-933', status: 'queued', cost: 7,
      metadata: JSON.stringify({ channelId: id, prompt: 'test', resolution: '720p', seconds: 4,
        billingReservationId: charge.id, videoSubmissionState: 'preparing' }) }).run();
    return id;
  });
  const fetcher = vi.fn(async () => {
    if (notSent) throw Object.assign(new Error('fetch failed'), { cause: { code: failure } });
    if (failure === '502') return new Response('<html><title>502 Bad Gateway</title></html>', { status: 502 });
    if (failure === 'reset') throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
    throw Object.assign(new Error('response timed out'), { name: 'TimeoutError' });
  });
  vi.stubGlobal('fetch', fetcher);
  try {
    video.enqueueHmStudioVideoContent(id);
    await vi.waitFor(() => expect(db.select().from(contents).where(eq(contents.id, id)).get()?.status).toBe(notSent ? 'failed' : 'review'));
    for (let i = 0; i < 2; i++) await video.resumePollForTask(id, db.select().from(contents).where(eq(contents.id, id)).get());
    if (notSent) await video.failHmQueuedVideo(id, new Error('duplicate'), true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(db.select().from(users).where(eq(users.id, id)).get()?.balance).toBe(notSent ? 100 : 93);
    const row = db.select().from(contents).where(eq(contents.id, id)).get()!;
    expect(row.status).toBe(notSent ? 'failed' : 'review');
    expect(JSON.parse(row.metadata!)).toMatchObject({ videoSubmissionState: notSent ? 'rejected' : 'unknown' });
    if (notSent) expect(JSON.parse(row.metadata!)).toMatchObject({ billingStatus: 'refunded', requiresReview: false });
    const diagnostic = warning.mock.calls.find(([tag, value]) => tag === '[hm-video-task]' && JSON.parse(String(value)).contentId === id);
    expect(diagnostic).toBeDefined();
    expect(JSON.parse(String(diagnostic![1]))).toMatchObject({ contentId: id, outcome: notSent ? 'rejected' : 'unknown' });
    if (failure === '502') expect(String(diagnostic![1])).toContain('HTTP 502');
    expect(String(diagnostic![1])).not.toMatch(/<html>|Bearer |https:\/\//);
  } finally { warning.mockRestore(); vi.unstubAllGlobals(); }
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

it.each(['MiniMax-H3','seedance_v2.0','seedance_v2.0-933'].flatMap(model=>['rejected','unknown'].map(outcome=>({model,outcome}))))('$model queue preserves once-only settlement and recovery after $outcome',async ({model,outcome})=>{
  const upstream = model==='seedance_v2.0'?'MINIMAXH3-2.0采样':model==='seedance_v2.0-933'?'MINIMAX-H3-2.0采样-933':'MINIMAXH3 9-3-3';
  const retail = model==='seedance_v2.0'?0.7:model==='seedance_v2.0-933'?1.37:2.2;
  const seconds = model==='MiniMax-H3'?15:10;
  const resolution = model==='MiniMax-H3'?'2k':'720p';
  const id=++sequence;
  db.insert(users).values({id,email:id+'@test.invalid',username:'test',passwordHash:'test',balance:100}).run();
  db.insert(channels).values({id,name:'H3 nova',type:'hmstudio',baseUrl:'https://hm.test',apiKey:'test',supportedModels:JSON.stringify([model]),modelMapping:JSON.stringify({[model]:upstream}),status:1}).run();
  reserveLegacyVideo(id,retail,charge=>{
    db.insert(contents).values({id,userId:id,type:'video',modelId:model,status:'queued',cost:retail,metadata:JSON.stringify({channelId:id,prompt:'test',resolution,seconds,upstream_channel:'lumen',billingReservationId:charge.id,videoSubmissionState:'preparing'})}).run();return id;
  });
  const fetcher=vi.fn(async (_url:any,options:any)=>{
    expect(JSON.parse(options.body)).toMatchObject({channel:model==='MiniMax-H3'?'nova':'default',model:upstream,duration:seconds,video_resolution:resolution});
    return outcome==='rejected'?Response.json({error:'模型明确拒绝'},{status:400}):new Response('<html>502</html>',{status:502});
  });vi.stubGlobal('fetch',fetcher);
  try{
    video.enqueueHmStudioVideoContent(id);
    await vi.waitFor(()=>expect(db.select().from(contents).where(eq(contents.id,id)).get()?.status).toBe(outcome==='rejected'?'failed':'review'));
    for(let i=0;i<2;i++) await video.resumePollForTask(id,db.select().from(contents).where(eq(contents.id,id)).get());
    if(outcome==='rejected') await video.failHmQueuedVideo(id,new Error('duplicate'),true);
    expect(db.select().from(users).where(eq(users.id,id)).get()?.balance).toBeCloseTo(outcome==='rejected'?100:100-retail);
    expect(fetcher).toHaveBeenCalledOnce();
  }finally{vi.unstubAllGlobals();}
});

it.each(['sd2.5-933','MiniMax-H3','seedance_v2.0','seedance_v2.0-933'])('%s persists receipt before polling and settles once after a temporary query failure',async model=>{
  const upstream = model==='sd2.5-933'?'30-10-10':model==='seedance_v2.0'?'MINIMAXH3-2.0采样':model==='seedance_v2.0-933'?'MINIMAX-H3-2.0采样-933':'MINIMAXH3 9-3-3';
  const retail = model==='sd2.5-933'?7:model==='seedance_v2.0'?0.7:model==='seedance_v2.0-933'?1.37:1.5;
  const id=++sequence, taskId='abecab12-3456-4789-9234-123456789abc';
  db.insert(users).values({id,email:id+'@test.invalid',username:'test',passwordHash:'test',balance:100}).run();
  db.insert(channels).values({id,name:'H3 accepted',type:'hmstudio',baseUrl:'https://hm.test',apiKey:'test',supportedModels:JSON.stringify([model]),modelMapping:JSON.stringify({[model]:upstream}),status:1}).run();
  reserveLegacyVideo(id,retail,charge=>{
    db.insert(contents).values({id,userId:id,type:'video',modelId:model,status:'queued',cost:retail,metadata:JSON.stringify({channelId:id,prompt:'test',resolution:'720p',seconds:4,billingReservationId:charge.id,videoSubmissionState:'preparing'})}).run();return id;
  });
  let gets=0;
  const fetcher=vi.fn(async (url:any,options:any)=>{
    if(options?.method==='POST') {
      if(model==='sd2.5-933') expect(JSON.parse(options.body)).toMatchObject({model:'DDLONG-SD2.5',channel:'DDLONG'});
      return Response.json({task_id:taskId,status:'pending'},{status:202});
    }
    expect(String(url)).toBe('https://hm.test/v1/tasks/'+taskId);
    const row=db.select().from(contents).where(eq(contents.id,id)).get()!;
    expect(JSON.parse(row.metadata!).videoId).toBe(taskId);
    if(model==='sd2.5-933') expect(JSON.parse(row.metadata!).upstreamModel).toBe('DDLONG-SD2.5');
    expect(db.select().from(users).where(eq(users.id,id)).get()?.balance).toBeCloseTo(100-retail);
    if(++gets===1) return Response.json({error:'暂时无法查询'},{status:503});
    return Response.json({task_id:taskId,status:'success',result_urls:['https://cdn.test/h3.mp4']});
  });vi.stubGlobal('fetch',fetcher);
  try{
    video.enqueueHmStudioVideoContent(id);
    await vi.waitFor(()=>expect(db.select().from(contents).where(eq(contents.id,id)).get()?.status).toBe('completed'),{timeout:15000});
    const row=db.select().from(contents).where(eq(contents.id,id)).get()!;
    expect(row).toMatchObject({cost:retail,resultUrl:'/uploads/videos/h3-test.mp4'});
    await video.resumePollForTask(id,row);
    expect(db.select().from(users).where(eq(users.id,id)).get()?.balance).toBeCloseTo(100-retail);
    expect(fetcher.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1);
    expect(gets).toBe(2);
  }finally{vi.unstubAllGlobals();}
},20000);

// Orders queued before the cutover must not silently lose media or change resolution.
it.each([{resolution:'1080p'},{reference_images:Array(30).fill('https://example.test/i.jpg')},{reference_videos:Array(10).fill('https://example.test/v.mp4')},{audio_urls:Array(10).fill('https://example.test/a.mp3')}])('rejects incompatible old DDLONG queued input and refunds once: %j',async extra=>{
  const id=++sequence;
  db.insert(users).values({id,email:id+'@test.invalid',username:'test',passwordHash:'test',balance:100}).run();
  db.insert(channels).values({id,name:'old nova config',type:'hmstudio',baseUrl:'https://hm.test',apiKey:'test',supportedModels:'["sd2.5-933"]',modelMapping:'{"sd2.5-933":"SD2.5-30-10-10"}',status:1}).run();
  reserveLegacyVideo(id,7,charge=>{
    db.insert(contents).values({id,userId:id,type:'video',modelId:'sd2.5-933',status:'queued',cost:7,metadata:JSON.stringify({channelId:id,prompt:'test',seconds:30,resolution:'720p',...extra,billingReservationId:charge.id,videoSubmissionState:'preparing'})}).run();return id;
  });
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  try{
    video.enqueueHmStudioVideoContent(id);
    await vi.waitFor(()=>expect(db.select().from(contents).where(eq(contents.id,id)).get()?.status).toBe('failed'));
    const row=db.select().from(contents).where(eq(contents.id,id)).get()!;
    expect(JSON.parse(row.metadata!)).toMatchObject({billingStatus:'refunded',videoSubmissionState:'rejected'});
    expect(JSON.parse(row.metadata!).error).toContain('未发送上游');
    await video.failHmQueuedVideo(id,new Error('duplicate'),true);
    await video.resumePollForTask(id,row);
    expect(fetcher).not.toHaveBeenCalled();
    expect(db.select().from(users).where(eq(users.id,id)).get()!.balance).toBe(100);
  }finally{vi.unstubAllGlobals();}
});
