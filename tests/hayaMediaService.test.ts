import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { prepareHayaMedia, validateHayaMedia, HAYA_MAX_FILE_BYTES } from '../server/services/hayaMediaService';

const options = { baseUrl: 'https://hayaai.fun/v1', apiKey: 'test-key', publicBaseUrl: 'https://site.example' };
afterEach(() => vi.unstubAllGlobals());
const image = async (width: number) => 'data:image/png;base64,' + (await sharp({ create: { width, height: 300, channels: 3, background: 'red' } }).png().toBuffer()).toString('base64');
describe('Haya media uploads', () => {
  it('uploads images with a single file part and keeps ordered complete URLs', async () => {
    let count = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      expect(url).toBe('https://hayaai.fun/v1/files');
      expect(init.headers).toEqual({ Authorization: 'Bearer test-key' });
      expect([...init.body.keys()]).toEqual(['file']);
      expect(init.body.get('file').type).toBe('image/png');
      return Response.json({ media_type: 'image', url: 'https://media.example/' + ++count + '?sig=a%2Bb' });
    }));
    expect(await prepareHayaMedia([await image(300), await image(400)], 'image', options)).toEqual(['https://media.example/1?sig=a%2Bb', 'https://media.example/2?sig=a%2Bb']);
  });
  it('passes through public HTTPS references without fetching arbitrary hosts locally', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect(await prepareHayaMedia(['https://media.example/v.mp4?signature=a%2Fb'], 'video', options)).toEqual(['https://media.example/v.mp4?signature=a%2Fb']);
    expect(fetch).not.toHaveBeenCalled();
    for (const source of ['http://example.com/a', 'https://127.0.0.1/a', 'https://192.168.1.2/a', 'file:///C:/a', 'https://user:pass@media.example/a']) {
      await expect(prepareHayaMedia([source], 'video', options)).rejects.toThrow();
    }
  });
  it('validates dimensions before upload and rejects cross-type materials', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(prepareHayaMedia([await image(299)], 'image', options)).rejects.toThrow('300–6000');
    await expect(prepareHayaMedia(['data:audio/wav;base64,YQ=='], 'video', options)).rejects.toThrow('video');
    await expect(prepareHayaMedia(['data:video/mp4;base64,' + Buffer.alloc(HAYA_MAX_FILE_BYTES + 1).toString('base64')], 'video', options)).rejects.toThrow('20 MB');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reads nested site uploads but rejects traversal, without requiring a public site origin', async () => {
    const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'haya-test-'));
    try {
      fs.mkdirSync(path.join(uploadsRoot, 'nested'));
      fs.writeFileSync(path.join(uploadsRoot, 'nested', 'ref.mp4'), 'test-video');
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ media_type: 'video', url: 'https://media.example/ref.mp4' })));
      expect(await prepareHayaMedia(['/uploads/nested/ref.mp4'], 'video', { ...options, uploadsRoot })).toEqual(['https://media.example/ref.mp4']);
      await expect(validateHayaMedia(['/uploads/../secret.mp4'], 'video', { ...options, uploadsRoot })).rejects.toThrow('路径');
    } finally { fs.rmSync(uploadsRoot, { recursive: true, force: true }); }
  });
  it('stops on mismatched upstream media_type instead of creating with corrupted references', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ media_type: 'audio', url: 'https://media.example/a' })));
    await expect(prepareHayaMedia([await image(300)], 'image', options)).rejects.toThrow('素材类型');
  });
});
