import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/services/videoDurationProbe.js', () => ({ probeVideoDurationSeconds: vi.fn(async () => 5), probeAudioDurationSeconds: vi.fn(async () => 5) }));
import { MEGABY_BASE_URL, megabyVideoLimits } from '../shared/megabyVideo.js';
import { buildMegabyVideoPayload, fetchMegabyVideoModels, isMegabyChannel, megabyBaseUrl, megabyContentUrl,
  normalizeMegabyTask, pollMegabyVideo, shouldSendMegabyAuthorization, validateMegabyReferenceDurations } from '../server/services/megabyVideoAdapter.js';
import { probeVideoDurationSeconds, probeAudioDurationSeconds } from '../server/services/videoDurationProbe.js';
import { submitMegabyVideo, readMegabyJson } from '../server/services/megabyVideoAdapter.js';

const channel = { type: 'megaby', baseUrl: MEGABY_BASE_URL, apiKey: 'megaby-private-test-key' };
const input = () => ({ model: 'videos-mini', prompt: ' 海浪拍打礁石 ', seconds: 5, ratio: '9:16', resolution: '720p',
  images: [] as string[], videos: [] as string[], audios: [] as string[], firstFrame: '', lastFrame: '' });
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); vi.mocked(probeVideoDurationSeconds).mockResolvedValue(5); vi.mocked(probeAudioDurationSeconds).mockResolvedValue(5); });

