import { describe, expect, it } from 'vitest';
import {
  buildMiaowuVideoPayload,
  isMiaowuChannel,
  miaowuVideoContentUrl,
  miaowuVideoCreateUrl,
  miaowuVideoModelListUrl,
  normalizeMiaowuVideoTask,
  validateMiaowuSeedance25DealInput,
  validateMiaowuSeedance25ProInput,
} from '../server/services/miaowuVideoAdapter.js';

describe('Miaowu video adapter', () => {
  it('detects the explicit channel type or official host', () => {
    expect(isMiaowuChannel({ type: 'miaowu', baseUrl: 'https://proxy.example.com' })).toBe(true);
    expect(isMiaowuChannel({ baseUrl: 'https://api.miaowuai.store/' })).toBe(true);
    expect(isMiaowuChannel({ type: 'custom', baseUrl: 'https://example.com' })).toBe(false);
  });

  it('builds the documented OpenAI-compatible video JSON body', () => {
    expect(buildMiaowuVideoPayload({
      model: 'seedance2', prompt: '  电影感场景  ', seconds: 8, ratio: '16:9', resolution: '720p',
      imageUrls: ['https://example.com/i.jpg'], videoUrls: ['https://example.com/v.mp4'], audioUrls: ['https://example.com/a.mp3'],
    })).toEqual({
      model: 'seedance2', prompt: '电影感场景', seconds: 8, ratio: '16:9', resolution: '720p',
      image_urls: ['https://example.com/i.jpg'], video_urls: ['https://example.com/v.mp4'], audio_urls: ['https://example.com/a.mp3'],
    });
  });

  it('normalizes Base URLs that already end in /v1', () => {
    expect(miaowuVideoCreateUrl('https://api.miaowuai.store/v1/')).toBe('https://api.miaowuai.store/v1/videos');
    expect(miaowuVideoModelListUrl('https://api.miaowuai.store/v1')).toBe('https://api.miaowuai.store/v1/dream/model_list?type=video');
  });

  it('uses the authenticated content endpoint when a completed task has no URL', () => {
    expect(normalizeMiaowuVideoTask(
      { id: 'task_123', status: 'completed', progress: 100 }, 'https://api.miaowuai.store', 'task_123',
    )).toEqual({
      status: 'completed', progress: 100,
      resultUrl: miaowuVideoContentUrl('https://api.miaowuai.store', 'task_123'), error: '',
    });
  });

  it('extracts nested failure messages', () => {
    expect(normalizeMiaowuVideoTask(
      { status: 'failed', progress: '100%', error: { code: 'task_failed', message: 'generation failed' } },
      'https://api.miaowuai.store', 'task_123',
    )).toMatchObject({ status: 'failed', progress: 100, error: 'generation failed' });
  });

  it('enforces the Seedance 2.5 Deal capability limits', () => {
    expect(validateMiaowuSeedance25DealInput({
      seconds: 5, resolution: '480p', imageCount: 30, videoCount: 0, audioCount: 10,
    })).toBe('');
    expect(validateMiaowuSeedance25DealInput({
      seconds: 4, resolution: '480p', imageCount: 0, videoCount: 0, audioCount: 0,
    })).toContain('5–30');
    expect(validateMiaowuSeedance25DealInput({
      seconds: 30, resolution: '1080p', imageCount: 0, videoCount: 0, audioCount: 0,
    })).toContain('480p 或 720p');
    expect(validateMiaowuSeedance25DealInput({
      seconds: 30, resolution: '720p', imageCount: 31, videoCount: 0, audioCount: 0,
    })).toContain('30 张');
    expect(validateMiaowuSeedance25DealInput({
      seconds: 30, resolution: '720p', imageCount: 0, videoCount: 1, audioCount: 0,
    })).toContain('不支持参考视频');
    expect(validateMiaowuSeedance25DealInput({
      seconds: 30, resolution: '720p', imageCount: 0, videoCount: 0, audioCount: 11,
    })).toContain('10 段');
  });

  it('enforces the Seedance 2.5 Pro capability limits', () => {
    expect(validateMiaowuSeedance25ProInput({
      seconds: 4, resolution: '480p', imageCount: 30, videoCount: 10, audioCount: 10,
    })).toBe('');
    expect(validateMiaowuSeedance25ProInput({
      seconds: 31, resolution: '720p', imageCount: 0, videoCount: 0, audioCount: 0,
    })).toContain('4–30');
    expect(validateMiaowuSeedance25ProInput({
      seconds: 30, resolution: '1080p', imageCount: 0, videoCount: 0, audioCount: 0,
    })).toContain('480p 或 720p');
    expect(validateMiaowuSeedance25ProInput({
      seconds: 30, resolution: '720p', imageCount: 31, videoCount: 0, audioCount: 0,
    })).toContain('30 张');
    expect(validateMiaowuSeedance25ProInput({
      seconds: 30, resolution: '720p', imageCount: 0, videoCount: 11, audioCount: 0,
    })).toContain('10 个');
    expect(validateMiaowuSeedance25ProInput({
      seconds: 30, resolution: '720p', imageCount: 0, videoCount: 0, audioCount: 11,
    })).toContain('10 段');
  });
});
