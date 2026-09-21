import { describe, expect, it, vi } from 'vitest';
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

  it('downloads a protected upstream image with the matching channel token', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer channel-secret' });
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    let filePath = '';
    try {
      const url = await localizeGeneratedImage(
        '/outputs/task-123.png',
        'api_siyuetian_task-123',
        { protocol: 'https', headers: {}, get: () => 'app.example.com' } as any,
        { baseUrl: 'https://images.example.com', apiKey: 'channel-secret' },
      );
      const filename = path.basename(new URL(url).pathname);
      filePath = path.join(process.cwd(), 'data/uploads', filename);

      expect(fetchMock).toHaveBeenCalledWith(
        new URL('https://images.example.com/outputs/task-123.png'),
        expect.objectContaining({ headers: { Authorization: 'Bearer channel-secret' } }),
      );
      expect(url).toMatch(/^https:\/\/app\.example\.com\/uploads\/api_siyuetian_task-123_/);
      expect(fs.readFileSync(filePath)).toEqual(Buffer.from([137, 80, 78, 71]));
    } finally {
      vi.unstubAllGlobals();
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  });
});
