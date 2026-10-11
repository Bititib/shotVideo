import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]) }));
import { blobDrawApiBase, blobDrawModelLimits, blobDrawVideoParameters, isBlobDrawChannel, normalizeBlobDrawTask, resolveBlobDrawModel, pollBlobDrawVideo, submitBlobDrawVideo } from '../server/services/blobDrawAdapter.js';
import { readBlobDrawMedia, uploadBlobDrawMedia } from '../server/services/blobDrawMediaService.js';
import { BLOB_DRAW_BB_MODEL, blobDrawBbModelLimits, blobDrawKnownModelId } from '../shared/blobDrawVideo.js';
import { existingModelLimits } from '../server/services/modelInputPresets.js';
const channel = { type: 'blobdraw', baseUrl: 'https://www.iblob.cc', apiKey: 'test-blob-key', publicBaseUrl: 'https://app.example' };
const model = { id: 42, type: 'video', name: 'Video', config: {
  video_modes: ['文生视频', '图生视频', '首帧', '尾帧', '首尾帧', '多模态'],
  video_resolutions: ['720p', '1080p'], video_aspect_ratios: ['16:9', '9:16'],
  video_duration_mode: 'options', video_duration_options: [5, 10, 15],
  video_reference_image_count: 3, video_reference_video_count: 1, video_reference_audio_count: 1,
  video_portrait_enabled: true,
} };
const input = () => ({ model: '42', prompt: ' A moving camera ', seconds: 5, ratio: '9:16', resolution: '720P',
  images: [] as string[], videos: [] as string[], audios: [] as string[], publicBaseUrl: channel.publicBaseUrl });
