import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { localizeGeneratedImage, storedImageUrls } from '../server/routes/imageGen.js';

describe('image download ownership metadata', () => {
  it('collects the primary and multi-image result URLs without duplicates', () => {
    expect(storedImageUrls({
      resultUrl: 'https://cdn.example.com/a.png',
      metadata: JSON.stringify({
        imageUrls: [
          'https://cdn.example.com/a.png',
          'https://cdn.example.com/b.png',
        ],
      }),
    })).toEqual([
      'https://cdn.example.com/a.png',
      'https://cdn.example.com/b.png',
    ]);
  });

  it('ignores malformed legacy metadata', () => {
    expect(storedImageUrls({ resultUrl: '/uploads/image.png', metadata: '{bad-json' }))
      .toEqual(['/uploads/image.png']);
  });

  it('turns a generated data URL into a directly accessible uploads URL', async () => {
    const url = await localizeGeneratedImage(
      'data:image/png;base64,aGVsbG8=',
      'localize_test',
      { protocol: 'http', headers: {}, get: () => 'localhost:3000' } as any,
    );
    const filename = path.basename(new URL(url).pathname);
    const filePath = path.join(process.cwd(), 'data/uploads', filename);
    try {
      expect(new URL(url).pathname).toMatch(/^\/uploads\/localize_test_/);
      expect(fs.readFileSync(filePath).toString()).toBe('hello');
    } finally {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  });
});
