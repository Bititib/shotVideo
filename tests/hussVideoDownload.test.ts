import fs from 'node:fs';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('../server/services/channelService.js', () => ({ ChannelService: { getChannelRaw: () => ({ id: 1, type: 'huss', baseUrl: 'https://www.huss.top', apiKey: 'huss-secret' }) } }));
vi.mock('../server/services/videoCompatibilityService.js', () => ({ prepareVideoForDelivery: async (file: string) => file }));
vi.mock('../server/services/mediaPreviewService.js', () => ({ createMediaPreview: async () => {} }));
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService.js';
beforeEach(() => {
  vi.spyOn(fs, 'existsSync').mockReturnValue(false); vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined); vi.spyOn(fs, 'renameSync').mockReturnValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each(['https://www.huss.top/files/clip.mp4?signature=keep%2Bthis&expires=99','https://cdn.example/clip.mp4?token=signed'])('downloads the complete signed URL without sending API key: %s', async url => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('0000ftypmp420000'), { headers: { 'Content-Type': 'video/mp4' } })));
  expect(await downloadAndLocalizeVideo(url, 'task_original', 'bb-2.5-301010', 1)).toContain('/uploads/videos/');
  expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ headers: {} }));
  expect(fs.renameSync).toHaveBeenCalledOnce();
});
it('preserves the upstream download reason without exposing the key', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'signature_expired', message: '签名已过期 huss-secret' } }, { status: 403 })));
  await expect(downloadAndLocalizeVideo('https://cdn.example/clip.mp4?signature=expired', 'task_original', 'bb-2.5-301010', 1))
    .rejects.toThrow('signature_expired');
  expect(fs.renameSync).not.toHaveBeenCalled();
});
