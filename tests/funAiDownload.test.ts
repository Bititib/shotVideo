import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('fs', () => ({ default: { existsSync: vi.fn(() => false), mkdirSync: vi.fn(), writeFileSync: vi.fn(), renameSync: vi.fn() } }));
vi.mock('../server/services/channelService.js', () => ({ ChannelService: { getChannelRaw: vi.fn(() => ({
  id: 15, type: 'funai', baseUrl: 'https://ztyunjuan.com', apiKey: 'private-key',
})), findChannelForModel: vi.fn() } }));
vi.mock('../server/services/videoCompatibilityService.js', () => ({ prepareVideoForDelivery: vi.fn(async (p: string) => p) }));
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService.js';
afterEach(() => vi.unstubAllGlobals());
const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)]);
describe('FunAI video result download', () => {
  it('does not send the channel key to a result CDN', async () => {
    const fetcher = vi.fn(async () => new Response(mp4, { headers: { 'Content-Type': 'video/mp4' } }));
    vi.stubGlobal('fetch', fetcher);
    expect(await downloadAndLocalizeVideo('https://cdn.example/video.mp4', 'opaque', 'funai-veo-3.1', 15)).toContain('/uploads/videos/');
    expect(fetcher.mock.calls[0][1].headers).toEqual({});
  });
  it('retries an expired result using the authenticated content endpoint without recreating the task', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(new Response(mp4, { headers: { 'Content-Type': 'video/mp4' } }));
    vi.stubGlobal('fetch', fetcher);
    await downloadAndLocalizeVideo('https://cdn.example/expired.mp4', 'opaque/id', 'funai-veo-3.1', 15);
    expect(fetcher.mock.calls[0][1].headers).toEqual({});
    expect(fetcher.mock.calls[1]).toEqual(['https://ztyunjuan.com/v1/videos/opaque%2Fid/content', expect.objectContaining({ headers: { Authorization: 'Bearer private-key' } })]);
    expect(fetcher.mock.calls.every(call => !call[1].method || call[1].method === 'GET')).toBe(true);
  });
});
