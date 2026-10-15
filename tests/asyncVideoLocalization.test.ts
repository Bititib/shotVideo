import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/services/channelService.js', () => ({ ChannelService: {
  getChannelRaw: vi.fn(() => ({ id: 5, type: 'async-video', baseUrl: 'http://provider.invalid:8080', apiKey: 'secret-async-key' })),
} }));
vi.mock('../server/services/videoCompatibilityService.js', () => ({ prepareVideoForDelivery: vi.fn(async (p: string) => p) }));
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService.js';
beforeEach(() => {
  vi.spyOn(fs, 'existsSync').mockReturnValue(false);
  vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'renameSync').mockReturnValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const video = () => new Response(Buffer.from('0000ftypmp420000'), { headers: { 'Content-Type': 'video/mp4' } });
describe('async video durable downloads', () => {
  it('downloads resolved media without forwarding the API credential, including same-origin CDN links', async () => {
    const upstream = vi.fn(async () => video()); vi.stubGlobal('fetch', upstream);
    expect(await downloadAndLocalizeVideo('http://provider.invalid:8080/media/video.mp4', '123', 'test', 5)).toContain('/uploads/videos/');
    expect(upstream.mock.calls[0][1].headers).toEqual({});
    expect(fs.writeFileSync).toHaveBeenCalledOnce();
  });
  it('refreshes an expired CDN link through the authenticated JSON resolver', async () => {
    const upstream = vi.fn(async (url: any) => String(url).includes('expired') ? new Response('', { status: 403 })
      : String(url).endsWith('/url') ? Response.json({ url: 'https://cdn.example/fresh.mp4' }) : video());
    vi.stubGlobal('fetch', upstream);
    await downloadAndLocalizeVideo('https://cdn.example/expired.mp4', '123', 'test', 5);
    expect(upstream.mock.calls.map(call => call[0])).toEqual(['https://cdn.example/expired.mp4', 'http://provider.invalid:8080/v1/tasks/123/url', 'https://cdn.example/fresh.mp4']);
    expect((upstream.mock.calls[1] as any)[1].headers.Authorization).toBe('Bearer secret-async-key');
    expect((upstream.mock.calls[2] as any)[1].headers).toBeUndefined();
  });
  it('rejects JSON responses instead of saving them as video files', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ url: 'https://cdn.example/video.mp4' })));
    await expect(downloadAndLocalizeVideo('https://cdn.example/video.mp4', '123', 'test', 5)).rejects.toThrow('not a video');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});
