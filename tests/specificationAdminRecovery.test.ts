import { persistVideoSubmissionReceipt } from '../server/services/videoSubmissionReceiptService.js';
import { beforeEach, afterEach, afterAll, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/services/videoLocalizationService.js', () => ({ downloadAndLocalizeVideo: vi.fn(async () => '/uploads/huss-original.mp4') }));
import { db, sqlite } from '../server/db/index.js';
import { users, contents, channels } from '../server/db/schema.js';
import { eq } from 'drizzle-orm';
import { reserveUserCharge, linkReservationContent } from '../server/services/billingReservation.js';
import { resumeSpecificationTasks } from '../server/services/specificationGenerationService.js';
import { VideoRecoveryService } from '../server/services/videoRecoveryService.js';
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService.js';
let id: number, reservationId: string;
const saved = () => db.select().from(contents).where(eq(contents.id, id)).get()!;
const balance = () => db.select().from(users).where(eq(users.id, 1)).get()!.balance;
const change = (values: any) => db.update(contents).set({ metadata: JSON.stringify({ ...JSON.parse(saved().metadata), ...values }) }).where(eq(contents.id, id)).run();
beforeEach(() => {
  vi.clearAllMocks();
  if (sqlite.prepare("SELECT name FROM sqlite_master WHERE name='video_submission_receipts'").get()) sqlite.exec('DELETE FROM video_submission_receipts');
  vi.mocked(downloadAndLocalizeVideo).mockReset().mockResolvedValue('/uploads/huss-original.mp4');
  db.delete(contents).run(); db.delete(channels).run(); db.delete(users).run();
  db.insert(users).values({ id: 1, email: 'recovery@test.invalid', username: 'test', passwordHash: 'test', balance: 100 }).run();
  db.insert(channels).values({ id: 1, name: 'HUSS', type: 'huss', baseUrl: 'https://www.huss.top', apiKey: 'private-key', status: 1 }).run();
  id = Number(db.insert(contents).values({ userId: 1, type: 'video', modelId: 'bb-2.5-301010', title: 'original', status: 'review', cost: 6, metadata: '{}' }).run().lastInsertRowid);
  const charge = reserveUserCharge(1, 6, 'specification_generate', { contentId: id }); reservationId = charge.id;
  linkReservationContent(charge.id, id);
  change({ managedSpecification: true, channelId: 1, videoId: 'task_original', actualModel: 'bb-2.5-301010', requestedModel: 'bb-2.5-301010',
    billingReservationId: charge.id, reservedCost: 6, count: 1, requiresReview: true, reviewKind: 'query' });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
afterAll(() => sqlite.close());
it('routes the existing admin recover entry through HUSS and its original reservation', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    expect(url).toBe('https://www.huss.top/v1/videos/task_original'); expect(init?.method).toBe('GET');
    return Response.json({ id: 'task_original', status: 'completed', url: 'https://cdn.example/result.mp4?signature=original' });
  }));
  expect(await VideoRecoveryService.recover(id)).toMatchObject({ status: 'processing', chargedAmount: 0 });
  await vi.waitFor(() => expect(saved().status).toBe('completed'));
  expect(balance()).toBe(94); expect(saved().cost).toBe(6);
  expect(sqlite.prepare('SELECT state,actual FROM billing_reservations WHERE id=?').get(reservationId)).toMatchObject({ state: 'settled', actual: 6 });
  expect(await VideoRecoveryService.recover(id)).toMatchObject({ status: 'completed', chargedAmount: 0 });
  expect(fetch).toHaveBeenCalledOnce(); expect(downloadAndLocalizeVideo).toHaveBeenCalledOnce();
});
it('uses the specification refund path once for a confirmed HUSS failed task', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'task_original', status: 'failed', error: { code: 'unsupported_material', message: '素材被拒绝' } })));
  await Promise.all([VideoRecoveryService.recover(id), VideoRecoveryService.recover(id)]);
  await vi.waitFor(() => expect(saved().status).toBe('failed'));
  expect(balance()).toBe(100); expect(saved().cost).toBe(0);
  expect(JSON.parse(saved().metadata).error).toContain('unsupported_material');
  await expect(VideoRecoveryService.recover(id)).rejects.toMatchObject({ status: 409 });
  expect(fetch).toHaveBeenCalledOnce(); expect(balance()).toBe(100);
});
it('continues polling storage pending, without submitting or charging again', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ status: 'completed', storage_status: 'pending' }))
    .mockResolvedValueOnce(Response.json({ status: 'completed', url: 'https://cdn.example/final.mp4' })));
  await VideoRecoveryService.recover(id); await vi.advanceTimersByTimeAsync(100);
  expect(saved().status).toBe('processing'); expect(JSON.parse(saved().metadata).progressText).toContain('正在保存成品');
  expect(downloadAndLocalizeVideo).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(15100);
  expect(saved().status).toBe('completed'); expect(balance()).toBe(94);
  expect(vi.mocked(fetch).mock.calls.every(call => call[1]?.method === 'GET')).toBe(true);
});
it.each(['ownership','amount','refunded','missing_id'])('rejects unsafe recovery %s before network or billing', async scenario => {
  if (scenario === 'ownership') sqlite.prepare('UPDATE billing_reservations SET context=? WHERE id=?').run(JSON.stringify({ contentId: id + 1, userId: 1 }), reservationId);
  if (scenario === 'amount') change({ reservedCost: 100 });
  if (scenario === 'refunded') sqlite.prepare("UPDATE billing_reservations SET state='refunded' WHERE id=?").run(reservationId);
  if (scenario === 'missing_id') change({ videoId: '' });
  vi.stubGlobal('fetch', vi.fn());
  await expect(VideoRecoveryService.recover(id)).rejects.toMatchObject({ status: 409 });
  expect(fetch).not.toHaveBeenCalled(); expect(balance()).toBe(94);
});
it('clears a previous download error only after original task save and settlement succeed', async () => {
  change({ resultSaveError: 'HUSS/TOS HTTP 403 AccessDenied: Request has expired' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'task_original', status: 'completed', url: 'https://cdn.example/result.mp4' })));
  await VideoRecoveryService.recover(id);
  await vi.waitFor(() => expect(saved().status).toBe('completed'));
  expect(JSON.parse(saved().metadata).resultSaveError).toBeNull();
  expect(balance()).toBe(94); expect(saved().cost).toBe(6);
});

