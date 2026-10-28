import { afterEach, expect, it, vi } from 'vitest';
import { HUSS_HSS_MODEL } from '../shared/hussBbVideo.js';
import { hussVideoParameters, submitHussVideo, recoverHussSubmission, pollHussVideo } from '../server/services/hussVideoAdapter.js';
const channel = { type: 'huss', baseUrl: 'https://www.huss.top', apiKey: 'test-key' };
const input = { model: HUSS_HSS_MODEL, prompt: 'test', seconds: 4, ratio: '21:9', resolution: '720p', images: ['https://media.example/a.png'], videos: [], audios: [], publicBaseUrl: 'https://app.example', idempotencyKey: 'original-key' };
afterEach(() => vi.unstubAllGlobals());
it('uses canonical HSS media fields and persists the exact request before sending', async () => {
  let saved: any;
  vi.stubGlobal('fetch', vi.fn(async (_url, options: any) => {
    expect(saved).toBeDefined();
    const { idempotency_key, ...payload } = saved;
    expect(JSON.parse(options.body)).toEqual(payload);
    expect(payload).toMatchObject({ model: HUSS_HSS_MODEL, duration: 4, ratio: '21:9', images: input.images });
    expect(payload).not.toHaveProperty('reference_images');
    expect(options.headers['Idempotency-Key']).toBe(idempotency_key);
    return Response.json({ id: 'video_original', status: 'queued' }, { status: 202 });
  }));
  expect(await submitHussVideo(channel, input, p => { saved = p; })).toBe('video_original');
});
it.each([{ seconds: 3 }, { seconds: 4.5 }, { seconds: 31 }, { resolution: '1080p' }, { prompt: 'a'.repeat(8001) }, { ratio: '2:1' }, { firstFrame: 'https://media.example/first.png' }])('rejects unsupported input %j without sending', async invalid => {
  vi.stubGlobal('fetch', vi.fn());
  await expect(submitHussVideo(channel, { ...input, ...invalid }, vi.fn())).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects HTTP assets before recording submission', async () => {
  const saved = vi.fn();
  await expect(submitHussVideo(channel, { ...input, images: ['http://media.example/a.png'] }, saved)).rejects.toThrow('HTTPS');
  expect(saved).not.toHaveBeenCalled();
});
it('does not apply BB minimum duration', () => expect(hussVideoParameters(input).payload.duration).toBe(4));
it('a lost response never invokes legacy receipts; recovery replays the original snapshot', async () => {
  let snapshot: any;
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('socket reset')).mockResolvedValueOnce(Response.json({ id: 'video_recovered', status: 'queued' }));
  vi.stubGlobal('fetch', fetcher);
  await expect(submitHussVideo(channel, input, p => { snapshot = p; })).rejects.toMatchObject({ uncertain: true });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await recoverHussSubmission(channel, input.idempotencyKey, snapshot)).toMatchObject({ state: 'accepted', taskId: 'video_recovered' });
  expect(fetcher.mock.calls[0][0]).toBe(fetcher.mock.calls[1][0]);
  expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
  expect(fetcher.mock.calls[1][1].headers['Idempotency-Key']).toBe('original-key');
});
it('never replays a snapshot with a different key', async () => {
  vi.stubGlobal('fetch', vi.fn());
  await expect(recoverHussSubmission(channel, 'original-key', { model: HUSS_HSS_MODEL, idempotency_key: 'different' })).rejects.toThrow('不匹配');
  expect(fetch).not.toHaveBeenCalled();
});
it.each([400, 401, 403])('initial HTTP %s precheck is a rejection, with original provider details', async status => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'invalid_input', message: 'duration out of range' } }, { status })));
  await expect(submitHussVideo(channel, input, vi.fn())).rejects.toMatchObject({ uncertain: false, message: expect.stringContaining('duration out of range') });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([409, 503])('HTTP %s retains the original request for recovery', async status => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'idempotency_conflict', message: 'original request requires checking' } }, { status })));
  await expect(submitHussVideo(channel, input, vi.fn())).rejects.toMatchObject({ uncertain: true });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('retains an immediately failed replay task ID before polling its terminal error', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'video_failed', status: 'failed', error: { code: 'NOT_SUBMITTED', message: 'queue expired' } })));
  expect(await submitHussVideo(channel, input, vi.fn())).toBe('video_failed');
  expect(await pollHussVideo(channel, 'video_failed')).toMatchObject({ status: 'failed', error: expect.stringContaining('NOT_SUBMITTED') });
});
it.each(['saving', 'submission_uncertain'])('phase %s remains processing without invented progress or refund', async phase => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'video_original', status: 'in_progress', phase, recovery_status: 'manual_review_required', billing_status: 'refund_flow_recorded' })));
  expect(await pollHussVideo(channel, 'video_original')).toMatchObject({ status: 'running', progressKnown: false, phase });
});

it.each([200, 400, 429, 503])('temporary admission errors HTTP %s preserve original receipt without refund', async status => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'auth_unavailable', message: '受理检查暂时不可用' } }, { status, headers: { 'Retry-After': '90' } })));
  await expect(submitHussVideo(channel, input, vi.fn())).rejects.toMatchObject({ uncertain: true, retryAfterMs: 90000 });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('conflicting HSS terminal data with explicit uncertainty never becomes failure/refund', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'video_original', status: 'failed', submission_uncertain: true, recovery_status: 'manual_review_required', error: { code: 'recovery_window_elapsed' } })));
  expect(await pollHussVideo(channel, 'video_original')).toMatchObject({ status: 'running', progressText: expect.stringContaining('联系上游') });
});

it('never replays an incomplete HSS request snapshot', async () => {
  vi.stubGlobal('fetch', vi.fn());
  await expect(recoverHussSubmission(channel, 'original-key', { model: HUSS_HSS_MODEL, idempotency_key: 'original-key' })).rejects.toThrow('不完整');
  expect(fetch).not.toHaveBeenCalled();
});

it('retains an immediately completed HSS response for saving before any GET', async () => {
  const raw = { id: 'video_original', status: 'completed', url: 'https://cdn.example/result.mp4' };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(raw)));
  const accepted = vi.fn();
  expect(await submitHussVideo(channel, input, vi.fn(), accepted)).toBe('video_original');
  expect(accepted).toHaveBeenCalledWith(raw); expect(fetch).toHaveBeenCalledOnce();
});
it('a local write failure after acceptance remains uncertain and cannot trigger failover', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'video_original', status: 'completed', url: 'https://cdn.example/result.mp4' })));
  await expect(submitHussVideo(channel, input, vi.fn(), () => { throw new Error('disk full'); })).rejects.toMatchObject({ uncertain: true });
});
