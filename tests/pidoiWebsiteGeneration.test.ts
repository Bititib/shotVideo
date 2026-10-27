import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { getTableConfig } = await import('drizzle-orm/sqlite-core');
  const schema = await import('../server/db/schema.js');
  const sqlite = new Database(':memory:');
  for (const table of Object.values(schema)) {
    try {
      const config = getTableConfig(table as any);
      sqlite.exec(`CREATE TABLE IF NOT EXISTS "${config.name}" (${config.columns.map(c => `"${c.name}" ${c.getSQLType()}${c.primary ? ' PRIMARY KEY' : ''}`).join(',')})`);
    } catch { /* Relations are not tables. */ }
  }
  return { sqlite, db: drizzle(sqlite, { schema }) };
});
vi.mock('../server/services/channelService.js', () => {
  const channel = { id: 6, type: 'openai', name: 'Pidoi 图片渠道', baseUrl: 'https://pidoi.com', apiKey: 'test-key', timeout: 120_000, modelMapping: {} };
  return { ChannelService: { findChannelsForModel: () => [channel], getChannelRaw: () => channel } };
});
vi.mock('../server/services/pricingService.js', () => ({ PricingService: { quote: (_model: string, input: any) => ({ cost: (input.count || 1) * 0.22 }) } }));
vi.mock('../server/services/pidoiImageStorage.js', () => ({ localizeRecoveredImages: vi.fn() }));
vi.mock('../server/services/specificationGenerationService.js', () => ({ handleSpecificationGeneration: async () => false }));
vi.mock('../server/middleware/quota.js', () => ({ quotaMiddleware: vi.fn(), logUsage: vi.fn() }));
import { sqlite } from '../server/db/index.js';
import router from '../server/routes/imageGen.js';
import { localizeRecoveredImages } from '../server/services/pidoiImageStorage.js';
import { recoverPidoiImage, pidoiImageActive } from '../server/services/pidoiImageWorker.js';
import { generateSpecificationImage } from '../server/services/specificationAdapters.js';
import { confirmPidoiImageFailure, recheckPidoiImage, supplementPidoiImageResults, supplementPidoiImageTask } from '../server/services/pidoiImageResolutionService.js';
import adminRouter from '../server/routes/pidoiImageAdmin.js';

function row() { return sqlite.prepare('SELECT * FROM contents ORDER BY id DESC LIMIT 1').get() as any; }
function balance() { return (sqlite.prepare('SELECT balance FROM users WHERE id=1').get() as any).balance; }
function reservation() { return sqlite.prepare('SELECT * FROM billing_reservations ORDER BY id DESC LIMIT 1').get() as any; }
async function generate(count = 1) {
  const layer = router.stack.find((layer: any) => layer.route?.path === '/generate' && layer.route.methods.post) as any;
  const chunks: string[] = [];
  const res: any = { setHeader: vi.fn(), flushHeaders: vi.fn(), write: (chunk: string) => chunks.push(chunk),
    end: () => { res.writableEnded = true; }, status: (code: number) => { res.code = code; return res; }, json: vi.fn() };
  const req: any = { userId: 1, body: { model: 'gpt-image-2', prompt: 'cat', quality: 'high', resolution: '4K', n: count }, protocol: 'https', get: () => 'local.test', headers: {}, socket: {} };
  await layer.route.stack.at(-1).handle(req, res, () => {});
  return { res, chunks };
}
beforeEach(() => {
  vi.stubEnv('PIDOI_IMAGE_REQUEST_MODE', 'async-first');
  sqlite.exec(`DELETE FROM users; DELETE FROM contents; DROP TABLE IF EXISTS billing_reservations;
    INSERT INTO users(id,balance,role,is_active) VALUES(1,100,'user',1),(9,0,'super_admin',1);`);
  vi.mocked(localizeRecoveredImages).mockResolvedValue({ urls: ['/api/uploads/result.png'], issues: [], failures: [] });
});
afterEach(async () => {
  await vi.waitFor(() => expect(pidoiImageActive.size).toBe(0));
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks();
});

