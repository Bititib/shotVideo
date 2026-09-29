import { afterEach, describe, expect, it, vi } from 'vitest';
import { HAYA_MODEL_IDS, HAYA_VIDEO_MODELS, validateHayaVideoInput } from '../shared/hayaVideo';
import { buildHayaVideoPayload, hayaPollDelay, hayaTaskId, hayaTaskUrl, isHayaChannel, normalizeHayaTask, shouldSendHayaAuthorization, submitHayaVideo } from '../server/services/hayaVideoAdapter';

afterEach(() => vi.unstubAllGlobals());
const input = { model: HAYA_MODEL_IDS[0], prompt: ' 测试 ', seconds: 15, ratio: '9:16', resolution: '720p',
  images: ['https://media.example/a.png'], videos: [], audios: ['https://media.example/b.wav'] };

describe('Haya protocol and catalog', () => {
  it('preserves all seven exact IDs and applies the requested markup and billing units', () => {
    expect(HAYA_MODEL_IDS).toEqual(['bz-seedance2.5-720p', 'F-seedance-2.5-480p', 'F-seedance-2.5-720p',
      'XG-seedance-2.5-720', 'y-seedance-2.5-1080p', 'y-seedance-2.5-480p', 'y-seedance-2.5-720p']);
    expect(HAYA_VIDEO_MODELS.map(m => [m.price, m.billingType])).toEqual([
      [6.5, 'per_call'], [5, 'per_call'], [5, 'per_call'], [0.5, 'per_second'], [13, 'per_call'], [5, 'per_call'], [7, 'per_call'],
    ]);
  });
  it('validates resolution, integer duration, Y no-video limits and dedicated frames', () => {
    const values = { seconds: 4, ratio: '9:16', resolution: '1080p', imageCount: 30, videoCount: 0, audioCount: 10 };
    expect(validateHayaVideoInput('y-seedance-2.5-1080p', values)).toBeNull();
    for (const patch of [{ seconds: 3 }, { seconds: 30.5 }, { resolution: '720p' }, { videoCount: 1 }, { imageCount: 31 }, { firstFrame: 'image' }]) {
      expect(validateHayaVideoInput('y-seedance-2.5-1080p', { ...values, ...patch })).toBeTruthy();
    }
  });
  it('sends only documented JSON material fields, preserving reference order', () => {
    expect(buildHayaVideoPayload(input)).toEqual({ model: input.model, prompt: '测试', seconds: 15, ratio: '9:16', resolution: '720p', images: input.images, audios: input.audios });
    expect(isHayaChannel({ baseUrl: 'https://hayaai.fun/v1' })).toBe(true);
    expect(isHayaChannel({ baseUrl: 'https://hayaai.fun.evil.test' })).toBe(false);
    expect(hayaTaskUrl('https://hayaai.fun/v1/', 'task_123')).toBe('https://hayaai.fun/v1/videos/task_123');
    expect(() => hayaTaskId({ id: 'internal-id', request_id: 'task_fake' })).toThrow();
  });
  it('preserves signed result URLs and does not send credentials to a CDN or signed links', () => {
    const url = 'https://hayaai.fun/v1/videos/task_123/content?expires=42&signature=a%2Bb';
    expect(normalizeHayaTask({ status: 'completed', metadata: { url } }, 'https://hayaai.fun', 'task_123').resultUrl).toBe(url);
    expect(shouldSendHayaAuthorization(url, 'https://hayaai.fun')).toBe(false);
    expect(shouldSendHayaAuthorization('https://cdn.example/video.mp4', 'https://hayaai.fun')).toBe(false);
    expect(shouldSendHayaAuthorization('https://hayaai.fun/v1/videos/task_123/content', 'https://hayaai.fun/v1')).toBe(true);
    expect(normalizeHayaTask({ status: 'completed' }, 'https://hayaai.fun', 'task_123').resultUrl).toContain('/task_123/content');
  });
  it('requires an explicit task state before deciding failure and preserves both error fields', () => {
    expect(() => normalizeHayaTask({ error: { code: 'gateway_error' } }, 'https://hayaai.fun', 'task_1')).toThrow();
    expect(normalizeHayaTask({ status: 'failed', error: { code: 'upstream_task_failed', message: '审核失败' } }, 'https://hayaai.fun', 'task_1').error).toBe('upstream_task_failed: 审核失败');
    expect([0, 1, 2, 3, 20].map(hayaPollDelay)).toEqual([12000, 24000, 48000, 60000, 60000]);
  });
  it('persists the submission marker before sending, captures request ID, and never picks request_id as the task ID', async () => {
    const order: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      order.push('POST'); expect(JSON.parse(options.body).images).toEqual(input.images);
      return Response.json({ task_id: 'task_public', request_id: 'internal' }, { headers: { 'x-request-id': 'req-1' } });
    }));
    expect(await submitHayaVideo('https://hayaai.fun/v1', 'key', input, () => { order.push('save'); })).toEqual({ taskId: 'task_public', requestId: 'req-1' });
    expect(order).toEqual(['save', 'POST']);
  });
  it.each([400, 401, 402, 403, 429, 408, 500, 502, 503, 504])('classifies HTTP %s without retrying creation', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('error', { status })));
    await expect(submitHayaVideo('https://hayaai.fun', 'key', input, () => {})).rejects.toMatchObject({ uncertain: status === 408 || status >= 500 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['timeout', 'invalid-json', 'missing-id'])('retains an uncertain submission on %s', async kind => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (kind === 'timeout') throw new Error('timeout');
      return kind === 'invalid-json' ? new Response('bad') : Response.json({ id: 'upstream-internal' });
    }));
    await expect(submitHayaVideo('https://hayaai.fun', 'key', input, () => {})).rejects.toMatchObject({ uncertain: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
