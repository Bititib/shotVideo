import { describe, expect, it } from 'vitest';
import {
  buildSiYueTianSeedance25VideoPayload,
  getSiYueTianSeedance25VideoSpec,
  SI_YUE_TIAN_SEEDANCE_25_VIDEO_SPECS,
  validateSiYueTianSeedance25VideoInput,
} from '../server/services/siYueTianVideoModels.js';

describe('四月天 Seedance 2.5 视频模型', () => {
  it('按上游价格加 1 元并固定分辨率', () => {
    expect(SI_YUE_TIAN_SEEDANCE_25_VIDEO_SPECS).toEqual([
      { id: 'seedance-2.5-480p', resolution: '480p', upstreamPrice: 3, price: 4 },
      { id: 'seedance-2.5-720p', resolution: '720p', upstreamPrice: 4, price: 5 },
      { id: 'seedance-2.5-1080p', resolution: '1080p', upstreamPrice: 5, price: 6 },
    ]);
  });

  it('允许 30 图、0 视频、10 音频', () => {
    expect(validateSiYueTianSeedance25VideoInput('seedance-2.5-720p', {
      seconds: 30,
      resolution: '720p',
      imageCount: 30,
      videoCount: 0,
      audioCount: 10,
    })).toBeNull();

    expect(validateSiYueTianSeedance25VideoInput('seedance-2.5-720p', {
      seconds: 30,
      resolution: '720p',
      imageCount: 30,
      videoCount: 1,
      audioCount: 10,
    })).toContain('不支持参考视频');
  });

  it('拒绝错误分辨率并生成上游需要的 Seedance JSON', () => {
    expect(validateSiYueTianSeedance25VideoInput('seedance-2.5-1080p', {
      seconds: 10,
      resolution: '720p',
      imageCount: 0,
      videoCount: 0,
      audioCount: 0,
    })).toContain('仅支持 1080p');

    const spec = getSiYueTianSeedance25VideoSpec('seedance-2.5-1080p');
    expect(spec?.price).toBe(6);
    expect(buildSiYueTianSeedance25VideoPayload({
      model: 'seedance-2.5-1080p',
      prompt: '测试',
      seconds: 12,
      aspectRatio: '16:9',
      imageUrls: ['https://example.com/a.png'],
      audioUrls: ['https://example.com/a.mp3'],
    })).toEqual({
      model: 'seedance-2.5-1080p',
      prompt: '测试',
      duration: 12,
      aspect_ratio: '16:9',
      image_refs: ['https://example.com/a.png'],
      audio_refs: ['https://example.com/a.mp3'],
    });
  });
});