describe('Pidoi 网页提交到保存和结算', () => {
  it('同步优先不可用时在原记录中启用异步备用，只预扣一次', async () => {
    vi.stubEnv('PIDOI_IMAGE_REQUEST_MODE', undefined);
    const f = vi.fn().mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(Response.json({ code: 'success', data: { task_id: 'task_backup', status: 'IN_PROGRESS' } }))
      .mockResolvedValueOnce(Response.json({ code: 'success', data: { task_id: 'task_backup', status: 'SUCCESS', result_url: 'https://storage.test/cat.png' } }));
    vi.stubGlobal('fetch', f); await generate();
    await vi.waitFor(() => expect(row().status).toBe('completed'));
    expect(f.mock.calls.map(call => call[1].method)).toEqual(['POST', 'POST', 'GET']);
    expect(f.mock.calls.slice(0, 2).map(call => call[0])).toEqual(['https://pidoi.com/v1/images/generations', 'https://pidoi.com/v1/image/generations']);
    expect(JSON.parse(row().metadata).pidoiFallbacks[0]).toMatchObject({ protocol: 'async', status: 'completed', taskId: 'task_backup' });
    expect(balance()).toBeCloseTo(99.78); expect(reservation().state).toBe('settled');
    expect((sqlite.prepare('SELECT COUNT(*) n FROM contents').get() as any).n).toBe(1);
    await recoverPidoiImage(row().id); expect(f).toHaveBeenCalledTimes(3); expect(balance()).toBeCloseTo(99.78);
  });
  it('异步备用提交超时保留核对，后续扫描不重复生成', async () => {
    vi.stubEnv('PIDOI_IMAGE_REQUEST_MODE', undefined);
    const f = vi.fn().mockResolvedValueOnce(new Response('Not Found', { status: 404 })).mockRejectedValueOnce(new Error('timeout'));
    vi.stubGlobal('fetch', f); await generate();
    await vi.waitFor(() => expect(pidoiImageActive.size).toBe(0));
    expect(row().status).toBe('review');
    expect(JSON.parse(row().metadata).pidoiFallbacks[0].status).toBe('unknown');
    await recoverPidoiImage(row().id, { automatic: true });
    expect(f).toHaveBeenCalledTimes(2); expect(reservation().state).toBe('review');
  });
  it('规格路由同样同步优先并记录异步备用', async () => {
    vi.stubEnv('PIDOI_IMAGE_REQUEST_MODE', undefined);
    const f = vi.fn().mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(Response.json({ code: 'success', data: { task_id: 'task_spec_backup', status: 'SUCCESS', result_url: 'https://storage.test/cat.png' } }));
    vi.stubGlobal('fetch', f); const fallback = vi.fn();
    const result = await generateSpecificationImage({ channel: { id: 6, baseUrl: 'https://pidoi.com', apiKey: 'test-key' },
      route: { executionModel: 'gpt-image-2', upstreamModel: 'gpt-image-2' } } as any,
      { prompt: 'cat', input: { ratio: '1:1', resolution: '4K' }, images: [], videos: [], audios: [], firstFrame: '', lastFrame: '', body: {}, publicBaseUrl: 'https://local.test' } as any,
      vi.fn(), vi.fn(), undefined, undefined, undefined, fallback);
    expect(result.imageUrl).toBe('https://storage.test/cat.png');
    expect(f.mock.calls.map(call => call[0])).toEqual(['https://pidoi.com/v1/images/generations', 'https://pidoi.com/v1/image/generations']);
    expect(fallback).toHaveBeenLastCalledWith(expect.objectContaining({ protocol: 'async', status: 'completed', taskId: 'task_spec_backup' }));
  });
  it('默认同步直连，成功自动保存结算，不等待空任务 ID', async () => {
    vi.stubEnv('PIDOI_IMAGE_REQUEST_MODE', undefined);
    const f = vi.fn().mockResolvedValue(Response.json({ data: [{ url: 'https://storage.test/cat.png' }] }));
    vi.stubGlobal('fetch', f);
    await generate();
    await vi.waitFor(() => expect(row().status).toBe('completed'));
    expect(f).toHaveBeenCalledExactlyOnceWith('https://pidoi.com/v1/images/generations', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(row().metadata)).toMatchObject({ pidoiRequestMode: 'sync', pidoiSubmissionProtocol: 'openai-compatible', billingStatus: 'settled', requiresReview: false });
    expect(balance()).toBeCloseTo(99.78);
  });
  it('同步明确拒绝直接结束退款；重复扫描不重复退款', async () => {
    vi.stubEnv('PIDOI_IMAGE_REQUEST_MODE', 'sync');
    const f = vi.fn().mockResolvedValue(Response.json({ error: { message: 'Content rejected' } }, { status: 451 }));
    vi.stubGlobal('fetch', f);
    await generate();
    await vi.waitFor(() => expect(row().status).toBe('failed'));
    await recoverPidoiImage(row().id, { automatic: true });
    expect(balance()).toBe(100);
    expect(reservation().state).toBe('refunded');
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('同步断线没有可查询 ID 时停止无效扫描，保留人工核实入口', async () => {
    vi.stubEnv('PIDOI_IMAGE_REQUEST_MODE', 'sync');
    const f = vi.fn().mockRejectedValue(new Error('connection lost'));
    vi.stubGlobal('fetch', f);
    await generate();
    await vi.waitFor(() => expect(pidoiImageActive.size).toBe(0));
    expect(row().status).toBe('review');
    expect(JSON.parse(row().metadata).pidoiRecoveryPausedAt).toBeTruthy();
    await recoverPidoiImage(row().id, { automatic: true });
    expect(f).toHaveBeenCalledTimes(1);
    expect(balance()).toBeCloseTo(99.78);
    expect(reservation().state).toBe('review');
  });
  it('查询 404 不无限轮询、不当失败退款，管理员可再次查询原任务', async () => {
    vi.stubEnv('PIDOI_IMAGE_REQUEST_MODE', 'sync');
    const f = vi.fn().mockResolvedValueOnce(Response.json({ id: 'task_query', status: 'queued' }))
      .mockResolvedValueOnce(Response.json({ error: { message: 'Invalid URL' } }, { status: 404 }));
    vi.stubGlobal('fetch', f);
    await generate();
    await vi.waitFor(() => expect(pidoiImageActive.size).toBe(0));
    expect(row().status).toBe('review');
    expect(JSON.parse(row().metadata)).toMatchObject({ upstreamTaskId: 'task_query', pidoiRecoveryPauseReason: expect.stringContaining('404') });
    await recoverPidoiImage(row().id, { automatic: true });
    expect(f).toHaveBeenCalledTimes(2);
    f.mockResolvedValueOnce(Response.json({ id: 'task_query', status: 'completed', image_url: 'https://storage.test/cat.png' }));
    expect(await recheckPidoiImage(row().id, 9)).toMatchObject({ status: 'completed' });
    expect(f.mock.calls.map(c => c[1].method)).toEqual(['POST', 'GET', 'GET']);
    expect(JSON.parse(row().metadata).pidoiRecoveryPausedAt).toBeUndefined();
    expect(balance()).toBeCloseTo(99.78);
  });
  it.each(['poll', 'download'])('恢复 %s 最多自动跟进 30 分钟，之后明确暂停但保留结果', async stage => {
    vi.stubEnv('PIDOI_IMAGE_REQUEST_MODE', 'sync');
    const f = vi.fn().mockResolvedValueOnce(Response.json(stage === 'download'
      ? { data: [{ url: 'https://storage.test/cat.png' }] } : { id: 'task_slow', status: 'queued' }))
      .mockResolvedValue(Response.json({ id: 'task_slow', status: 'queued' }));
    vi.stubGlobal('fetch', f);
    if (stage === 'download') vi.mocked(localizeRecoveredImages).mockResolvedValue({ urls: [], issues: [], failures: [new Error('download timeout')] });
    await generate();
    await vi.waitFor(() => expect(pidoiImageActive.size).toBe(0));
    const m = JSON.parse(row().metadata);
    m.pidoiRecoveryStartedAt = Date.now() - 31 * 60_000;
    sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?').run(JSON.stringify(m), row().id);
    f.mockClear(); vi.mocked(localizeRecoveredImages).mockClear();
    await recoverPidoiImage(row().id, { automatic: true });
    await recoverPidoiImage(row().id, { automatic: true });
    expect(row().status).toBe('review');
    expect(JSON.parse(row().metadata).pidoiRecoveryPauseReason).toContain('30 分钟');
    if (stage === 'download') expect(JSON.parse(row().metadata).upstreamImageUrls).toEqual(['https://storage.test/cat.png']);
    expect(f).not.toHaveBeenCalled(); expect(localizeRecoveredImages).not.toHaveBeenCalled();
    expect(balance()).toBeCloseTo(99.78);
  });
  it('多张图片部分明确拒绝时只结算成功部分，其余自动退款，不再留在待核实',async()=>{
    const f=vi.fn().mockResolvedValueOnce(Response.json({code:'success',data:{task_id:'task_first',status:'IN_PROGRESS'}}))
      .mockResolvedValueOnce(Response.json({error:{message:'Content rejected'}},{status:451}))
      .mockResolvedValueOnce(Response.json({code:'success',data:{task_id:'task_first',status:'SUCCESS',result_url:'https://storage.test/first.png'}}));
    vi.stubGlobal('fetch',f);await generate(3);
    await vi.waitFor(()=>expect(row().status).toBe('completed'));
    expect(row().cost).toBeCloseTo(.22);expect(balance()).toBeCloseTo(99.78);
    expect(reservation()).toMatchObject({state:'settled',actual:.22});
    expect(JSON.parse(row().metadata)).toMatchObject({refundAmount:.44,requiresReview:false,failedImageIndexes:[1,2]});
    expect(f.mock.calls.map(c=>c[1].method)).toEqual(['POST','POST','GET']);
    await recoverPidoiImage(row().id);expect(balance()).toBeCloseTo(99.78);
  });
  it.each(['SUCCESS','FAILURE'])('兼容 502 包含任务 JSON 时继续 GET，最终 %s 正确结算', async status => {
    const f=vi.fn().mockResolvedValueOnce(new Response('Not Found',{status:404}))
      .mockResolvedValueOnce(Response.json({error:{message:JSON.stringify({id:'task_embedded',status:'queued',task_url:'/v1/image/generations/task_embedded'})}},{status:502}))
      .mockResolvedValueOnce(Response.json({code:'success',data:{task_id:'task_embedded',status,result_url:'https://storage.test/cat.png',fail_reason:status==='FAILURE'?'Rejected':''}}));
    vi.stubGlobal('fetch',f);
    await generate();
    await vi.waitFor(()=>expect(row().status).toBe(status==='SUCCESS'?'completed':'failed'));
    const meta=JSON.parse(row().metadata);
    expect(meta.upstreamTaskId).toBe('task_embedded');
    expect(meta.upstreamResponses[0]).toMatchObject({id:'task_embedded',httpStatus:502,state:'captured'});
    expect(f.mock.calls.map(c=>c[1].method)).toEqual(['POST','POST','GET']);
    expect(balance()).toBeCloseTo(status==='SUCCESS'?99.78:100);
    await recoverPidoiImage(row().id);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('旧记录从截断错误消息找回 ID 并恢复原任务，不重新提交',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('connection lost')));
    await generate(); await vi.waitFor(()=>expect(pidoiImageActive.size).toBe(0));
    const r=row(),m=JSON.parse(r.metadata);
    m.submissionFailure={stage:'submit',index:0,httpStatus:502,message:'Pidoi 图片提交失败 (502)：{"created":123,"id":"task_old","status":"queued","task_ur'};
    sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?').run(JSON.stringify(m),r.id);
    const f=vi.fn().mockResolvedValue(Response.json({code:'success',data:{task_id:'task_old',status:'SUCCESS',result_url:'https://storage.test/old.png'}}));
    vi.stubGlobal('fetch',f);
    await recoverPidoiImage(r.id);
    expect(row().status).toBe('completed');expect(balance()).toBeCloseTo(99.78);
    expect(f).toHaveBeenCalledExactlyOnceWith('https://pidoi.com/v1/image/generations/task_old',expect.objectContaining({method:'GET'}));
    expect(JSON.parse(row().metadata).upstreamTaskId).toBe('task_old');
  });

  async function unknownSubmission() {
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('connection lost')));
    await generate(); await vi.waitFor(()=>expect(pidoiImageActive.size).toBe(0));
    return row().id;
  }
  const manualTaskId = '202610270216552661065508268d9d6IpacyOdT';
  const originalTaskResponse = (status = 'SUCCESS', taskId = manualTaskId) => Response.json({code:'success',data:{task_id:taskId,status,
    result_url:status==='SUCCESS'?'https://cdn.test/original.png':'',fail_reason:status==='FAILURE'?'upstream rejected image':''}});
  it('上游明确要求核查时保存已验证编号并暂停，不能假装仍自动生成',async()=>{
    const id=await unknownSubmission();
    const f=vi.fn().mockResolvedValue(Response.json({code:'success',message:'任务执行中断，需要管理员核查结果',data:{task_id:manualTaskId,status:'IN_PROGRESS',recovery_required:true}}));
    vi.stubGlobal('fetch',f);
    const result=await supplementPidoiImageTask(id,9,manualTaskId);
    expect(result.status).toBe('review');expect(result.message).toContain('任务执行中断');
    expect(JSON.parse(row().metadata).upstreamTaskId).toBe(manualTaskId);
    await recoverPidoiImage(id,{automatic:true});expect(f).toHaveBeenCalledTimes(1);expect(balance()).toBeCloseTo(99.78);
  });
  it('原任务返回站内鉴权下载地址时，将原身份限定交给图片保存器',async()=>{
    const id=await unknownSubmission();
    const source=`/v1/image/generations/${manualTaskId}/content?index=0`;
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({code:'success',data:{task_id:manualTaskId,status:'SUCCESS',result_url:source}})));
    await supplementPidoiImageTask(id,9,manualTaskId);
    expect(localizeRecoveredImages).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({url:source,auth:{baseUrl:'https://pidoi.com',apiKey:'test-key',taskId:manualTaskId}})],id,1,expect.any(String));
    expect(row().status).toBe('completed');expect(balance()).toBeCloseTo(99.78);expect(row().metadata).not.toContain('test-key');
  });
  it('后台补录无 task_ 前缀的真实任务 ID，通过原渠道只读查询后保存图片并沿用预扣', async()=>{
    vi.stubEnv('PIDOI_IMAGE_REQUEST_MODE','sync');
    const id = await unknownSubmission();
    const f = vi.fn().mockResolvedValue(originalTaskResponse()); vi.stubGlobal('fetch',f);
    const layer=adminRouter.stack.find((layer:any)=>layer.route?.path==='/:id/image-supplement-task') as any;
    const res:any={setHeader:vi.fn(),json:vi.fn(),status:vi.fn().mockReturnThis()};
    await layer.route.stack.at(-1).handle({userId:9,params:{id},body:{taskId:manualTaskId}},res);
    expect(res.status).not.toHaveBeenCalled(); expect(res.json).toHaveBeenCalledWith(expect.objectContaining({status:'completed'}));
    expect(row()).toMatchObject({status:'completed',cost:0.22,result_url:'/api/uploads/result.png'});
    expect(JSON.parse(row().metadata)).toMatchObject({upstreamTaskId:manualTaskId,pidoiTaskSupplement:{adminId:9,taskId:manualTaskId,verifiedStatus:'completed'}});
    expect(reservation()).toMatchObject({state:'settled',actual:0.22}); expect(balance()).toBeCloseTo(99.78);
    expect(f).toHaveBeenCalledExactlyOnceWith(`https://pidoi.com/v1/image/generations/${manualTaskId}`,expect.objectContaining({method:'GET',headers:expect.objectContaining({Authorization:'Bearer test-key'})}));
    await supplementPidoiImageTask(id,9,manualTaskId); await recoverPidoiImage(id);
    expect(f).toHaveBeenCalledTimes(1); expect(localizeRecoveredImages).toHaveBeenCalledTimes(1); expect(balance()).toBeCloseTo(99.78);
  });
  it.each([401,403,404,502])('查询 HTTP %s 不污染原任务编号或锁住退款，随后可更正再恢复',async http=>{
    const id=await unknownSubmission(), before=row();
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({error:{message:'Invalid token'}},{status:http})));
    const layer=adminRouter.stack.find((layer:any)=>layer.route?.path==='/:id/image-supplement-task') as any;
    const res:any={setHeader:vi.fn(),json:vi.fn(),status:vi.fn().mockReturnThis()};
    await layer.route.stack.at(-1).handle({userId:9,params:{id},body:{taskId:manualTaskId}},res);
    expect(res.status).toHaveBeenCalledWith(502); // not a local session-expired response
    expect(res.json.mock.calls[0][0].error).toContain(`HTTP ${http}`);
    expect(res.json.mock.calls[0][0].error).toContain('Invalid token');
    expect(res.json.mock.calls[0][0].error).not.toContain('test-key');
    expect(row()).toEqual(before); expect(reservation().state).toBe('review'); expect(balance()).toBeCloseTo(99.78);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(originalTaskResponse()));
    await supplementPidoiImageTask(id,9,manualTaskId); expect(row().status).toBe('completed'); expect(balance()).toBeCloseTo(99.78);
  });
  it('补录查询失败后仍能通过原有确认失败入口退款，重复退款不会多退',async()=>{
    const id=await unknownSubmission();
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({error:{message:'Invalid token'}},{status:401})));
    await expect(supplementPidoiImageTask(id,9,manualTaskId)).rejects.toThrow('Invalid token');
    confirmPidoiImageFailure(id,9,true,'管理员另行核对上游，确认没有交付图片');
    expect(row()).toMatchObject({status:'failed',cost:0});expect(balance()).toBe(100);
    confirmPidoiImageFailure(id,9,true,'重复点击同一笔退款确认'); expect(balance()).toBe(100);
  });
  it('核实成功后下载失败保留原回执，重启恢复直接下载、不再查询或扣费',async()=>{
    const id=await unknownSubmission();
    const f=vi.fn().mockResolvedValue(originalTaskResponse());vi.stubGlobal('fetch',f);
    vi.mocked(localizeRecoveredImages).mockResolvedValueOnce({urls:[],issues:['暂不可用'],failures:[new Error('HTTP 503')]});
    expect(await supplementPidoiImageTask(id,9,manualTaskId)).toMatchObject({status:'processing'});
    expect(JSON.parse(row().metadata)).toMatchObject({upstreamTaskId:manualTaskId,pidoiImageJobs:[{sourceUrl:'https://cdn.test/original.png',status:'completed'}]});
    expect(balance()).toBeCloseTo(99.78);expect(reservation().state).toBe('review');
    expect(()=>confirmPidoiImageFailure(id,9,true,'已知成功图片不能退款')).toThrow();
    await recoverPidoiImage(id,{automatic:true});
    expect(row().status).toBe('completed');expect(f).toHaveBeenCalledTimes(1);expect(balance()).toBeCloseTo(99.78);
  });
  it('查到进行中的任务，保存核实后的 ID 并由后台继续查原任务',async()=>{
    const id=await unknownSubmission();
    const f=vi.fn().mockResolvedValueOnce(originalTaskResponse('IN_PROGRESS')).mockResolvedValueOnce(originalTaskResponse());vi.stubGlobal('fetch',f);
    await supplementPidoiImageTask(id,9,manualTaskId);expect(row().status).toBe('processing');expect(f).toHaveBeenCalledTimes(1);
    await recoverPidoiImage(id,{automatic:true});expect(row().status).toBe('completed');expect(balance()).toBeCloseTo(99.78);
    expect(f.mock.calls.every(call=>call[1].method==='GET')).toBe(true);
  });
  it('核实到原任务明确失败，按原账本退款一次',async()=>{
    const id=await unknownSubmission();
    const f=vi.fn().mockResolvedValue(originalTaskResponse('FAILURE'));vi.stubGlobal('fetch',f);
    await supplementPidoiImageTask(id,9,manualTaskId);
    expect(row()).toMatchObject({status:'failed',cost:0});expect(reservation().state).toBe('refunded');expect(balance()).toBe(100);
    await expect(supplementPidoiImageTask(id,9,manualTaskId)).rejects.toThrow();
    await recoverPidoiImage(id);expect(balance()).toBe(100);expect(f).toHaveBeenCalledTimes(1);
  });
  it.each(['different_task',''])('响应 ID 不一致或缺失不能绑定或恢复：%s',async returnedId=>{
    const id=await unknownSubmission(),before=row();
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(originalTaskResponse('SUCCESS',returnedId)));
    await expect(supplementPidoiImageTask(id,9,manualTaskId)).rejects.toThrow();
    expect(row()).toEqual(before);expect(balance()).toBeCloseTo(99.78);expect(localizeRecoveredImages).not.toHaveBeenCalled();
  });
  it('任务补录查询期间阻止并发退款和补录，禁止占用其他订单的任务',async()=>{
    const id=await unknownSubmission(); let finish!:(value:Response)=>void;
    vi.stubGlobal('fetch',vi.fn().mockReturnValue(new Promise(resolve=>{finish=resolve;})));
    const first=supplementPidoiImageTask(id,9,manualTaskId);
    await expect(supplementPidoiImageTask(id,9,manualTaskId)).rejects.toThrow('正在提交');
    expect(()=>confirmPidoiImageFailure(id,9,true,'仍在查询时不能退款')).toThrow('正在提交或恢复');
    sqlite.prepare("INSERT INTO contents(user_id,type,status,metadata) VALUES(1,'image','completed',?)").run(JSON.stringify({channelId:6,upstreamTaskId:manualTaskId}));
    finish(originalTaskResponse()); await expect(first).rejects.toThrow('已关联订单');
    expect((sqlite.prepare('SELECT status FROM contents WHERE id=?').get(id) as any).status).toBe('review');expect(balance()).toBeCloseTo(99.78);
  });
  it('同步结果丢失后通过后台补录原图片，原预扣结算且刷新、重复补录均不重复扣费', async () => {
    vi.stubEnv('PIDOI_IMAGE_REQUEST_MODE', 'sync');
    const id = await unknownSubmission();
    const networkCalls = vi.mocked(fetch).mock.calls.length;
    const layer = adminRouter.stack.find((layer: any) => layer.route?.path === '/:id/image-supplement-result') as any;
    const response: any = { setHeader: vi.fn(), json: vi.fn(), status: vi.fn().mockReturnThis() };
    await layer.route.stack.at(-1).handle({ userId: 9, params: { id }, body: { urls: ['https://cdn.test/original.png'] } }, response);
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', alreadyResolved: false }));
    expect(row()).toMatchObject({ status: 'completed', cost: 0.22, result_url: '/api/uploads/result.png' });
    expect(reservation()).toMatchObject({ state: 'settled', actual: 0.22, amount: 0.22 });
    expect(balance()).toBeCloseTo(99.78);
    expect(JSON.parse(row().metadata)).toMatchObject({ imageUrls: ['/api/uploads/result.png'], requiresReview: false,
      pidoiResultSupplement: { adminId: 9, amount: 0.22, count: 1 } });
    expect(await supplementPidoiImageResults(id, 9, ['https://cdn.test/original.png'])).toMatchObject({ alreadyResolved: true });
    await recoverPidoiImage(id);
    expect(balance()).toBeCloseTo(99.78); expect(fetch).toHaveBeenCalledTimes(networkCalls);
    expect(localizeRecoveredImages).toHaveBeenCalledExactlyOnceWith([{url:'https://cdn.test/original.png',channelId:0,channelApiKeyId:null}], id, 1, expect.any(String));
    expect(() => confirmPidoiImageFailure(id, 9, true, '不能再次退回已完成任务费用')).toThrow();
  });
  it('补录下载失败保持原预扣与状态，明确展示 HTTP 原因并隐藏签名链接', async () => {
    const id = await unknownSubmission(); const before = row();
    vi.mocked(localizeRecoveredImages).mockResolvedValue({ urls: [], issues: ['图片保存暂不可用'], failures: [new Error('HTTP 404 https://cdn.test/a?signature=secret-value')] });
    const error = await supplementPidoiImageResults(id, 9, ['https://cdn.test/a']).catch(error => error);
    expect(error.status).toBe(422); expect(error.message).toContain('404'); expect(error.message).not.toContain('secret-value');
    expect(row()).toEqual(before); expect(balance()).toBeCloseTo(99.78); expect(reservation().state).toBe('review');
  });
  it('补录保存与原账本结算必须原子完成，写订单失败时回滚', async () => {
    const id = await unknownSubmission();
    sqlite.exec("CREATE TRIGGER reject_success BEFORE UPDATE OF status ON contents WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'test persist failure'); END;");
    try { await expect(supplementPidoiImageResults(id, 9, ['https://cdn.test/a'])).rejects.toThrow('test persist failure'); }
    finally { sqlite.exec('DROP TRIGGER reject_success'); }
    expect(reservation().state).toBe('review'); expect(row().status).toBe('review'); expect(balance()).toBeCloseTo(99.78);
    expect(JSON.parse(row().metadata).pidoiResultSupplement).toBeUndefined();
  });
  it('下载期间并发补录、退款与恢复不会重复处理；下载后再次核对账本', async () => {
    const id = await unknownSubmission();
    let finish!: (value: any) => void;
    vi.mocked(localizeRecoveredImages).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const pending = supplementPidoiImageResults(id, 9, ['https://cdn.test/a']);
    await expect(supplementPidoiImageResults(id, 9, ['https://cdn.test/a'])).rejects.toThrow('正在提交');
    expect(() => confirmPidoiImageFailure(id, 9, true, '下载中不能退回原始预扣')).toThrow('正在提交或恢复');
    const calls = vi.mocked(fetch).mock.calls.length; await recoverPidoiImage(id); expect(fetch).toHaveBeenCalledTimes(calls);
    // Simulate reconciliation in another process; completion must not overwrite it.
    sqlite.prepare("UPDATE billing_reservations SET state='refunded' WHERE id=?").run(reservation().id);
    finish({urls:['/api/uploads/a.png'],issues:[],failures:[]});
    await expect(pending).rejects.toThrow('已退款');
    expect(row().status).toBe('review'); expect(reservation().state).toBe('refunded'); expect(pidoiImageActive.size).toBe(0);
  });
  it('已经退款的订单不能通过补录再次扣费', async () => {
    const id = await unknownSubmission(); confirmPidoiImageFailure(id, 9, true, '已核实失败，先退回原预扣');
    await expect(supplementPidoiImageResults(id, 9, ['https://cdn.test/a'])).rejects.toThrow();
    expect(balance()).toBe(100); expect(localizeRecoveredImages).not.toHaveBeenCalled(); expect(row().status).toBe('failed');
  });
  it('补录沿用原组织预扣，用户更换组织也不再扣个人或新组织余额', async () => {
    sqlite.exec('DELETE FROM organizations; INSERT INTO organizations(id,balance) VALUES(21,10),(22,20); UPDATE users SET org_id=21 WHERE id=1;');
    const id = await unknownSubmission(); sqlite.exec('UPDATE users SET org_id=22 WHERE id=1;');
    await supplementPidoiImageResults(id, 9, ['https://cdn.test/a']);
    expect(balance()).toBe(100); expect((sqlite.prepare('SELECT balance FROM organizations WHERE id=21').get() as any).balance).toBeCloseTo(9.78);
    expect((sqlite.prepare('SELECT balance FROM organizations WHERE id=22').get() as any).balance).toBe(20);
    expect(reservation().state).toBe('settled');
  });
  it('补录拒绝越权、不合法链接、数量不符及账本归属不符', async () => {
    const id = await unknownSubmission();
    await expect(supplementPidoiImageResults(id, 1, ['https://cdn.test/a'])).rejects.toThrow('超级管理员');
    for (const urls of [[], ['https://cdn.test/a', 'https://cdn.test/b'], ['file:///etc/passwd'], ['https://user:password@cdn.test/a'], ['bad url']])
      await expect(supplementPidoiImageResults(id, 9, urls)).rejects.toThrow();
    sqlite.prepare('UPDATE billing_reservations SET context=? WHERE id=?').run(JSON.stringify({userId:2,contentId:id}), reservation().id);
    await expect(supplementPidoiImageResults(id, 9, ['https://cdn.test/a'])).rejects.toThrow('归属不一致');
    expect(localizeRecoveredImages).not.toHaveBeenCalled(); expect(balance()).toBeCloseTo(99.78);
  });
  it('多图订单未保存完整数量不能按全额恢复成功', async () => {
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('connection lost')));
    await generate(2); await vi.waitFor(()=>expect(pidoiImageActive.size).toBe(0));
    const id = row().id;
    await expect(supplementPidoiImageResults(id, 9, ['https://cdn.test/a', 'https://cdn.test/b'])).rejects.toThrow('保存图片数量不足');
    expect(row().status).toBe('review'); expect(balance()).toBeCloseTo(99.56);
    vi.mocked(localizeRecoveredImages).mockResolvedValue({urls:['/api/uploads/a.png','/api/uploads/b.png'],issues:[],failures:[]});
    await supplementPidoiImageResults(id, 9, ['https://cdn.test/a', 'https://cdn.test/b']);
    expect(row()).toMatchObject({status:'completed',cost:0.44}); expect(balance()).toBeCloseTo(99.56);
  });
  it('管理员核实退款与任务终止原子完成，重复操作和后台扫描均不再退款',async()=>{
    const id=await unknownSubmission();
    const result=confirmPidoiImageFailure(id,9,true,'已核对上游记录，未产生任何图片');
    expect(result).toMatchObject({alreadyResolved:false,refundedAmount:0.22});
    expect(row()).toMatchObject({status:'failed',cost:0});expect(balance()).toBe(100);
    expect(reservation().state).toBe('refunded');
    expect(sqlite.prepare('SELECT admin_id FROM billing_resolution_audit WHERE reservation_id=?').get(reservation().id)).toEqual({admin_id:9});
    expect(confirmPidoiImageFailure(id,9,true,'再次点击确认相同失败记录').alreadyResolved).toBe(true);
    await recoverPidoiImage(id);expect(balance()).toBe(100);
    expect(JSON.parse(row().metadata)).toMatchObject({requiresReview:false,refundTarget:'user_balance',pidoiFailureResolution:{adminId:9}});
  });
  it('任务更新失败时回滚余额、账单与审核记录',async()=>{
    const id=await unknownSubmission();
    sqlite.exec("CREATE TRIGGER reject_failure BEFORE UPDATE OF status ON contents WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'test failure'); END;");
    try { expect(()=>confirmPidoiImageFailure(id,9,true,'核实未成功，测试原子退款')).toThrow('test failure'); }
    finally { sqlite.exec('DROP TRIGGER reject_failure'); }
    expect(balance()).toBeCloseTo(99.78);expect(row().status).toBe('review');expect(reservation().state).toBe('review');
    expect(sqlite.prepare('SELECT id FROM billing_resolution_audit WHERE reservation_id=?').get(reservation().id)).toBeUndefined();
  });
  it('组织退款返回最初扣款组织，不随用户当前归属变化',async()=>{
    sqlite.exec('DELETE FROM organizations; INSERT INTO organizations(id,balance) VALUES(21,10),(22,20); UPDATE users SET org_id=21 WHERE id=1;');
    const id=await unknownSubmission();
    sqlite.exec('UPDATE users SET org_id=22 WHERE id=1;');
    confirmPidoiImageFailure(id,9,true,'核实未成功，退回原始组织');
    expect(sqlite.prepare('SELECT balance FROM organizations WHERE id=21').get()).toEqual({balance:10});
    expect(sqlite.prepare('SELECT balance FROM organizations WHERE id=22').get()).toEqual({balance:20});
    expect(balance()).toBe(100);expect(JSON.parse(row().metadata).refundTarget).toBe('organization_balance');
  });
  it('拒绝无权限、缺少确认、运行中、账单归属错误的退款',async()=>{
    const id=await unknownSubmission();
    expect(()=>confirmPidoiImageFailure(id,1,true,'普通用户试图申请后台退款')).toThrow('超级管理员');
    expect(()=>confirmPidoiImageFailure(id,9,false,'没有确认上游状态不能退款')).toThrow('核实依据');
    expect(()=>confirmPidoiImageFailure(id,9,true,'短')).toThrow('核实依据');
    pidoiImageActive.add(id);
    expect(()=>confirmPidoiImageFailure(id,9,true,'后台仍在恢复中不可退款')).toThrow('正在提交或恢复');
    pidoiImageActive.delete(id);
    const bill=reservation();
    sqlite.prepare('UPDATE billing_reservations SET context=? WHERE id=?').run(JSON.stringify({userId:9,contentId:id}),bill.id);
    expect(()=>confirmPidoiImageFailure(id,9,true,'账单归属异常不可进行退款')).toThrow('归属不一致');
    expect(balance()).toBeCloseTo(99.78);expect(row().status).toBe('review');
  });
  it('阻止已成功或部分成功任务全额退款，查询只检查原任务',async()=>{
    const id=await unknownSubmission();
    const m=JSON.parse(row().metadata);m.pidoiImageJobs=[{taskId:'task_known',index:0,status:'completed',sourceUrl:'https://storage.test/good.png'}];
    sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?').run(JSON.stringify(m),id);
    expect(()=>confirmPidoiImageFailure(id,9,true,'部分图片已经生成，不能全额退款')).toThrow('已有成功结果');
    const f=vi.fn().mockResolvedValue(Response.json({code:'success',data:{task_id:'task_known',status:'SUCCESS',result_url:'https://storage.test/good.png'}}));
    vi.stubGlobal('fetch',f);
    expect(await recheckPidoiImage(id,9)).toMatchObject({status:'completed'});
    expect(f.mock.calls.every(c=>c[1].method==='GET')).toBe(true);
    expect(balance()).toBeCloseTo(99.78);
  });
  it('异步入口不存在时，网站使用与 API 相同的入口生成并下载，最终同步成功', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('404 page not found', { status: 404 }))
      .mockResolvedValueOnce(Response.json({ data: [{ url: 'https://storage.test/cat.png?signature=x' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const { res, chunks } = await generate();
    expect(res.writableEnded).toBe(true);
    expect(chunks.join('')).toContain('"background":true');
    await vi.waitFor(() => expect(row().status).toBe('completed'));
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['https://pidoi.com/v1/image/generations', 'https://pidoi.com/v1/images/generations']);
    const metadata = JSON.parse(row().metadata);
    expect(metadata.upstreamTaskIds).toEqual([]);
    expect(metadata.upstreamResponses[0]).toMatchObject({ httpStatus: 200, state: 'response_without_id' });
    expect(metadata.pidoiImageJobs[0]).toMatchObject({ protocol: 'openai-compatible', sourceUrl: 'https://storage.test/cat.png?signature=x' });
    expect(row().result_url).toBe('/api/uploads/result.png');
    expect(balance()).toBeCloseTo(99.78);
    expect(reservation()).toMatchObject({ state: 'settled', actual: 0.22 });
  });

  it('明确拒绝后结束失败并全额退款，不再卡在待核实', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: { message: 'Model not found' } }, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    await generate();
    await vi.waitFor(() => expect(row().status).toBe('failed'));
    expect(JSON.parse(row().metadata).submissionFailure).toMatchObject({ httpStatus: 404, confirmedFailure: true });
    expect(reservation().state).toBe('refunded');
    expect(balance()).toBe(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localizeRecoveredImages).not.toHaveBeenCalled();
  });

  it('兼容入口返回 403 后同样退款，不再尝试第三次提交', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(Response.json({ error: { message: 'Invalid token' } }, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    await generate();
    await vi.waitFor(() => expect(row().status).toBe('failed'));
    expect(reservation().state).toBe('refunded');
    expect(balance()).toBe(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('传输中断只核实原请求，不自动退款和重新生成', async () => {
    const fetchMock = vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
    vi.stubGlobal('fetch', fetchMock);
    await generate();
    await vi.waitFor(() => expect(row().status).toBe('review'));
    expect(balance()).toBeCloseTo(99.78);
    expect(reservation().state).toBe('review');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('兼容入口明确返回 451 时结束失败、退回预占费用且不重新提交', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(Response.json({ error: { code: 'content_policy_violation', message: 'Content rejected' } }, { status: 451 }));
    vi.stubGlobal('fetch', fetchMock);
    await generate();
    await vi.waitFor(() => expect(row().status).toBe('failed'));
    expect(row().cost).toBe(0);
    expect(JSON.parse(row().metadata)).toMatchObject({ billingStatus: 'refunded',
      submissionFailure: { httpStatus: 451, confirmedFailure: true },
      upstreamResponses: [{ httpStatus: 451, state: 'response_without_id' }] });
    expect(reservation().state).toBe('refunded');
    expect(balance()).toBe(100);
    await recoverPidoiImage(row().id);
    expect(balance()).toBe(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(localizeRecoveredImages).not.toHaveBeenCalled();
  });

  async function legacy451(overrides: Record<string, any> = {}) {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection lost')));
    await generate();
    await vi.waitFor(() => expect(pidoiImageActive.size).toBe(0));
    const r = row();
    const metadata = { ...JSON.parse(r.metadata), pidoiSubmissionProtocol: 'openai-compatible',
      upstreamResponses: [{ id: '', httpStatus: 451, state: 'response_without_id' }],
      submissionFailure: { stage: 'submit', index: 0, httpStatus: 451, confirmedFailure: false, message: 'Content rejected (451)' },
      ...overrides };
    sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?').run(JSON.stringify(metadata), r.id);
    vi.mocked(fetch).mockClear();
    return r.id;
  }

  it('旧版误判的单张 451 任务自动修正并且并发/重复恢复只退款一次', async () => {
    const id = await legacy451();
    expect(balance()).toBeCloseTo(99.78);
    await Promise.all([recoverPidoiImage(id), recoverPidoiImage(id)]);
    await recoverPidoiImage(id);
    expect(row()).toMatchObject({ status: 'failed', cost: 0 });
    expect(JSON.parse(row().metadata)).toMatchObject({ billingStatus: 'refunded', requiresReview: false,
      submissionFailure: { confirmedFailure: true }, failureClassificationCorrection: { reason: 'http_451_rejection' } });
    expect(reservation().state).toBe('refunded');
    expect(balance()).toBe(100);
    expect(fetch).not.toHaveBeenCalled();
    expect(localizeRecoveredImages).not.toHaveBeenCalled();
  });

  it.each([
    { count: 2 }, { upstreamTaskId: 'task_accepted' }, { upstreamTaskIds: ['task_accepted'] },
    { upstreamImageUrls: ['https://storage.test/image.png'] }, { imageUrls: ['/api/uploads/image.png'] },
    { submissionFailure: { stage: 'poll', httpStatus: 451 } },
    { upstreamResponses: [{ id: '', httpStatus: 500, state: 'response_without_id' }] },
    { pidoiSubmissionProtocol: 'async' }, { managedSpecification: true },
  ])('不对有受理证据、多图或证据不匹配的旧任务退款：%j', async overrides => {
    const id = await legacy451(overrides);
    await recoverPidoiImage(id);
    expect(row().status).toBe('review');
    expect(balance()).toBeCloseTo(99.78);
    expect(reservation().state).toBe('review');
    expect(JSON.parse(row().metadata).failureClassificationCorrection).toBeUndefined();
    if ('upstreamTaskId' in overrides || 'upstreamTaskIds' in overrides) expect(fetch).toHaveBeenCalledWith(expect.stringContaining('task_accepted'), expect.objectContaining({method:'GET'}));
    else expect(fetch).not.toHaveBeenCalled();
  });

  it('图片下载失败保存原结果，下次恢复只下载，不重新生成', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(Response.json({ data: [{ url: 'https://storage.test/cat.png' }] }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(localizeRecoveredImages).mockResolvedValueOnce({ urls: [], issues: ['download error'], failures: [new Error('fetch failed')] });
    await generate();
    await vi.waitFor(() => expect(pidoiImageActive.size).toBe(0));
    expect(row().status).toBe('processing');
    expect(reservation().state).toBe('reserved');
    expect(JSON.parse(row().metadata).upstreamImageUrls).toEqual(['https://storage.test/cat.png']);
    await recoverPidoiImage(row().id);
    expect(row().status).toBe('completed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(localizeRecoveredImages).toHaveBeenCalledTimes(2);
    expect(reservation().state).toBe('settled');
  });

  it('规格路由也能处理同样的 404 兼容入口，记录同步响应证据', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(Response.json({ data: [{ url: 'https://storage.test/cat.png' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const evidence = vi.fn(), submitted = vi.fn();
    const result = await generateSpecificationImage({ channel: { id: 6, baseUrl: 'https://pidoi.com', apiKey: 'test-key' },
      route: { executionModel: 'gpt-image-2', upstreamModel: 'gpt-image-2' } } as any,
    { prompt: 'cat', input: { ratio: '1:1', resolution: '4K' }, images: [], videos: [], audios: [], firstFrame: '', lastFrame: '', body: {}, publicBaseUrl: 'https://local.test' } as any,
    vi.fn(), submitted, evidence);
    expect(result.imageUrl).toBe('https://storage.test/cat.png');
    expect(submitted).not.toHaveBeenCalled();
    expect(evidence).toHaveBeenLastCalledWith({ id: '', httpStatus: 200, state: 'response_without_id' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
