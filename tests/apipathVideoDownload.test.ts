import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('fs', () => ({ default: { existsSync: vi.fn(() => false), mkdirSync: vi.fn(), writeFileSync: vi.fn(), renameSync: vi.fn() } }));
vi.mock('../server/services/channelService.js', () => ({ ChannelService: { getChannelRaw: vi.fn(() => ({
  id: 28, type: 'apipath', baseUrl: 'https://online.apipath.top', apiKey: 'private-video-key',
})), findChannelForModel: vi.fn() } }));
vi.mock('../server/services/videoCompatibilityService.js', () => ({ prepareVideoForDelivery: vi.fn(async (p: string) => p) }));
vi.mock('../server/services/mediaPreviewService.js', () => ({ createMediaPreview: vi.fn(async () => undefined) }));
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService.js';
import { ChannelService } from '../server/services/channelService.js';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)]);
describe('Apipath actual video downloader', () => {
  it('downloads the completed media URL without sending the API key to object storage', async () => {
    const fetcher = vi.fn(async (_url: any, init: any) => {
      if (init.headers.Authorization) return new Response('unsupported authorization', { status: 403 });
      return new Response(mp4, { headers: { 'Content-Type': 'video/mp4' } });
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await downloadAndLocalizeVideo('https://cdn.example/result.mp4', 'original', 'dola2.5', 28, 11)).toContain('/uploads/videos/');
    expect(ChannelService.getChannelRaw).toHaveBeenCalledWith(28, 11);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1].headers).toEqual({});
  });
  it('retains HTTP and specific download errors without exposing the key or generating a new video', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { code: 'AccessDenied', message: 'download denied private-video-key' } }, { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    const error = await downloadAndLocalizeVideo('https://cdn.example/result.mp4', 'original', 'dola2.5', 28, 11).catch(e => e);
    expect(error.message).toContain('HTTP 403');
    expect(error.message).toContain('AccessDenied');
    expect(error.message).toContain('download denied');
    expect(error.message).not.toContain('private-video-key');
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
