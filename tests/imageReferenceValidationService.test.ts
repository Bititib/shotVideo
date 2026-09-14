import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { InvalidImageReferenceError, validateAndNormalizeImageReferences } from '../server/services/imageReferenceValidationService.js';

describe('image reference validation service', () => {
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
});