describe('Megaby video protocol', () => {
  it('normalizes the documented API root and detects only the exact hostname', () => {
    expect(megabyBaseUrl(MEGABY_BASE_URL + '/v1/')).toBe(MEGABY_BASE_URL);
    expect(isMegabyChannel({ baseUrl: MEGABY_BASE_URL })).toBe(true);
    expect(isMegabyChannel({ baseUrl: MEGABY_BASE_URL + '.evil.example' })).toBe(false);
    expect(isMegabyChannel({ type: 'megaby', baseUrl: 'https://proxy.example' })).toBe(true);
    for (const base of ['file:///secret', 'https://user:pass@example.com', MEGABY_BASE_URL + '?key=secret']) expect(() => megabyBaseUrl(base)).toThrow();
  });
  it('uses documented camelCase material fields and duration/ratio without unsupported fields', () => {
    expect(buildMegabyVideoPayload({ ...input(), resolution: '480p', images: ['http://images.example/ref.png'],
      videos: ['https://cdn.example/ref.mp4'], audios: ['https://cdn.example/ref.wav'] })).toEqual({
      model: 'videos-mini', prompt: '海浪拍打礁石', duration: 5, ratio: '9:16', resolution: '480p',
      referenceImages: ['http://images.example/ref.png'], referenceVideos: ['https://cdn.example/ref.mp4'], referenceAudios: ['https://cdn.example/ref.wav'],
    });
    expect(buildMegabyVideoPayload(input())).toEqual({ model: 'videos-mini', prompt: '海浪拍打礁石', duration: 5, ratio: '9:16', resolution: '720p' });
    expect(megabyVideoLimits()).toMatchObject({ maxImages: 9, maxVideos: 3, maxAudios: 3, firstFrame: false, lastFrame: false,
      duration: { min: 4, max: 15, step: 1 }, resolutions: ['720p', '480p'] });
  });
  it.each([{ seconds: 3 }, { seconds: 16 }, { seconds: 5.5 }, { ratio: '4:3' }, { resolution: '1080p' },
    { firstFrame: 'https://images.example/first.png' }, { lastFrame: 'https://images.example/last.png' }, { model: 'other-model' },
    { images: Array(10).fill('https://images.example/ref.png') }, { videos: Array(4).fill('https://cdn.example/ref.mp4') },
    { audios: Array(4).fill('https://cdn.example/ref.wav') }, { images: ['data:image/png;base64,AA=='] },
    { videos: ['file:///secret.mp4'] }, { audios: ['https://user:password@cdn.example/ref.wav'] },
  ])('rejects unsupported input %j', patch => expect(() => buildMegabyVideoPayload({ ...input(), ...patch })).toThrow());
  it('probes real video and audio totals independently and accepts the exact 15 second limit', async () => {
    await validateMegabyReferenceDurations(['v1', 'v2', 'v3'], ['a1', 'a2', 'a3']);
    expect(probeVideoDurationSeconds).toHaveBeenCalledWith('v1', { allowHttp: true, maxBytes: 200 * 1024 * 1024 });
    expect(probeAudioDurationSeconds).toHaveBeenCalledWith('a1', { allowHttp: true, maxBytes: 50 * 1024 * 1024 });
    vi.mocked(probeVideoDurationSeconds).mockResolvedValueOnce(7.501).mockResolvedValueOnce(7.5);
    await expect(validateMegabyReferenceDurations(['v1', 'v2'], [])).rejects.toThrow('视频总时长不能超过 15 秒');
    vi.mocked(probeAudioDurationSeconds).mockResolvedValueOnce(16);
    await expect(validateMegabyReferenceDurations([], ['a1'])).rejects.toThrow('音频总时长不能超过 15 秒');
  });
  it('discovers documented video IDs with Bearer authentication and rejects malformed lists', async () => {
    const fetcher = vi.fn(async () => Response.json({ data: [{ id: 'videos-fast' }, { id: 'videos-mini' }, { id: 'chat-model' }] }));
    expect(await fetchMegabyVideoModels(channel, fetcher)).toEqual(['videos-fast', 'videos-mini']);
    expect(fetcher).toHaveBeenCalledWith(MEGABY_BASE_URL + '/v1/models', expect.objectContaining({ headers: { Authorization: 'Bearer ' + channel.apiKey }, redirect: 'error' }));
    await expect(fetchMegabyVideoModels(channel, async () => Response.json({ data: [{ name: 'videos-mini' }] }))).rejects.toMatchObject({ code: 'INVALID_MODEL_LIST' });
  });
  it.each(['queued', 'in_progress', 'completed', 'failed'])('normalizes the documented %s task state', status => {
    expect(normalizeMegabyTask({ id: 'job', task_id: 'job', status, progress: 50, error: status === 'failed' ? { code: 'generation_failed', message: '视频生成失败' } : null }, channel.baseUrl, 'job'))
      .toMatchObject({ status, progress: ['completed', 'failed'].includes(status) ? 100 : 50,
        resultUrl: status === 'completed' ? megabyContentUrl(channel.baseUrl, 'job') : '' });
  });
  it('prefers video_url and reads metadata.content_url when other result fields are absent', () => {
    expect(normalizeMegabyTask({ status: 'completed', video_url: 'https://cdn.example/video.mp4', url: 'https://cdn.example/other.mp4' }, channel.baseUrl, 'job').resultUrl).toBe('https://cdn.example/video.mp4');
    expect(normalizeMegabyTask({ status: 'completed', metadata: { content_url: 'https://cdn.example/metadata.mp4' } }, channel.baseUrl, 'job').resultUrl).toBe('https://cdn.example/metadata.mp4');
    expect(() => normalizeMegabyTask({ status: 'completed', video_url: 'javascript:alert(1)' }, channel.baseUrl, 'job')).toThrow('结果地址无效');
    expect(() => normalizeMegabyTask({ status: 'completed', id: 'other' }, channel.baseUrl, 'job')).toThrow('ID 不一致');
    expect(() => normalizeMegabyTask({ status: 'surprise' }, channel.baseUrl, 'job')).toThrow('未知任务状态');
  });
  it('queries the original escaped task ID and authenticates downloads only for its exact content URL', async () => {
    const fetcher = vi.fn(async () => Response.json({ status: 'in_progress', progress: 36 }));
    await expect(pollMegabyVideo(channel, 'id /?', fetcher)).resolves.toMatchObject({ progress: 36 });
    expect(fetcher.mock.calls[0][0]).toBe(MEGABY_BASE_URL + '/v1/videos/id%20%2F%3F');
    expect(shouldSendMegabyAuthorization(megabyContentUrl(channel.baseUrl, 'job'), channel.baseUrl, 'job')).toBe(true);
    for (const url of [MEGABY_BASE_URL + '/other', megabyContentUrl(channel.baseUrl, 'other'), 'https://cdn.example/video.mp4']) expect(shouldSendMegabyAuthorization(url, channel.baseUrl, 'job')).toBe(false);
  });
});