const png = (suffix = '') => 'data:image/png;base64,' + Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from(suffix)]).toString('base64');
const ok = (data: unknown, status = 200) => Response.json({ code: 0, data }, { status });
beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('BlobDraw documented video protocol', () => {
  it('normalizes site and API addresses and recognizes only the exact host', () => {
    for (const base of ['https://www.iblob.cc', 'https://www.iblob.cc/api', 'https://www.iblob.cc/api/v1/']) expect(blobDrawApiBase(base)).toBe('https://www.iblob.cc/api/v1');
    expect(isBlobDrawChannel({ baseUrl: 'https://www.iblob.cc.evil.example' })).toBe(false);
    expect(() => blobDrawApiBase('https://user:secret@www.iblob.cc')).toThrow();
    expect(() => blobDrawApiBase('https://www.iblob.cc/#/api-docs')).toThrow();
  });
  it('reads exact duration options and rejects unsupported requests without creating a task', async () => {
    expect(blobDrawModelLimits(model)).toMatchObject({ maxImages: 3, maxVideos: 1, maxAudios: 1, firstFrame: true, lastFrame: true, duration: { mode: 'options', values: [5,10,15] } });
    expect(blobDrawVideoParameters(model, input())).toMatchObject({ model_id: 42, type: 'video', mode: '文生视频', duration: 5, resolution: '720p', face_mode: 'portrait' });
    const fetcher = vi.fn(async () => ok([model])); vi.stubGlobal('fetch', fetcher);
    await expect(submitBlobDrawVideo(channel, { ...input(), seconds: 6 }, vi.fn())).rejects.toThrow('时长');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(() => blobDrawVideoParameters(model, { ...input(), images: [png()], mode: '文生视频' })).toThrow('不能携带');
    expect(() => blobDrawVideoParameters(model, { ...input(), firstFrame: png(), images: [png('x')] })).toThrow('混用');
  });
  it('honors fixed duration and only sends face processing for capable models', () => {
    const fixed = { ...model, config: { ...model.config, video_duration_mode: 'fixed', video_fixed_duration: 10, video_portrait_enabled: false } };
    expect(blobDrawModelLimits(fixed).duration).toMatchObject({ mode: 'fixed', min: 10 });
    expect(blobDrawVideoParameters(fixed, { ...input(), seconds: 10 })).not.toHaveProperty('face_mode');
    expect(blobDrawVideoParameters(model, { ...input(), faceMode: 'native' })).toHaveProperty('face_mode', 'native');
    expect(() => blobDrawVideoParameters(model, { ...input(), faceMode: '原生上传' })).toThrow('face_mode');
  });
  it('uploads frames in order, persists the exact payload before generation and uses X-API-Key', async () => {
    const events: string[] = [], requests: any[] = [];
    let uploaded = 100;
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      requests.push({ url: String(url), options });
      expect(options.headers['X-API-Key']).toBe(channel.apiKey);
      expect(options.headers.Authorization).toBeUndefined();
      if (String(url).endsWith('/models')) return ok([model]);
      if (String(url).endsWith('/assets')) {
        events.push('upload');
        expect(options.body).toBeInstanceOf(FormData);
        expect(options.body.get('file')).toBeInstanceOf(Blob);
        expect(options.headers['Content-Type']).toBeUndefined();
        return ok({ id: ++uploaded });
      }
      events.push('generate');
      return ok({ id: 900, status: 'queued' }, 202);
    }));
    const saved = vi.fn(payload => { events.push('save'); expect(payload).toMatchObject({ image_asset_ids: [101,102], mode: '首尾帧', idempotency_key: 'same-business-id' }); });
    expect(await submitBlobDrawVideo(channel, { ...input(), firstFrame: png('first'), lastFrame: png('last'), idempotencyKey: 'same-business-id' }, saved)).toBe('900');
    expect(events).toEqual(['upload','upload','save','generate']);
    expect(JSON.parse(requests.at(-1).options.body)).not.toHaveProperty('image_urls');
  });
  it('forwards all three kinds as IDs rather than external URLs', async () => {
    let uploaded = 10; let generated: any;
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      if (String(url).endsWith('/models')) return ok([model]);
      if (String(url).endsWith('/assets')) return ok({ id: ++uploaded });
      generated = JSON.parse(options.body); return ok({ id: 77 }, 202);
    }));
    const mp4 = Buffer.concat([Buffer.from([0,0,0,20]), Buffer.from('ftypisom0000')]);
    await submitBlobDrawVideo(channel, { ...input(), images: [png()], videos: ['data:video/mp4;base64,' + mp4.toString('base64')],
      audios: ['data:audio/mpeg;base64,' + Buffer.from('ID3audio').toString('base64')] }, vi.fn());
    expect(generated).toMatchObject({ mode: '多模态', image_asset_ids: [11], video_asset_ids: [12], audio_asset_ids: [13] });
  });
  it.each(['network', 'missing-id', 'invalid-json', 'server'])('retains an uncertain %s submission and never automatically resubmits', async failure => {
    const fetcher = vi.fn(async url => {
      if (String(url).endsWith('/models')) return ok([model]);
      if (failure === 'network') throw new Error('timeout');
      if (failure === 'missing-id') return ok({ status: 'queued' }, 202);
      if (failure === 'invalid-json') return new Response('bad', { status: 202 });
      return Response.json({ code: 500, message: 'temporary' }, { status: 503 });
    }); vi.stubGlobal('fetch', fetcher);
    const saved = vi.fn();
    await expect(submitBlobDrawVideo(channel, input(), saved)).rejects.toMatchObject({ uncertain: true });
    expect(saved).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('treats business-envelope errors as errors and redacts an echoed key', async () => {
    vi.stubGlobal('fetch', vi.fn(async url => String(url).endsWith('/models') ? ok([model]) : Response.json({ code: 402, message: 'invalid ' + channel.apiKey })));
    await expect(submitBlobDrawVideo(channel, input(), vi.fn())).rejects.toMatchObject({ status: 402, uncertain: false });
    try { await submitBlobDrawVideo(channel, input(), vi.fn()); } catch (e: any) { expect(e.message).not.toContain(channel.apiKey); }
  });
  it('normalizes output paths against the site origin and keeps failure details', async () => {
    expect(normalizeBlobDrawTask({ status: 'completed', output: { video_url: '/storage/assets/out.mp4' } }, channel.baseUrl + '/api/v1').resultUrl).toBe('https://www.iblob.cc/storage/assets/out.mp4');
    expect(normalizeBlobDrawTask({ status: 'failed', error_message: '素材不符合要求' }, channel.baseUrl).error).toBe('素材不符合要求');
    expect(() => normalizeBlobDrawTask({ code: 503 }, channel.baseUrl)).toThrow('状态');
    vi.stubGlobal('fetch', vi.fn(async () => ok({ status: 'running', progress: 35 })));
    expect(await pollBlobDrawVideo(channel, '900')).toMatchObject({ status: 'running', progress: 35 });
    expect(fetch).toHaveBeenCalledWith('https://www.iblob.cc/api/v1/generation-tasks/900', expect.objectContaining({ headers: { 'X-API-Key': channel.apiKey } }));
  });
});
describe('BlobDraw reference upload boundaries', () => {
  it('rejects GIF, mismatched content, excessive size, and duplicate references', async () => {
    await expect(readBlobDrawMedia('data:image/gif;base64,' + Buffer.from('GIF89a').toString('base64'), 'image', channel)).rejects.toThrow('格式');
    await expect(readBlobDrawMedia(png(), 'video', channel)).rejects.toThrow('类型');
    vi.stubGlobal('fetch', vi.fn(async () => ok({ id: 1 })));
    await expect(uploadBlobDrawMedia([png(), png()], 'image', channel)).rejects.toThrow('重复');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reads only uploads beneath the configured root and rejects traversal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blobdraw-test-'));
    try {
      await fs.writeFile(path.join(root, 'ref.png'), Buffer.from(png().split(',')[1], 'base64'));
      expect((await readBlobDrawMedia('/api/uploads/ref.png', 'image', { ...channel, uploadsRoot: root })).mime).toBe('image/png');
      await expect(readBlobDrawMedia('/uploads/%2e%2e/secret.png', 'image', { ...channel, uploadsRoot: root })).rejects.toThrow('安全');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('downloads public references without a key and rejects redirects to private hosts', async () => {
    const fetcher = vi.fn(async (_url, options) => {
      expect(options.headers).toBeUndefined();
      return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } });
    }); vi.stubGlobal('fetch', fetcher);
    await expect(readBlobDrawMedia('https://media.example/ref.png', 'image', channel)).rejects.toThrow('内网');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(readBlobDrawMedia('http://media.example/ref.png', 'image', channel)).rejects.toThrow('HTTPS');
  });
});