it('recovers HSS missing ID through the original payload once, persists ID before polling and settles once', async () => {
  const snapshot = { model: 'hss-2.5-301010', prompt: 'original', duration: 4, ratio: '21:9', resolution: '720p', idempotency_key: 'persisted-key' };
  change({ videoId: '', upstreamModel: snapshot.model, actualModel: snapshot.model, reviewKind: 'submission', hussIdempotencyKey: 'persisted-key', hussPayload: snapshot });
  vi.stubGlobal('fetch', vi.fn(async (url, init: any) => {
    if (init.method === 'POST') {
      expect(url).toBe('https://www.huss.top/v1/videos');
      expect(init.headers['Idempotency-Key']).toBe('persisted-key');
      expect(JSON.parse(init.body)).toEqual({ model: snapshot.model, prompt: 'original', duration: 4, ratio: '21:9', resolution: '720p' });
      return Response.json({ id: 'video_original', status: 'queued' });
    }
    expect(url).toBe('https://www.huss.top/v1/videos/video_original');
    expect(JSON.parse(saved().metadata).upstreamTaskId).toBe('video_original');
    return Response.json({ id: 'video_original', status: 'completed', url: 'https://cdn.example/result.mp4' });
  }));
  await Promise.all([VideoRecoveryService.recover(id), VideoRecoveryService.recover(id)]);
  await vi.waitFor(() => expect(saved().status).toBe('completed'));
  expect(fetch).toHaveBeenCalledTimes(2); expect(balance()).toBe(94);
  expect(await VideoRecoveryService.recover(id)).toMatchObject({ chargedAmount: 0, status: 'completed' });
});
it('HSS failed task ends with detailed reason and a single refund', async () => {
  change({ videoId: 'video_failed', actualModel: 'hss-2.5-301010' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'video_failed', status: 'failed', phase: 'not_submitted', error: { code: 'QUEUE_EXPIRED', message: 'queue expired before submission' } })));
  await Promise.all([VideoRecoveryService.recover(id), VideoRecoveryService.recover(id)]);
  await vi.waitFor(() => expect(saved().status).toBe('failed'));
  expect(balance()).toBe(100); expect(JSON.parse(saved().metadata).error).toContain('QUEUE_EXPIRED');
  expect(fetch).toHaveBeenCalledOnce();
});

