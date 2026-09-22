import { describe, expect, it, vi } from 'vitest';
import {
  generateMingFeiImage,
  isMingFeiImageChannel,
  MINGFEI_IMAGE_MODEL,
  mingFeiImageContentUrl,
  normalizeMingFeiResolution,
} from '../server/services/mingFeiImageAdapter.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('MingFei GPT Image 2 adapter', () => {
  it('detects the dedicated channel and normalizes resolution', () => {
    expect(MINGFEI_IMAGE_MODEL).toBe('gpt-image-2-mingfei');
    expect(isMingFeiImageChannel({ type: 'mingfei' })).toBe(true);
    expect(isMingFeiImageChannel({ baseUrl: 'https://mingfeikeji.qzz.io/' })).toBe(true);
    expect(normalizeMingFeiResolution('4k')).toBe('4K');
    expect(normalizeMingFeiResolution('8K')).toBe('2K');
    expect(mingFeiImageContentUrl('https://mingfeikeji.qzz.io/', 'task/a'))
      .toBe('https://mingfeikeji.qzz.io/v1/videos/task%2Fa/content');
  });

  it('submits seconds as string 1, polls completed and uses the content endpoint', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ id: 'task_1', status: 'queued' }))
      .mockResolvedValueOnce(json({ id: 'task_1', status: 'processing', progress: 40 }))
      .mockResolvedValueOnce(json({ id: 'task_1', status: 'completed', progress: 100, url: 'https://cdn.example.com/result.png' }));
    const progress: number[] = [];

    const result = await generateMingFeiImage({
      baseUrl: 'https://mingfeikeji.qzz.io/',
      apiKey: 'test-key',
      prompt: '测试图片',
      aspectRatio: '16:9',
      resolution: '4k',
      quality: 'high',
      referenceImages: ['https://cdn.example.com/reference.png'],
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async () => {},
      onProgress: value => progress.push(value),
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://mingfeikeji.qzz.io/v1/videos', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-image-2',
        prompt: '测试图片',
        aspect_ratio: '16:9',
        output_resolution: '4K',
        seconds: '1',
        images: ['https://cdn.example.com/reference.png'],
        quality: 'high',
      }),
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://mingfeikeji.qzz.io/v1/videos/task_1', expect.anything());
    expect(progress).toEqual([40, 100]);
    expect(result).toMatchObject({
      taskId: 'task_1',
      reportedImageUrl: 'https://cdn.example.com/result.png',
      imageUrl: 'https://mingfeikeji.qzz.io/v1/videos/task_1/content',
    });
  });

  it('surfaces upstream failures', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ id: 'task_failed', status: 'queued' }))
      .mockResolvedValueOnce(json({ status: 'failed', error: { message: 'content rejected' } }));

    await expect(generateMingFeiImage({
      baseUrl: 'https://mingfeikeji.qzz.io',
      apiKey: 'test-key',
      prompt: '测试',
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async () => {},
    })).rejects.toThrow('content rejected');
  });
});
