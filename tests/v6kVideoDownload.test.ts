import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

vi.mock('../server/services/channelService.js', () => ({ ChannelService: {
  getChannelRaw: () => ({ type: 'zongheng-v6k', baseUrl: 'https://www.v6k.top', apiKey: 'private-key' }),
  findChannelForModel: () => null,
} }));
vi.mock('../server/services/videoCompatibilityService.js', () => ({ prepareVideoForDelivery: async (file: string) => file }));
vi.mock('../server/services/mediaPreviewService.js', () => ({ createMediaPreview: async () => {} }));
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService';

const files: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const file of files.splice(0)) fs.rmSync(file, { force: true }); });
describe('V6K authenticated result download', () => {
  it('sends the original key only to the exact content endpoint and saves durable video bytes', async () => {
    const id = randomUUID();
    const fetcher = vi.fn(async () => new Response(Buffer.from('0000ftypisom-video'), { headers: { 'Content-Type': 'video/mp4' } }));
    vi.stubGlobal('fetch', fetcher);
    const result = await downloadAndLocalizeVideo('https://www.v6k.top/v1/videos/' + id + '/content', id, 'V6K-test', 7);
    expect(result).toMatch(/^\/uploads\/videos\/video_/);
    const file = path.resolve('data', result.slice(1)); files.push(file);
    expect(fs.readFileSync(file).toString()).toBe('0000ftypisom-video');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer private-key' }, redirect: 'error' });
  });
  it('never forwards the key to a CDN or a different path on the same site', async () => {
    for (const url of ['https://cdn.example/video.mp4', 'https://www.v6k.top/not-the-content-endpoint']) {
      const fetcher = vi.fn(async () => new Response('not found', { status: 404 })); vi.stubGlobal('fetch', fetcher);
      await expect(downloadAndLocalizeVideo(url, randomUUID(), 'V6K-test', 7)).rejects.toThrow('404');
      expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
    }
  });
  it('does not accept an HTML success response as a video', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } })));
    const id = randomUUID();
    await expect(downloadAndLocalizeVideo('https://www.v6k.top/v1/videos/' + id + '/content', id, 'V6K-test', 7)).rejects.toThrow('not a video');
  });
});
