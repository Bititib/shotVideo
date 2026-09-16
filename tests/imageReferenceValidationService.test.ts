import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { InvalidImageReferenceError, validateAndNormalizeImageReferences } from '../server/services/imageReferenceValidationService.js';

describe('image reference validation service', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('decodes and normalizes a valid inline image to JPEG', async () => {
    const png = await sharp({
      create: { width: 4, height: 3, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } },
    }).png().toBuffer();

    const result = await validateAndNormalizeImageReferences([
      `data:image/png;base64,${png.toString('base64')}`,
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/^data:image\/jpeg;base64,/);
    const output = Buffer.from(result[0].split(',')[1], 'base64');
    await expect(sharp(output).metadata()).resolves.toMatchObject({ format: 'jpeg', width: 4, height: 3 });
  });

  it('identifies the exact invalid reference before submission', async () => {
    const invalid = `data:image/jpeg;base64,${Buffer.from('<html>404</html>').toString('base64')}`;
    await expect(validateAndNormalizeImageReferences([
      'https://example.com/valid-image.jpg',
      invalid,
    ])).rejects.toMatchObject({
      name: 'InvalidImageReferenceError',
      index: 1,
      message: expect.stringContaining('参考图 2'),
    } satisfies Partial<InvalidImageReferenceError>);
  });

  it('rejects missing local upload files instead of persisting a broken URL', async () => {
    await expect(validateAndNormalizeImageReferences([
      '/uploads/history-assets/missing.jpg',
    ])).rejects.toThrow('服务器中的图片文件不存在');
  });

  it('copies a trusted temporary remote image before its URL can expire', async () => {
    const png = await sharp({
      create: { width: 3, height: 2, channels: 3, background: { r: 80, g: 60, b: 40 } },
    }).png().toBuffer();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(png, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(png.length) },
    })));

    const result = await validateAndNormalizeImageReferences([
      'https://filer2.fdai.xyz/temp_1_del/person.png',
    ], { trustedRemoteOrigins: ['https://filer2.fdai.xyz'] });

    expect(result[0]).toMatch(/^data:image\/jpeg;base64,/);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('reports an expired trusted temporary image before billing and queueing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('missing', { status: 404 })));
    await expect(validateAndNormalizeImageReferences([
      'https://filer2.fdai.xyz/temp_1_del/missing.png',
    ], { trustedRemoteOrigins: ['https://filer2.fdai.xyz'] })).rejects.toThrow('文件可能已过期，请重新上传');
  });
});
