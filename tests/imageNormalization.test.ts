import { describe, expect, it } from 'vitest';
import { isHeicFile, isSupportedImageFile, MOBILE_IMAGE_ACCEPT } from '../client/src/utils/imageNormalization.js';

function testFile(bytes: number[], name: string, type = ''): File {
  return Object.assign(new Blob([new Uint8Array(bytes)], { type }), { name, lastModified: 0 }) as File;
}

describe('mobile image normalization detection', () => {
  it('accepts standard web images and HEIC files even when the browser omits MIME type', () => {
    expect(isSupportedImageFile(testFile([], 'photo.JPG', 'image/jpeg'))).toBe(true);
    expect(isSupportedImageFile(testFile([], 'photo.webp', 'image/webp'))).toBe(true);
    expect(isSupportedImageFile(testFile([], 'IMG_0001.HEIC'))).toBe(true);
    expect(MOBILE_IMAGE_ACCEPT).toContain('.heic');
    expect(MOBILE_IMAGE_ACCEPT).toContain('image/webp');
  });

  it('detects HEIC from MIME type or filename', async () => {
    await expect(isHeicFile(testFile([], 'photo.bin', 'image/heif'))).resolves.toBe(true);
    await expect(isHeicFile(testFile([], 'IMG_0001.HEIC'))).resolves.toBe(true);
  });

  it('detects an HEIC ISO-BMFF brand when extension and MIME type are missing', async () => {
    const bytes = [
      0, 0, 0, 24,
      ...Array.from('ftypheic', char => char.charCodeAt(0)),
      0, 0, 0, 0,
    ];
    await expect(isHeicFile(testFile(bytes, 'mobile-upload'))).resolves.toBe(true);
  });

  it('does not misclassify ordinary JPEG data as HEIC', async () => {
    const jpeg = testFile([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0], 'photo.jpg', 'image/jpeg');
    await expect(isHeicFile(jpeg)).resolves.toBe(false);
  });
});
