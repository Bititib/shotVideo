import { describe, expect, it } from 'vitest';
import {
  validateSiYueTianSeedance20C2Input,
  buildSiYueTianSeedance25VideoPayload,
  getSiYueTianSeedance25VideoSpec,
  SI_YUE_TIAN_SEEDANCE_25_VIDEO_SPECS,
  validateSiYueTianSeedance25VideoInput,
} from '../server/services/siYueTianVideoModels.js';

describe('四月天 Seedance 2.5 视频模型', () => {
  it.each([
    ['seedance-2.0-fast-c2', 9, 1, 3],
    ['wan-3.0-c2', 10, 5, 5],
  ] as const)('%s 校验所有素材边界且完整保留视频音频', (model, images, videos, audios) => {
    expect(validateSiYueTianSeedance20C2Input(model, images, videos, audios)).toBeNull();
    expect(validateSiYueTianSeedance20C2Input(model, images + 1, videos, audios)).toBeTruthy();
    expect(validateSiYueTianSeedance20C2Input(model, images, videos + 1, audios)).toBeTruthy();
    expect(validateSiYueTianSeedance20C2Input(model, images, videos, audios + 1)).toBeTruthy();
    const payload = buildSiYueTianSeedance25VideoPayload({
      model, prompt: '测试', seconds: 10, aspectRatio: '16:9',
      imageUrls: Array.from({ length: images }, (_, i) => `https://example.com/${i}.png`),
      videoUrls: Array.from({ length: videos }, (_, i) => `https://example.com/${i}.mp4`),
      audioUrls: Array.from({ length: audios }, (_, i) => `https://example.com/${i}.mp3`),
    });
    expect(payload.image_refs).toHaveLength(images);
    expect(payload.video_refs).toHaveLength(videos);
    expect(payload.audio_refs).toHaveLength(audios);
    expect(payload.model).toBe(model);
  });
  it('C2 接受9图3音频，拒绝视频和超限素材', () => {
    expect(validateSiYueTianSeedance20C2Input('seedance-2.0-c2', 9, 0, 3)).toBeNull();
    expect(validateSiYueTianSeedance20C2Input('seedance-2.0-c2', 10, 0, 3)).toContain('9张');
    expect(validateSiYueTianSeedance20C2Input('seedance-2.0-c2', 9, 1, 3)).toContain('不支持');
    expect(validateSiYueTianSeedance20C2Input('seedance-2.0-c2', 9, 0, 4)).toContain('3段');
  });
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