describe('Megaby submission evidence', () => {
  it.each(['unsupported_material', 'material_policy_violation', 'unsupported_request', 'content_policy_violation', 'material_limit_exceeded'])('recognizes %s rejection without a receipt', async code => {
    await expect(submitMegabyVideo(channel, buildMegabyVideoPayload(input()), vi.fn(), async () => Response.json({ error: { code, message: '具体原因' } })))
      .rejects.toMatchObject({ code, uncertain: false, confirmedFailure: true, message: expect.stringContaining('具体原因') });
  });
  it.each([
    { status: 'queued', error: { code: 'unsupported_request', message: '冲突证据' } },
    { error: { code: 'server_error', message: '内部异常' } },
    { task_id: 'one', id: 'two' },
    { task_id: { value: 'one' } },
    { status: 'unrecognized' },
  ])('retains uncertain receipt %j without retrying', async body => {
    const upstream = vi.fn(async () => Response.json(body));
    await expect(submitMegabyVideo(channel, buildMegabyVideoPayload(input()), vi.fn(), upstream)).rejects.toMatchObject({ uncertain: true, confirmedFailure: false });
    expect(upstream).toHaveBeenCalledOnce();
  });
  it('preserves accepted task ID despite a simultaneous error and HTTP 500', async () => {
    const persist = vi.fn();
    expect(await submitMegabyVideo(channel, buildMegabyVideoPayload(input()), persist, async () => Response.json({ task_id: 'job', error: { code: 'server_error', message: '响应异常' } }, { status: 500 }))).toBe('job');
    expect(persist).toHaveBeenLastCalledWith({ videoId: 'job', upstreamTaskId: 'job' });
  });
  it('does not claim a gateway failure or broken response is a confirmed rejection', async () => {
    for (const response of [new Response('gateway', { status: 502 }), new Response('{broken'), Response.json({ error: { code: 'unsupported_request' } }, { status: 500 })]) {
      await expect(submitMegabyVideo(channel, buildMegabyVideoPayload(input()), vi.fn(), async () => response)).rejects.toMatchObject({ uncertain: true, confirmedFailure: false });
    }
  });
  it('redacts the API key in query errors and failed task reasons', async () => {
    const payload = { status: 'failed', error: { code: 'generation_failed', message: 'error ' + channel.apiKey } };
    const task = await pollMegabyVideo(channel, 'job', async () => Response.json(payload));
    expect(task.error).toContain('generation_failed'); expect(task.error).not.toContain(channel.apiKey);
    await expect(readMegabyJson(channel, Response.json({ error: payload.error }, { status: 503 }), 'query')).rejects.toMatchObject({ confirmedFailure: false, uncertain: false, upstreamStatus: 503, message: expect.not.stringContaining(channel.apiKey) });
  });
  it('leaves a disconnected POST unknown and never sends another', async () => {
    const upstream = vi.fn(async () => { throw new Error('connection lost', { cause: { code: 'ECONNRESET' } }); });
    await expect(submitMegabyVideo(channel, buildMegabyVideoPayload(input()), vi.fn(), upstream)).rejects.toMatchObject({ code: 'ECONNRESET', uncertain: true });
    expect(upstream).toHaveBeenCalledOnce();
  });
});

it.each([400, 401, 402, 403, 404, 405, 413, 415, 422, 429])('Megaby HTTP %s explicit rejection does not enter review', async status => {
  const upstream = vi.fn(async () => Response.json({ error: { code: 'client_rejected', message: '拒绝该请求' } }, { status }));
  await expect(submitMegabyVideo(channel, buildMegabyVideoPayload(input()), vi.fn(), upstream)).rejects.toMatchObject({ uncertain: false, confirmedFailure: true, upstreamStatus: status });
  expect(upstream).toHaveBeenCalledOnce();
});

it('does not mistake a diagnostic request_id for Megaby task acceptance', async () => {
  await expect(submitMegabyVideo(channel, buildMegabyVideoPayload(input()), vi.fn(), async () => Response.json({
    request_id: 'diagnostic-only', error: { code: 'unsupported_request', message: '参数被拒绝' },
  }, { status: 400 }))).rejects.toMatchObject({ confirmedFailure: true, uncertain: false, message: expect.stringContaining('diagnostic-only') });
});
