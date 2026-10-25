import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
vi.mock('../server/services/publicImageDownload', () => ({ downloadPublicReferenceImage: vi.fn() }));
import { downloadPublicReferenceImage } from '../server/services/publicImageDownload';
import { prepareHmReferenceImages } from '../server/services/hmStudioReferenceService';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-reference-test-'));
const base = 'https://video.example';
let png: Buffer;
beforeAll(async () => {
  vi.stubEnv('PUBLIC_REFERENCE_DIR', directory);
  png = await sharp({ create: { width: 4, height: 3, channels: 4, background: '#12345678' } }).png().toBuffer();
});
beforeEach(() => { vi.mocked(downloadPublicReferenceImage).mockReset().mockResolvedValue(png); });
afterAll(() => { vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true }); });
describe('HM durable image preparation', () => {
  it('downloads unknown external hosts, saves original bytes, preserves ordering/duplicates and reuses public copies', async () => {
    const urls = await prepareHmReferenceImages(['https://f.juicey.dev/f/a.png', 'https://f.juicey.dev/f/a.png'], base);
    expect(urls[0]).toMatch(/^https:\/\/video.example\/reference-assets\/[a-f0-9-]{36}\.png$/);
    expect(urls[1]).toBe(urls[0]); expect(downloadPublicReferenceImage).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(directory, path.basename(urls[0])))).toEqual(png);
    vi.mocked(downloadPublicReferenceImage).mockRejectedValue(new Error('external URL expired'));
    expect(await prepareHmReferenceImages(urls, base)).toEqual(urls);
    expect(downloadPublicReferenceImage).toHaveBeenCalledOnce();
  });
  it.each(['图片下载失败（HTTP 404）', '图片下载超时', '图片下载连接失败（ECONNRESET）'])('keeps the failing image index and reason: %s', async reason => {
    vi.mocked(downloadPublicReferenceImage).mockResolvedValueOnce(png).mockRejectedValueOnce(new Error(reason));
    await expect(prepareHmReferenceImages(['https://host.example/a', 'https://host.example/b'], base)).rejects.toMatchObject({ status: 400, message: `参考图 2：${reason}；本次未提交上游` });
  });
  it('rejects HTML with HTTP 200 and corrupted image headers', async () => {
    vi.mocked(downloadPublicReferenceImage).mockResolvedValue(Buffer.from('<html>Login</html>'));
    await expect(prepareHmReferenceImages(['https://host.example/a'], base)).rejects.toThrow('不是有效图片');
    vi.mocked(downloadPublicReferenceImage).mockResolvedValue(png.subarray(0, 24));
    await expect(prepareHmReferenceImages(['https://host.example/a'], base)).rejects.toThrow('无法完整解码');
  });
  it('rejects an absent public copy rather than silently returning its URL', async () => {
    await expect(prepareHmReferenceImages([base + '/reference-assets/00000000-0000-0000-0000-000000000000.png'], base)).rejects.toThrow('文件不存在');
    expect(downloadPublicReferenceImage).not.toHaveBeenCalled();
  });
  it('supports inline images without changing their bytes', async () => {
    const [url] = await prepareHmReferenceImages(['data:image/png;base64,' + png.toString('base64')], base);
    expect(fs.readFileSync(path.join(directory, path.basename(url)))).toEqual(png);
    expect(downloadPublicReferenceImage).not.toHaveBeenCalled();
  });
});
