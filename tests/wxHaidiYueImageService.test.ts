import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  prepareWxHaidiYueImageUrls,
  wxHaidiYueImageToPublicUrl,
} from '../server/services/wxHaidiYueImageService.js';

const tempDirs: string[] = [];
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'base64');

async function tempUploadsRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'wx-haidiyue-images-'));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('wx-海底月 reference image URL preparation', () => {
  it('caches embedded images and returns a controlled HTTPS URL', async () => {
    const uploadsRoot = await tempUploadsRoot();
    const source = `data:image/unknown;base64,${JPEG_BYTES.toString('base64')}`;
    const result = await wxHaidiYueImageToPublicUrl(source, {
      uploadsRoot,
      mediaBaseUrl: 'https://media-origin.example.com',
    });

    expect(result).toMatch(/^https:\/\/media-origin\.example\.com\/uploads\/wx-haidiyue\/[a-f0-9]{64}\.jpg$/);
    expect(await readFile(path.join(uploadsRoot, 'wx-haidiyue', path.basename(result)))).toEqual(JPEG_BYTES);
  });

  it('reads this site uploads directly and republishes them on the media origin', async () => {
    const uploadsRoot = await tempUploadsRoot();
    await writeFile(path.join(uploadsRoot, 'phone-photo.jpg'), JPEG_BYTES);

    const prepared = await prepareWxHaidiYueImageUrls([
      'https://video.zhubo.asia/uploads/phone-photo.jpg?cache=1',
    ], {
      uploadsRoot,
      publicBaseUrl: 'https://video.zhubo.asia',
      mediaBaseUrl: 'https://media-origin.zhubo.asia',
    });

    expect(prepared[0]).toMatch(/^https:\/\/media-origin\.zhubo\.asia\/uploads\/wx-haidiyue\/[a-f0-9]{64}\.jpg$/);
  });

  it('rejects unsupported image bytes before submission', async () => {
    const uploadsRoot = await tempUploadsRoot();
    const source = `data:image/png;base64,${Buffer.from('not an image').toString('base64')}`;
    await expect(wxHaidiYueImageToPublicUrl(source, {
      uploadsRoot,
      mediaBaseUrl: 'https://media-origin.example.com',
    })).rejects.toThrow('不是有效的 PNG/JPEG/WebP');
  });

  it('accepts PNG bytes and blocks private network URLs', async () => {
    const uploadsRoot = await tempUploadsRoot();
    await expect(wxHaidiYueImageToPublicUrl(
      `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
      { uploadsRoot, mediaBaseUrl: 'https://media-origin.example.com' },
    )).resolves.toMatch(/\.png$/);
    await expect(wxHaidiYueImageToPublicUrl('https://127.0.0.1/private.jpg', {
      uploadsRoot,
      mediaBaseUrl: 'https://media-origin.example.com',
    })).rejects.toThrow('内网参考图地址');
  });

  it('requires HTTPS output and prevents upload path traversal', async () => {
    const uploadsRoot = await tempUploadsRoot();
    await expect(wxHaidiYueImageToPublicUrl(
      `data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}`,
      { uploadsRoot, mediaBaseUrl: 'http://media-origin.example.com' },
    )).rejects.toThrow('必须使用 HTTPS');
    await expect(wxHaidiYueImageToPublicUrl('/uploads/%2e%2e/secret.jpg', {
      uploadsRoot,
      publicBaseUrl: 'https://video.zhubo.asia',
      mediaBaseUrl: 'https://media-origin.zhubo.asia',
    })).rejects.toThrow('本地路径无效');
  });
});
