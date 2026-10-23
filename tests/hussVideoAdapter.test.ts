import { afterEach, describe, expect, it, vi } from 'vitest';
import { HUSS_BB_MODEL, fetchHussVideoModels, hussApiBase, hussVideoParameters, isHussChannel, normalizeHussTask, pollHussVideo, submitHussVideo } from '../server/services/hussVideoAdapter.js';

const channel = { type: 'huss', baseUrl: 'https://www.huss.top', apiKey: 'huss-test-key', publicBaseUrl: 'https://app.example' };
const request = () => ({ model: HUSS_BB_MODEL, prompt: 'slow camera move', seconds: 30, ratio: '16:9', resolution: '720p', images: [], videos: [], audios: [], publicBaseUrl: 'https://app.example' });
const ok = (body: unknown, status = 200) => Response.json(body, { status });
afterEach(() => vi.unstubAllGlobals());

describe('HUSS BB Seedance protocol', () => {
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
