import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/services/videoLocalizationService.js', () => ({ downloadAndLocalizeVideo: vi.fn(async () => '/uploads/videos/recovered.mp4') }));
import { db, sqlite } from '../server/db/index.js';
import { channels, contents, models, modelPricing, users } from '../server/db/schema.js';
import { ChannelService } from '../server/services/channelService.js';
import { handleSpecificationGeneration, resumeSpecificationTasks } from '../server/services/specificationGenerationService.js';
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService.js';
import { findVideoSubmissionReceipt } from '../server/services/videoSubmissionReceiptService.js';
import { acceptVideoSubmission } from '../server/services/videoSubmissionGuard.js';
import { cancelVideoContent } from '../server/services/videoCancellationService.js';
import { ZHIYING_BASE_URL } from '../shared/zhiyingVideo.js';

import { manualId, manualUpstream, manualCatalogRow, installManualZhiying } from './helpers/zhiyingManualModel.js';
afterAll(() => sqlite.close());
describe.each(['builtin', 'manual'])('%s registration', mode => {
const model = mode === 'manual' ? manualId : 'sd-2.5-fullblood-line2';
const upstream = mode === 'manual' ? manualUpstream : model;
const taskId = 'video_original_abcdefghijklmn';
const balance = () => db.select().from(users).get()!.balance;
const order = () => db.select().from(contents).get()!;
const meta = () => JSON.parse(order().metadata);
let channelId: number;
const sent: { key: string | null; body: string }[] = [];

beforeEach(async () => {
  for (const { name } of sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) sqlite.exec('DELETE FROM "' + name + '"');
  sent.length = 0;
  db.insert(users).values({ id: 1, username:'test', email:'recover@example.test', passwordHash:'unused', balance:100 }).run();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [mode === 'manual' ? manualCatalogRow : { id:model, media_type:'video', status:'available' }] })));
  channelId = ChannelService.createChannel({ name:'智赢', type:'zhiying', baseUrl:ZHIYING_BASE_URL, apiKey:'original-secret' });
  if (mode === 'manual') await installManualZhiying(channelId); else await ChannelService.syncModels(channelId);
  db.update(models).set({ isActive:1 }).where(eq(models.modelId,model)).run();
  db.insert(modelPricing).values({ modelPattern:model, billingType:'per_call', inputPrice:2, outputPrice:0 }).run();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function sendOrder(body: Record<string, unknown> = {}) {
  const req: any = { userId:1, headers:{}, protocol:'https', get:()=>'app.test', body:{model,prompt:'雨过天晴',seconds:7,...body} };
  const res: any = { setHeader:vi.fn(),flushHeaders:vi.fn(),write:vi.fn(),end:vi.fn(),status:vi.fn().mockReturnThis(),json:vi.fn() };
  await handleSpecificationGeneration(req,res,'video');
  return res;
}
async function loseFirstReceipt() {
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
    sent.push({key:new Headers(init.headers).get('Idempotency-Key'),body:String(init.body)});
    throw new TypeError('socket reset after request');
  }));
  await sendOrder();
  expect(sent).toHaveLength(1);
  expect(balance()).toBe(98);
  expect(meta()).toMatchObject({zhiyingOrder:true, requiresReview:true, videoSubmissionState:'unknown', zhiyingKey:sent[0].key});
  expect(JSON.stringify(meta())).not.toContain('original-secret');
  makeRecoveryDue();
}
function makeRecoveryDue() {
  db.update(contents).set({metadata:JSON.stringify({...meta(),zhiyingResumeAt:0})}).where(eq(contents.id,order().id)).run();
}

const reference = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM6sAAAAASUVORK5CYII=';
it('ends and refunds a rejected file upload before the paid submit lock or idempotency key is issued', async () => {
  const wire = vi.fn(async () => Response.json({error:{code:'invalid_file',message:'不支持的图像类型'}},{status:400}));
  vi.stubGlobal('fetch',wire);
  await sendOrder({reference_images:[reference]});
  expect(wire.mock.calls[0][0]).toBe(ZHIYING_BASE_URL+'/v1/files');
  expect(order().status).toBe('failed');
  expect(meta().zhiyingKey).toBeUndefined();
  expect(meta().error).toContain('不支持的图像类型');
  resumeSpecificationTasks();
  expect(wire).toHaveBeenCalledOnce();
  expect(balance()).toBe(100);
});

