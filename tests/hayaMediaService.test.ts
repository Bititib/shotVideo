import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { prepareHayaMedia, validateHayaMedia, HAYA_MAX_FILE_BYTES } from '../server/services/hayaMediaService';

const options = { baseUrl: 'https://hayaai.fun/v1', apiKey: 'test-key', publicBaseUrl: 'https://site.example' };
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'haya-public-'));
beforeAll(() => vi.stubEnv('PUBLIC_REFERENCE_DIR', temp));
afterAll(() => { vi.unstubAllEnvs(); fs.rmSync(temp, { recursive: true, force: true }); });
afterEach(() => vi.unstubAllGlobals());
const image = async (width: number) => 'data:image/png;base64,' + (await sharp({ create: { width, height: 300, channels: 3, background: 'red' } }).png().toBuffer()).toString('base64');
describe('Haya public URL references', () => {
  it('publishes images on the site without uploading a file to the upstream', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const urls = await prepareHayaMedia([await image(300), await image(400)], 'image', options);
    expect(urls).toHaveLength(2);
    expect(urls[0]).not.toBe(urls[1]);
    for (const url of urls) {
      expect(url).toMatch(/^https:\/\/site.example\/reference-assets\/[a-f0-9-]+\.png$/);
      expect(new URL(url).search).toBe('');
      expect(fs.existsSync(path.join(temp, path.basename(new URL(url).pathname)))).toBe(true);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('passes through public HTTPS references without fetching arbitrary hosts locally', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect(await prepareHayaMedia(['https://media.example/v.mp4?signature=a%2Fb'], 'video', options)).toEqual(['https://media.example/v.mp4?signature=a%2Fb']);
    expect(fetch).not.toHaveBeenCalled();
    for (const source of ['http://example.com/a', 'https://127.0.0.1/a', 'https://192.168.1.2/a', 'file:///C:/a', 'https://user:pass@media.example/a']) {
      await expect(prepareHayaMedia([source], 'video', options)).rejects.toThrow();
    }
  });
  it('validates dimensions before publishing and rejects cross-type materials', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(prepareHayaMedia([await image(299)], 'image', options)).rejects.toThrow('300–6000');
    await expect(prepareHayaMedia(['data:audio/wav;base64,YQ=='], 'video', options)).rejects.toThrow('video');
    await expect(prepareHayaMedia(['data:video/mp4;base64,' + Buffer.alloc(HAYA_MAX_FILE_BYTES + 1).toString('base64')], 'video', options)).rejects.toThrow('20 MB');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('publishes nested site uploads and rejects traversal', async () => {
    const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'haya-test-'));
    try {
      fs.mkdirSync(path.join(uploadsRoot, 'nested'));
      fs.writeFileSync(path.join(uploadsRoot, 'nested', 'ref.mp4'), '0000ftypisomtest-video');
      const urls = await prepareHayaMedia(['/uploads/nested/ref.mp4'], 'video', { ...options, uploadsRoot });
      expect(urls[0]).toMatch(/^https:\/\/site.example\/reference-assets\/.+\.mp4$/);
      await expect(validateHayaMedia(['/uploads/../secret.mp4'], 'video', { ...options, uploadsRoot })).rejects.toThrow('路径');
    } finally { fs.rmSync(uploadsRoot, { recursive: true, force: true }); }
  });
  it('requires a configured public origin before publishing local assets', async () => {
    await expect(prepareHayaMedia([await image(300)], 'image', { ...options, publicBaseUrl: '' })).rejects.toThrow('BACKEND_URL');
  });
});
