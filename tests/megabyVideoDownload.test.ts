import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/services/channelService.js', () => ({ ChannelService: {
  getChannelRaw: () => ({ id: 5, type: 'megaby', baseUrl: 'https://newapi.megabyai.cc', apiKey: 'secret-megaby-key' }),
} }));
vi.mock('../server/services/videoCompatibilityService.js', () => ({ prepareVideoForDelivery: async (file: string) => file }));
vi.mock('../server/services/mediaPreviewService.js', () => ({ createMediaPreview: async () => {} }));
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService.js';
const content = 'https://newapi.megabyai.cc/v1/videos/job/content';
const video = () => new Response(Buffer.from('0000ftypmp420000'), { headers: { 'Content-Type': 'video/mp4' } });
beforeEach(() => {
  vi.spyOn(fs, 'existsSync').mockReturnValue(false); vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined); vi.spyOn(fs, 'renameSync').mockReturnValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('Megaby result downloads', () => {
  it('authenticates the original content endpoint and saves video bytes durably', async () => {
    const upstream = vi.fn(async () => video()); vi.stubGlobal('fetch', upstream);
    expect(await downloadAndLocalizeVideo(content, 'job', 'videos-mini', 5)).toContain('/uploads/videos/');
    expect(upstream).toHaveBeenCalledWith(content, expect.objectContaining({ headers: { Authorization: 'Bearer secret-megaby-key' }, redirect: 'manual' }));
    expect(fs.writeFileSync).toHaveBeenCalledOnce(); expect(fs.renameSync).toHaveBeenCalledOnce();
  });
  it.each(['https://cdn.example/video.mp4', 'https://newapi.megabyai.cc/files/video.mp4', 'https://newapi.megabyai.cc/v1/videos/other/content'])('does not send credentials to %s', async url => {
    const upstream = vi.fn(async () => video()); vi.stubGlobal('fetch', upstream);
    await downloadAndLocalizeVideo(url, 'job', 'videos-mini', 5);
    expect(upstream.mock.calls[0][1].headers).toEqual({});
  });
  it('falls back from expired media to the original authenticated content endpoint', async () => {
    const upstream = vi.fn(async (url: any) => url === content ? video() : new Response('', { status: 403 })); vi.stubGlobal('fetch', upstream);
    await downloadAndLocalizeVideo('https://cdn.example/expired.mp4', 'job', 'videos-mini', 5);
    expect(upstream.mock.calls.map(call => call[0])).toEqual(['https://cdn.example/expired.mp4', content]);
    expect(upstream.mock.calls[1][1]).toMatchObject({ headers: { Authorization: 'Bearer secret-megaby-key' }, redirect: 'manual' });
  });
  it.each(['https://cdn.example/result.mp4', 'https://newapi.megabyai.cc/storage/result.mp4'])('follows content redirects to %s without forwarding the API key', async redirected => {
    const upstream = vi.fn(async (url: any) => url === content ? new Response('', { status: 302, headers: { Location: redirected } }) : video());
    vi.stubGlobal('fetch', upstream);
    await downloadAndLocalizeVideo(content, 'job', 'videos-mini', 5);
    expect(upstream.mock.calls.map(call => call[0])).toEqual([content, redirected]);
    expect(upstream.mock.calls[0][1].headers.Authorization).toBe('Bearer secret-megaby-key');
    expect(upstream.mock.calls[1][1].headers).toEqual({});
  });
  it('bounds redirects and rejects non-HTTP download targets', async () => {
    const upstream = vi.fn(async () => new Response('', { status: 302, headers: { Location: content } })); vi.stubGlobal('fetch', upstream);
    await expect(downloadAndLocalizeVideo(content, 'job', 'videos-mini', 5)).rejects.toMatchObject({ code: 'INVALID_VIDEO_REDIRECT' });
    expect(upstream).toHaveBeenCalledTimes(6);
    upstream.mockImplementation(async () => new Response('', { status: 302, headers: { Location: 'file:///secret' } }));
    await expect(downloadAndLocalizeVideo(content, 'job', 'videos-mini', 5)).rejects.toMatchObject({ code: 'INVALID_VIDEO_REDIRECT' });
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
  it('preserves a native content download error without treating the generation as failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'download_failed', message: '结果下载失败' } }, { status: 503 })));
    await expect(downloadAndLocalizeVideo(content, 'job', 'videos-mini', 5)).rejects.toMatchObject({ code: 'download_failed',
      upstreamStatus: 503, message: expect.stringContaining('结果下载失败'), confirmedFailure: false });
  });
  it('rejects a JSON success response without saving it as an MP4', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'not ready' })));
    await expect(downloadAndLocalizeVideo(content, 'job', 'videos-mini', 5)).rejects.toThrow('not a video');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});