it('allows local cancellation while uploading and never submits the paid POST afterwards', async () => {
  let finishUpload!: (value:Response) => void;
  const wire = vi.fn(() => new Promise<Response>(resolve=>{finishUpload=resolve;}));
  vi.stubGlobal('fetch',wire);
  const pending = sendOrder({reference_images:[reference]});
  await vi.waitFor(() => expect(wire).toHaveBeenCalledTimes(1));
  cancelVideoContent(order().id,1);
  finishUpload(Response.json({id:'file_abcdefghijklmnopqrstuvwx'},{status:201}));
  await pending;
  expect(wire).toHaveBeenCalledOnce();
  expect(order().status).toBe('failed');
  expect(meta().cancelledBeforeSubmission).toBe(true);
  expect(balance()).toBe(100);
});
function task(status:string) {
  return Response.json({ id:taskId, object:'video',model:upstream,status,...(status === 'succeeded' ? {result_url:'https://media.example.test/clip.mp4'} : {}) },{status:202});
}

it('recovers a lost receipt with exactly the same payload and key and settles once across concurrent scans', async () => {
  await loseFirstReceipt();
  vi.stubGlobal('fetch',vi.fn(async (_url,init:RequestInit) => {
    sent.push({key:new Headers(init.headers).get('Idempotency-Key'),body:String(init.body)});
    return task('succeeded');
  }));
  resumeSpecificationTasks(); resumeSpecificationTasks();
  await vi.waitFor(() => expect(order().status).toBe('completed'));
  resumeSpecificationTasks();
  expect(sent).toEqual([sent[0],sent[0]]);
  expect(findVideoSubmissionReceipt(order().id)).toMatchObject({upstreamTaskId:taskId,channelId});
  expect(balance()).toBe(98);
  expect(downloadAndLocalizeVideo).toHaveBeenCalledOnce();
});

it('keeps the original reservation when the original credential changed', async () => {
  await loseFirstReceipt();
  db.update(channels).set({apiKey:'new-secret'}).where(eq(channels.id,channelId)).run();
  const wire = vi.fn();
  vi.stubGlobal('fetch',wire);
  resumeSpecificationTasks();
  await vi.waitFor(() => expect(meta().error).toContain('执行密钥已变更'));
  expect(wire).not.toHaveBeenCalled();
  expect(balance()).toBe(98);
});

it('keeps precharge and original identity when a replay cannot resolve the first POST', async () => {
  await loseFirstReceipt();
  vi.stubGlobal('fetch',vi.fn(async () => Response.json({error:{code:'idempotency_conflict',message:'不同参数',request_id:'req_test'}},{status:409})));
  resumeSpecificationTasks();
  await vi.waitFor(() => expect(meta().zhiyingReplayStopped).toBe(true));
  makeRecoveryDue(); resumeSpecificationTasks();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(balance()).toBe(98);
  expect(meta().error).toContain('不同参数');
  expect(order().status).not.toBe('failed');
});

it.each([{submissionStartedAt:'2000-01-01T00:00:00Z'}, {zhiyingReplayCount:3}])('stops automatic POST recovery at local time and attempt limits', async change => {
  await loseFirstReceipt();
  db.update(contents).set({metadata:JSON.stringify({...meta(),...change})}).where(eq(contents.id,order().id)).run();
  vi.stubGlobal('fetch',vi.fn());
  resumeSpecificationTasks();
  await vi.waitFor(() => expect(meta().zhiyingReplayStopped).toBe(true));
  expect(fetch).not.toHaveBeenCalled();
  expect(meta().error).toContain('最多3次');
  expect(balance()).toBe(98);
});

function storeAcceptedOriginal(extra: Record<string, unknown> = {}) {
  acceptVideoSubmission(order().id, taskId, {provider:'zhiying',channelId});
  db.update(contents).set({metadata:JSON.stringify({...meta(),submissionStartedAt:'2000-01-01T00:00:00Z',
    zhiyingReplayStopped:true, zhiyingResumeAt:0, ...extra})}).where(eq(contents.id,order().id)).run();
}