it('HSS temporary query unavailability honors Retry-After without refund or POST', async () => {
  vi.useFakeTimers();
  change({ videoId: 'video_original', actualModel: 'hss-2.5-301010' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ error: { code: 'auth_unavailable', message: '受理检查暂时不可用' } }, { status: 503, headers: { 'Retry-After': '90' } }))
    .mockResolvedValueOnce(Response.json({ id: 'video_original', status: 'completed', url: 'https://cdn.example/result.mp4' })));
  await VideoRecoveryService.recover(id); await vi.advanceTimersByTimeAsync(100);
  expect(JSON.parse(saved().metadata).upstreamQueryError).toContain('auth_unavailable');
  expect(balance()).toBe(94); expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(89000); expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000); expect(saved().status).toBe('completed');
  expect(vi.mocked(fetch).mock.calls.every(call => call[1]?.method === 'GET')).toBe(true);
  expect(balance()).toBe(94);
});

it('HSS keeps completed evidence and retries saving even if subsequent task queries would fail', async () => {
  vi.useFakeTimers(); change({ videoId: 'video_original', actualModel: 'hss-2.5-301010' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ id: 'video_original', status: 'completed', url: 'https://cdn.example/expired.mp4' }))
    .mockRejectedValue(new Error('task API offline')));
  vi.mocked(downloadAndLocalizeVideo).mockRejectedValueOnce(Object.assign(new Error('HTTP 403 signature expired'), { status: 403, retryAfterMs: 90000 }));
  await VideoRecoveryService.recover(id); await vi.advanceTimersByTimeAsync(100);
  expect(JSON.parse(saved().metadata)).toMatchObject({ upstreamStatus: 'completed', upstreamGenerated: true, upstreamDeliveryPending: true, hussCompletedReceipt: { taskId: 'video_original' } });
  expect(balance()).toBe(94);
  await vi.advanceTimersByTimeAsync(89000); expect(downloadAndLocalizeVideo).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000); expect(saved().status).toBe('completed');
  expect(fetch).toHaveBeenCalledOnce(); expect(downloadAndLocalizeVideo).toHaveBeenCalledTimes(2);
  expect(JSON.parse(saved().metadata)).toMatchObject({ upstreamDeliveryPending: false, resultSaveError: null });
  expect(balance()).toBe(94);
});
it('worker resumes historical HSS query review records by ID without another submission', async () => {
  change({ videoId: 'video_original', actualModel: 'hss-2.5-301010', reviewKind: 'query' });
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    expect(init?.method).toBe('GET');
    return Response.json({ id: 'video_original', status: 'completed', url: 'https://cdn.example/final.mp4' });
  }));
  resumeSpecificationTasks(); resumeSpecificationTasks();
  await vi.waitFor(() => expect(saved().status).toBe('completed'));
  expect(fetch).toHaveBeenCalledOnce(); expect(balance()).toBe(94);
});
it('worker resumes a saved completion after restart without depending on task query availability', async () => {
  change({ videoId: 'video_original', actualModel: 'hss-2.5-301010', reviewKind: 'local', hussCompletedReceipt: { taskId: 'video_original', resultUrl: 'https://cdn.example/old.mp4' } });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('query unavailable'); }));
  resumeSpecificationTasks();
  await vi.waitFor(() => expect(saved().status).toBe('completed'));
  expect(fetch).not.toHaveBeenCalled(); expect(downloadAndLocalizeVideo).toHaveBeenCalledOnce();
});
it('HSS two-hour query window yields to the worker instead of stranding the task in review', async () => {
  vi.useFakeTimers(); change({ videoId: 'video_original', actualModel: 'hss-2.5-301010' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'video_original', status: 'in_progress' })));
  await VideoRecoveryService.recover(id); await vi.advanceTimersByTimeAsync(2 * 60 * 60_000 + 100);
  expect(saved().status).toBe('processing'); expect(JSON.parse(saved().metadata).requiresReview).toBe(false);
  const count = vi.mocked(fetch).mock.calls.length; resumeSpecificationTasks(); expect(fetch).toHaveBeenCalledTimes(count);
  vi.mocked(fetch).mockResolvedValue(Response.json({ id: 'video_original', status: 'completed', url: 'https://cdn.example/final.mp4' }));
  await vi.advanceTimersByTimeAsync(60000); resumeSpecificationTasks(); await vi.advanceTimersByTimeAsync(100);
  expect(saved().status).toBe('completed'); expect(balance()).toBe(94);
});
it('expired HSS content reports delivery review and stops automatic downloads, without refund or regeneration', async () => {
  change({ videoId: 'video_original', actualModel: 'hss-2.5-301010' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'video_original', status: 'completed', url: 'https://cdn.example/old.mp4' })));
  vi.mocked(downloadAndLocalizeVideo).mockRejectedValueOnce(Object.assign(new Error('HTTP 410 media_expired'), { status: 410 }));
  await VideoRecoveryService.recover(id); await vi.waitFor(() => expect(saved().status).toBe('review'));
  expect(JSON.parse(saved().metadata)).toMatchObject({ reviewKind: 'local', hussDeliveryExpired: true, upstreamStatus: 'completed' });
  resumeSpecificationTasks(); expect(fetch).toHaveBeenCalledOnce(); expect(downloadAndLocalizeVideo).toHaveBeenCalledOnce(); expect(balance()).toBe(94);
});
it('worker leaves settlement and refunded HSS records alone', () => {
  change({ actualModel: 'hss-2.5-301010', reviewKind: 'settlement' });
  vi.stubGlobal('fetch', vi.fn()); resumeSpecificationTasks(); expect(fetch).not.toHaveBeenCalled();
  change({ reviewKind: 'query', billingStatus: 'refunded' }); resumeSpecificationTasks(); expect(fetch).not.toHaveBeenCalled();
});