describe('bb-2.5-301010 integration', () => {
  const bb = { ...model, name: BLOB_DRAW_BB_MODEL, config: {
    video_modes: ['文生视频', '图生视频', '多模态'], video_resolutions: ['720p'],
    video_aspect_ratios: ['16:9','9:16','1:1','4:3','3:4','21:9'],
    video_duration_mode: 'options', video_duration_options: Array.from({ length: 27 }, (_, i) => i + 4),
    video_reference_image_count: 30, video_reference_video_count: 10, video_reference_audio_count: 10,
  } };
  it('uses the exact screenshot preset without confusing it with the HM model', () => {
    expect(existingModelLimits(BLOB_DRAW_BB_MODEL, 'video')).toEqual(blobDrawBbModelLimits());
    expect(blobDrawKnownModelId('bb-2.5-301010')).toBe(BLOB_DRAW_BB_MODEL);
    expect(blobDrawKnownModelId('seedance_v2.5-301010')).toBeNull();
    expect(blobDrawModelLimits(bb)).toMatchObject({ maxImages: 30, maxVideos: 10, maxAudios: 10, resolutions: ['720p'], ratios: blobDrawBbModelLimits().ratios });
    expect(() => blobDrawVideoParameters(bb, { ...input(), seconds: 31 })).toThrow('时长');
    expect(() => blobDrawVideoParameters(bb, { ...input(), resolution: '1080p' })).toThrow('分辨率');
    expect(() => blobDrawVideoParameters(bb, { ...input(), images: Array(31).fill(png()) })).toThrow('数量');
    for (const seconds of [4,17,30]) {
      const params = blobDrawVideoParameters(bb, { ...input(), seconds, ratio: '21:9' });
      expect(params).toMatchObject({ duration: seconds, aspect_ratio: '21:9' });
      expect(params).not.toHaveProperty('face_mode');
    }
    expect(blobDrawVideoParameters(bb, { ...input(), videos: Array(10).fill('video'), audios: Array(10).fill('audio') }).mode).toBe('多模态');
  });
  it('resolves the requested name to the authenticated platform ID rather than guessing its numeric suffix', async () => {
    let posted: any;
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      if (String(url).endsWith('/models')) return ok([bb]);
      posted = JSON.parse(options.body); return ok({ id: 987 }, 202);
    }));
    await expect(submitBlobDrawVideo(channel, { ...input(), model: BLOB_DRAW_BB_MODEL, seconds: 30 }, vi.fn())).resolves.toBe('987');
    expect(posted.model_id).toBe(42);
    expect(resolveBlobDrawModel([bb], '42')).toBe(bb);
    expect(() => resolveBlobDrawModel([bb, { ...bb, id: 43 }], BLOB_DRAW_BB_MODEL)).toThrow('名称重复');
  });
  it('keeps live upstream limits authoritative over the capability draft', () => {
    const restricted = { ...bb, config: { ...bb.config, video_duration_options: [5,10], video_reference_video_count: 2 } };
    expect(() => blobDrawVideoParameters(restricted, { ...input(), seconds: 30 })).toThrow('时长');
    expect(() => blobDrawVideoParameters(restricted, { ...input(), videos: ['a','b','c'] })).toThrow('数量');
  });
});
