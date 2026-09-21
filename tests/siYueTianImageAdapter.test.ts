import { describe, expect, it, vi } from 'vitest';
import {
  generateSiYueTianImage,
  isSiYueTianImageChannel,
  isRetryableSiYueTianImageFailure,
  normalizeSiYueTianResolution,
  SI_YUE_TIAN_IMAGE_MODELS,
  SI_YUE_TIAN_IMAGE_TO_IMAGE_MODELS,
  siYueTianImageContentUrl,
  siYueTianAspectRatioFromSize,
} from '../server/services/siYueTianImageAdapter.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('四月天异步图片适配器', () => {
  it('包含全部六个图片模型并标明图生图能力', () => {
    expect(SI_YUE_TIAN_IMAGE_MODELS).toEqual([
      'gpt-image-2',
      'gpt-image-2.5-flare',
      'gpt-image-2.5-sunburst',
      'nano-banana-2',
      'nano-banana-2-lite',
      'nano-banana-pro',
    ]);
    expect([...SI_YUE_TIAN_IMAGE_TO_IMAGE_MODELS]).toEqual([
      'gpt-image-2',
      'gpt-image-2.5-sunburst',
      'nano-banana-2',
      'nano-banana-pro',
    ]);
    expect(isSiYueTianImageChannel({ baseUrl: 'https://llm.chre3.com' }, 'nano-banana-pro')).toBe(true);
  });

  it('提交 JSON 任务、轮询并返回相对图片地址', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ task_id: 'task_1', task_url: '/v1/images/generations/task_1', status: 'queued' }, 202))
      .mockResolvedValueOnce(json({ task_id: 'task_1', status: 'running', progress: '30%' }))
      .mockResolvedValueOnce(json({ task_id: 'task_1', status: 'succeeded', progress: '100%', result: { image_url: '/outputs/image.png' } }));
    const progress: number[] = [];
    const submitted: string[] = [];

    const result = await generateSiYueTianImage({
      baseUrl: 'https://llm.chre3.com',
      apiKey: 'test-key',
      model: 'nano-banana-pro',
      prompt: '测试图片',
      aspectRatio: '16:9',
      resolution: '4k',
      referenceImages: ['https://cdn.example.com/ref.png'],
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async () => {},
      maxAttempts: 1,
      onSubmitted: taskId => submitted.push(taskId),
      onProgress: value => progress.push(value),
    });

    expect(result).toMatchObject({
      taskId: 'task_1',
      imageUrl: 'https://llm.domie.studio/v1/videos/task_1/content',
      reportedImageUrl: '/outputs/image.png',
    });
    expect(submitted).toEqual(['task_1']);
    expect(progress).toEqual([30, 100]);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://llm.chre3.com/v1/images/generations', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        model: 'nano-banana-pro',
        prompt: '测试图片',
        aspect_ratio: '16:9',
        resolution: '4K',
        reference_images: ['https://cdn.example.com/ref.png'],
      }),
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://llm.chre3.com/v1/images/generations/task_1', expect.anything());
  });

  it('拒绝给不支持图生图的模型传参考图', async () => {
    await expect(generateSiYueTianImage({
      baseUrl: 'https://llm.chre3.com',
      apiKey: 'test-key',
      model: 'nano-banana-2-lite',
      prompt: '测试',
      referenceImages: ['https://cdn.example.com/ref.png'],
      fetchImpl: vi.fn() as unknown as typeof fetch,
      maxAttempts: 1,
    })).rejects.toThrow('不支持参考图');
  });

  it('上游 CPU 过载时递增等待并自动重新提交', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ error: { message: 'system cpu overloaded (current: 98.9%, threshold: 90%)' } }, 503))
      .mockResolvedValueOnce(json({ task_id: 'task_retry', status: 'queued' }, 202))
      .mockResolvedValueOnce(json({ task_id: 'task_retry', status: 'succeeded', result: { image_url: '/outputs/retry.png' } }));
    const sleep = vi.fn(async () => {});
    const retries: Array<[number, number, number, string]> = [];

    const result = await generateSiYueTianImage({
      baseUrl: 'https://llm.chre3.com',
      apiKey: 'test-key',
      model: 'gpt-image-2',
      prompt: '重试测试',
      maxAttempts: 3,
      retryBaseDelayMs: 10_000,
      fetchImpl: fetchImpl as typeof fetch,
      sleep,
      onRetry: (...args) => retries.push(args),
    });

    expect(result).toMatchObject({
      taskId: 'task_retry',
      imageUrl: 'https://llm.domie.studio/v1/videos/task_retry/content',
      reportedImageUrl: '/outputs/retry.png',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(10_000);
    expect(retries).toEqual([[2, 3, 10_000, 'system cpu overloaded (current: 98.9%, threshold: 90%)']]);
    expect(isRetryableSiYueTianImageFailure(new Error('HTTP 429'))).toBe(true);
    expect(isRetryableSiYueTianImageFailure(new Error('Invalid token'))).toBe(false);
  });

  it('规范化兼容尺寸和分辨率', () => {
    expect(siYueTianImageContentUrl('task_a/b')).toBe('https://llm.domie.studio/v1/videos/task_a%2Fb/content');
    expect(siYueTianAspectRatioFromSize('1280x720')).toBe('16:9');
    expect(siYueTianAspectRatioFromSize('1024x1024')).toBe('1:1');
    expect(normalizeSiYueTianResolution('8K')).toBe('2K');
  });
});
