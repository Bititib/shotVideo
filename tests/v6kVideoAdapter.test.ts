import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildZonghengVideoPayload, normalizeZonghengTask, submitZonghengVideo, ZonghengSubmissionError, zonghengTaskUrl } from '../server/services/zonghengAdapter';
import { prepareZonghengMedia } from '../server/services/zonghengMediaService';
import { zonghengProtocolSnapshot, zonghengTaskChannel, v6kQueryRetryDelay } from '../server/services/zonghengProtocol';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const input = { model: 'TTsedanco2.5-480', prompt: '镜头描述', seconds: 30, ratio: '16:9', resolution: '480p',
  images: ['https://media.example/1.jpg'], videos: ['https://media.example/2.mp4'], audios: ['https://media.example/3.mp3'] };
describe('V6K unified video protocol', () => {
  it('backs off temporary query failures and honors Retry-After', () => {
    expect(v6kQueryRetryDelay(1)).toBe(20_000);
    expect(v6kQueryRetryDelay(2)).toBe(40_000);
    expect(v6kQueryRetryDelay(10)).toBe(120_000);
    expect(v6kQueryRetryDelay(1, '180')).toBe(180_000);
  });
  it('translates the documented fields without changing the legacy payload', () => {
    expect(buildZonghengVideoPayload(input, 'v6k')).toEqual({ model: input.model, prompt: input.prompt, seconds: 30, ratio: '16:9', resolution: '480p', images: input.images, videos: input.videos, audios: input.audios });
    expect(buildZonghengVideoPayload(input)).toEqual(buildZonghengVideoPayload(input, 'v6k')); 
    expect(() => buildZonghengVideoPayload({ ...input, firstFrame: 'https://media.example/frame.jpg', images: [] }, 'v6k')).toThrow('尚未确认');
  });
  it('maps all four states and constructs the authenticated download endpoint', () => {
    for (const status of ['queued', 'in_progress']) expect(normalizeZonghengTask({ id: 'task_1', status }, 'https://www.v6k.top', 'v6k', 'task_1')).toMatchObject({ status: 'processing', pollDelay: 20_000 });
    expect(normalizeZonghengTask({ id: 'task_1', status: 'completed', completed_at: 1790467800 }, 'https://www.v6k.top', 'v6k', 'task_1')).toMatchObject({ status: 'completed', progress: 100, resultUrl: 'https://www.v6k.top/v1/videos/task_1/content', upstreamGenerated: true });
    expect(normalizeZonghengTask({ id: 'task_1', status: 'failed', error: { message: '任务失败' } }, '', 'v6k', 'task_1')).toMatchObject({ status: 'failed', error: '任务失败' });
    expect(() => normalizeZonghengTask({ id: 'other', status: 'completed' }, '', 'v6k', 'task_1')).toThrow('不一致');
    expect(zonghengTaskUrl('https://old.example/v1', 'vid_old')).toBe('https://old.example/v1/videos/vid_old');
  });
  it.each(['queued', 'completed', 'failed'])('preserves a task ID even when submission immediately returns %s', async status => {
    const fetcher = vi.fn(async (_url: any, init: any) => {
      expect(JSON.parse(init.body)).toHaveProperty('seconds', 30);
      return Response.json({ id: 'new_id', status, error: status === 'failed' ? { code: 'video_generation_failed', message: 'failed' } : undefined });
    });
    vi.stubGlobal('fetch', fetcher);
    const result = await submitZonghengVideo('https://www.v6k.top', 'key', input, 'order', () => {}, 1000, 'v6k');
    expect(result.taskId).toBe('new_id');
    expect(result.initialTask?.status).toBe(status === 'queued' ? undefined : status);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('keeps a 504 or missing ID uncertain and never retries the POST', async () => {
    for (const response of [new Response('<html>timeout</html>', { status: 504 }), Response.json({ status: 'queued' })]) {
      const fetcher = vi.fn(async () => response); vi.stubGlobal('fetch', fetcher);
      await expect(submitZonghengVideo('https://www.v6k.top', 'key', input, 'order', () => {}, 1000, 'v6k')).rejects.toMatchObject({ uncertain: true });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('publishes local image references without calling the undocumented media upload API', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'v6k-reference-'));
    vi.stubEnv('PUBLIC_REFERENCE_DIR', root);
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8XcAAAAASUVORK5CYII=';
    try {
      const urls = await prepareZonghengMedia([png, 'https://media.example/other.jpg'], 'image', { protocol: 'v6k', baseUrl: 'https://www.v6k.top', apiKey: 'key', publicBaseUrl: 'https://our.example' });
      expect(urls[0]).toMatch(/^https:\/\/our\.example\/reference-assets\/[\w-]+\.png$/);
      expect(urls[1]).toBe('https://media.example/other.jpg');
      expect(fetcher).not.toHaveBeenCalled();
      expect(await fs.readdir(root)).toHaveLength(1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('refuses legacy task snapshots instead of querying either site', () => {
    expect(() => zonghengTaskChannel({ type: 'zongheng-v6k', baseUrl: 'https://www.v6k.top' }, { zonghengProtocol: 'legacy', zonghengBaseUrl: 'https://old.example' })).toThrow('旧视频接口已停用');
  });
});