it('historical HSS completed metadata can recover download even while the query endpoint is unavailable', async () => {
  change({ videoId: 'video_original', actualModel: 'hss-2.5-301010', reviewKind: 'query', upstreamStatus: 'completed', upstreamResultUrl: 'https://cdn.example/old.mp4' });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('query unavailable'); }));
  resumeSpecificationTasks();
  await vi.waitFor(() => expect(saved().status).toBe('completed'));
  expect(fetch).not.toHaveBeenCalled(); expect(balance()).toBe(94);
});
it('HSS initial completed receipt survives restart and avoids a blocking GET', async () => {
  change({ videoId: 'video_original', actualModel: 'hss-2.5-301010', reviewKind: 'query', hussInitialTask: { id: 'video_original', status: 'completed', url: 'https://cdn.example/result.mp4' } });
  vi.stubGlobal('fetch', vi.fn()); resumeSpecificationTasks();
  await vi.waitFor(() => expect(saved().status).toBe('completed'));
  expect(fetch).not.toHaveBeenCalled(); expect(downloadAndLocalizeVideo).toHaveBeenCalledOnce();
});

it('an existing upstreamTaskId prevents replay even when legacy videoId is missing', async () => {
  change({ videoId: '', upstreamTaskId: 'video_original', actualModel: 'hss-2.5-301010', reviewKind: 'submission', hussIdempotencyKey: 'original-key' });
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    expect(init?.method).toBe('GET');
    return Response.json({ id: 'video_original', status: 'completed', url: 'https://cdn.example/result.mp4' });
  }));
  resumeSpecificationTasks(); await vi.waitFor(() => expect(saved().status).toBe('completed'));
  expect(fetch).toHaveBeenCalledOnce(); expect(balance()).toBe(94);
});


