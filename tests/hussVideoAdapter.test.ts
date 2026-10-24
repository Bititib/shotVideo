import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicGenerationError } from '../shared/generationMessages.js';
import { HUSS_BB_MODEL, fetchHussVideoModels, hussApiBase, hussVideoParameters, isHussChannel, normalizeHussTask, pollHussVideo, submitHussVideo } from '../server/services/hussVideoAdapter.js';

const channel = { type: 'huss', baseUrl: 'https://www.huss.top', apiKey: 'huss-test-key', publicBaseUrl: 'https://app.example' };
const request = () => ({ model: HUSS_BB_MODEL, prompt: 'slow camera move', seconds: 30, ratio: '16:9', resolution: '720p', images: [], videos: [], audios: [], publicBaseUrl: 'https://app.example' });
const ok = (body: unknown, status = 200) => Response.json(body, { status });
afterEach(() => vi.unstubAllGlobals());

describe('HUSS BB Seedance protocol', () => {
  it('preserves HTTP status, provider code, request ID and exact reason without exposing the key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'QUOTA_EXHAUSTED', message: '余额 0，所需 6；huss-test-key' } }, { status: 403, headers: { 'x-request-id': 'req-42' } })));
    try { await fetchHussVideoModels(channel); throw new Error('expected rejection'); } catch (error: any) {
      const message = publicGenerationError(error.message);
      expect(message).toContain('HTTP 403'); expect(message).toContain('QUOTA_EXHAUSTED');
      expect(message).toContain('req-42'); expect(message).toContain('余额 0'); expect(message).not.toContain(channel.apiKey);
    }
  });
  it('preserves transport diagnosis despite uncertain-submission messaging', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND', message: 'DNS lookup failed' } }); }));
    await expect(submitHussVideo(channel, request(), vi.fn())).rejects.toThrow('ENOTFOUND');
    expect(publicGenerationError('[HUSS /videos 连接] ENOTFOUND；提交结果待核实，请勿重复生成')).toContain('ENOTFOUND');
  });
  it('keeps task failure code and detail in the displayed polling error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ status: 'failed', error_code: 'ASSET_FETCH_FAILED', failure_reason: '参考视频下载超时' })));
    const task = await pollHussVideo(channel, 'task_123');
    expect(task.error).toContain('ASSET_FETCH_FAILED'); expect(task.error).toContain('参考视频下载超时'); expect(task.error).toContain('task_123');
  });
  it('normalizes only the HUSS API root and detects the dedicated channel', () => {
    expect(hussApiBase('https://www.huss.top/v1/')).toBe('https://www.huss.top');
    expect(isHussChannel({ type: 'huss', baseUrl: 'https://elsewhere.example' })).toBe(true);
    expect(isHussChannel({ baseUrl: 'https://www.huss.top.evil.example' })).toBe(false);
  });
  it('requires the documented BB model in the authenticated catalog', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ data: [{ id: HUSS_BB_MODEL }] })));
    await expect(fetchHussVideoModels(channel)).resolves.toMatchObject([{ id: HUSS_BB_MODEL }]);
    expect(fetch).toHaveBeenCalledWith('https://www.huss.top/v1/models', expect.objectContaining({ headers: { Authorization: 'Bearer huss-test-key' } }));
  });
  it('uses JSON references, Bearer auth and the same idempotency key', async () => {
    let payload: any; vi.stubGlobal('fetch', vi.fn(async (_url, options: any) => { payload = JSON.parse(options.body); return ok({ id: 'task_123' }, 202); }));
    const saved = vi.fn(); await expect(submitHussVideo(channel, { ...request(), images: ['https://media.example/a.png'], idempotencyKey: 'same-request' }, saved)).resolves.toBe('task_123');
    expect(payload).toMatchObject({ model: HUSS_BB_MODEL, reference_images: ['https://media.example/a.png'] });
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ idempotency_key: 'same-request' }));
  });
  it('enforces limits and normalizes task status/result URLs', async () => {
    expect(() => hussVideoParameters({ ...request(), seconds: 9 })).toThrow('10–30');
    expect(normalizeHussTask({ status: 'completed', url: '/files/result.mp4' }, channel.baseUrl)).toMatchObject({ status: 'completed', resultUrl: 'https://www.huss.top/files/result.mp4' });
    vi.stubGlobal('fetch', vi.fn(async () => ok({ status: 'in_progress', progress: 30 })));
    await expect(pollHussVideo(channel, 'task_123')).resolves.toMatchObject({ status: 'running', progress: 30 });
  });
});