it('queries the saved upstream identity after the administrator changes the mapping', async () => {
  if (mode !== 'manual') return;
  await loseFirstReceipt(); storeAcceptedOriginal();
  const { listZhiyingModelConfigurations, saveZhiyingModelConfiguration } = await import('../server/services/zhiyingModelConfigurationService.js');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ ...manualCatalogRow, id: 'another-video', create_endpoint: '/v1/generations' }] })));
  const config = listZhiyingModelConfigurations(channelId)[0];
  await saveZhiyingModelConfiguration(channelId, { ...config, upstreamModel: 'another-video' }, config.version);
  const wire = vi.fn(async () => task('succeeded')); vi.stubGlobal('fetch', wire);
  resumeSpecificationTasks();
  await vi.waitFor(() => expect(order().status).toBe('completed'));
  expect(wire).toHaveBeenCalledOnce(); expect(wire.mock.calls[0][0]).toBe(ZHIYING_BASE_URL + '/v1/generations/' + taskId);
  expect(downloadAndLocalizeVideo).toHaveBeenCalledWith(expect.any(String), taskId, upstream, channelId, null, expect.any(Function), expect.any(String));
  expect(balance()).toBe(98);
});

it('finishes a rejection recorded just before a restart without issuing the paid POST again', async () => {
  await loseFirstReceipt();
  db.update(contents).set({metadata:JSON.stringify({...meta(),videoSubmissionState:'rejected',
    zhiyingFailure:{message:'原提交已明确拒绝，余额不足',httpStatus:402}})}).where(eq(contents.id,order().id)).run();
  vi.stubGlobal('fetch',vi.fn());
  resumeSpecificationTasks(); resumeSpecificationTasks();
  await vi.waitFor(() => expect(order().status).toBe('failed'));
  expect(fetch).not.toHaveBeenCalled();
  expect(balance()).toBe(100);
  expect(meta().error).toContain('余额不足');
});

it('queries an old accepted ID through a transport error and upstream review, then refunds the terminal failure once', async () => {
  await loseFirstReceipt();
  storeAcceptedOriginal();
  vi.useFakeTimers();
  const wire = vi.fn().mockResolvedValueOnce(new Response('gateway timeout',{status:504}))
    .mockResolvedValueOnce(task('review'))
    .mockResolvedValueOnce(Response.json({id:taskId,model:upstream,object:'video',status:'failed',error:{code:'test_declined',message:'原素材审核未通过'}}));
  vi.stubGlobal('fetch',wire);
  resumeSpecificationTasks(); resumeSpecificationTasks();
  await vi.advanceTimersByTimeAsync(50);
  expect(balance()).toBe(98);
  expect(meta().upstreamQueryError).toContain('504');
  await vi.advanceTimersByTimeAsync(8000);
  expect(meta()).toMatchObject({upstreamStatus:'review',requiresReview:false,videoId:taskId});
  expect(balance()).toBe(98);
  await vi.advanceTimersByTimeAsync(8000);
  resumeSpecificationTasks();
  expect(balance()).toBe(100);
  expect(order().status).toBe('failed');
  expect(meta().error).toContain('原素材审核未通过');
  expect(wire).toHaveBeenCalledTimes(3);
  for (const [url,init] of wire.mock.calls) {
    expect(String(url)).toBe(ZHIYING_BASE_URL+'/v1/generations/'+taskId);
    expect(init.method || 'GET').toBe('GET');
  }
});

it('retains the completed receipt through a delivery failure and settles only after saving the original', async () => {
  await loseFirstReceipt();
  storeAcceptedOriginal({zhiyingCompletedReceipt:{taskId,resultUrl:'https://cdn.example.test/signed.mp4'},upstreamGenerated:true});
  vi.useFakeTimers();
  const wire=vi.fn();
  vi.stubGlobal('fetch',wire);
  vi.mocked(downloadAndLocalizeVideo).mockRejectedValueOnce(new Error('下载中断'));
  resumeSpecificationTasks();
  await vi.advanceTimersByTimeAsync(100);
  expect(meta().resultSaveError).toContain('下载中断');
  expect(balance()).toBe(98);
  expect(order().status).toBe('processing');
  await vi.advanceTimersByTimeAsync(8000);
  resumeSpecificationTasks();
  expect(order().status).toBe('completed');
  expect(balance()).toBe(98);
  expect(wire).not.toHaveBeenCalled();
  expect(downloadAndLocalizeVideo).toHaveBeenCalledTimes(2);
});

});