it('recovers channel B from the persisted unified snapshot through completion with only a content endpoint', async () => {
  const snapshot={model:'hss-2.5-301010-渠道B',prompt:'original',duration:4,ratio:'16:9',resolution:'720p',idempotency_key:'original-b',huss_api_mode:'unified-v1'};
  change({videoId:'',upstreamModel:snapshot.model,actualModel:'hss-2.5-301010',hussPayload:snapshot,hussIdempotencyKey:'original-b',reviewKind:'submission'});
  vi.stubGlobal('fetch',vi.fn(async (_url,init:any)=>{
    if(init.method==='POST') {
      expect(init.headers['X-Huss-Video-API']).toBe('unified-v1');
      expect(init.headers['Idempotency-Key']).toBe('original-b');
      return Response.json({id:'task_unified_b',status:'queued'},{status:202});
    }
    expect(JSON.parse(saved().metadata).videoId).toBe('task_unified_b');
    return Response.json({id:'task_unified_b',status:'completed',content_url:'/v1/videos/task_unified_b/content'});
  }));
  await VideoRecoveryService.recover(id);
  await vi.waitFor(()=>expect(saved().status, saved().metadata).toBe('completed'));
  expect(downloadAndLocalizeVideo).toHaveBeenCalledWith('https://www.huss.top/v1/videos/task_unified_b/content','task_unified_b','hss-2.5-301010',1,null);
  expect(JSON.parse(saved().metadata)).toMatchObject({requiresReview:false,billingStatus:'settled'});
  expect(balance()).toBe(94);
  resumeSpecificationTasks(); expect(fetch).toHaveBeenCalledTimes(2);
});
it('ends a channel B recovery with explicit invalid_prompt rejection and refunds once', async () => {
  change({videoId:'',actualModel:'hss-2.5-301010',reviewKind:'submission',hussIdempotencyKey:'original-b',
    hussPayload:{model:'hss-2.5-301010-渠道B',prompt:'original',duration:4,ratio:'16:9',resolution:'720p',idempotency_key:'original-b',huss_api_mode:'unified-v1'}});
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error:{code:'invalid_prompt',message:'明确拒绝'}},{status:400})));
  await VideoRecoveryService.recover(id);
  await vi.waitFor(()=>expect(saved().status).toBe('failed'));
  expect(balance()).toBe(100); expect(JSON.parse(saved().metadata)).toMatchObject({requiresReview:false,billingStatus:'refunded'});
  resumeSpecificationTasks(); expect(fetch).toHaveBeenCalledOnce();
});


it('never refunds a recovered accepted task when its saved receipt conflicts', async () => {
  persistVideoSubmissionReceipt({contentId:id,upstreamTaskId:'previous-id',provider:'huss',channelId:1,channelApiKeyId:null});
  change({videoId:'',actualModel:'hss-2.5-301010',reviewKind:'submission',hussIdempotencyKey:'original-b',
    hussPayload:{model:'hss-2.5-301010-渠道B',prompt:'original',duration:4,ratio:'16:9',resolution:'720p',idempotency_key:'original-b',huss_api_mode:'unified-v1'}});
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({id:'different-id',status:'queued'},{status:202})));
  await VideoRecoveryService.recover(id);
  await vi.waitFor(()=>expect(JSON.parse(saved().metadata).reviewKind).toBe('local'));
  expect(balance()).toBe(94); expect(saved().status).not.toBe('failed');
  expect(downloadAndLocalizeVideo).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledOnce();
});
