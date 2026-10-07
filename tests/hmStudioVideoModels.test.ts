import { describe, expect, it } from 'vitest';
import {
  getHmStudioAdditionalVideoModel,
  HM_STUDIO_SEEDANCE_V20_933_MODEL,
  HM_STUDIO_SEEDANCE_V25_101010_MODEL,
  HM_STUDIO_SEEDANCE_V25_301010_MODEL,
  getHmStudioUpstreamVideoModel,
  HM_STUDIO_FAST803_MODEL,
  HM_STUDIO_FAST813_MODEL,
  HM_STUDIO_MINI503_MODEL,
  normalizeHmStudioVideoResolution,
  validateHmStudioAdditionalVideoInput,
} from '../server/services/hmStudioVideoModels.js';

describe('HM Studio additional video models', () => {
  it.each([
    [HM_STUDIO_FAST803_MODEL, 8, 0, 3, { '720p': 1.1, '1080p': 1.3, '2k': 1.5 }],
    [HM_STUDIO_FAST813_MODEL, 8, 1, 3, { '720p': 1.3, '1080p': 1.5, '2k': 1.7 }],
    [HM_STUDIO_MINI503_MODEL, 5, 0, 3, { '720p': 0.9 }],
  ] as const)('defines confirmed prices, limits and mapping for %s', (id, images, videos, audios, prices) => {
    const spec = getHmStudioAdditionalVideoModel(id)!;
    expect(getHmStudioUpstreamVideoModel(id)).toBe(id);
    expect(spec.defaultPrice).toBe(prices['720p']);
    expect(spec.resolutionPrices || { '720p': spec.defaultPrice }).toEqual(prices);
    for (const resolution of Object.keys(prices)) {
      const input = { seconds: 4, resolution, imageCount: images, videoCount: videos, audioCount: audios };
      expect(validateHmStudioAdditionalVideoInput(id, input)).toBeNull();
      expect(validateHmStudioAdditionalVideoInput(id, { ...input, seconds: 15 })).toBeNull();
      for (const seconds of [3, 16, 4.5, NaN]) {
        expect(validateHmStudioAdditionalVideoInput(id, { ...input, seconds })).toContain('4-15');
      }
      for (const extra of [{ imageCount: images + 1 }, { videoCount: videos + 1 }, { audioCount: audios + 1 }, { hasFirstFrame: true }, { hasLastFrame: true }]) {
        expect(validateHmStudioAdditionalVideoInput(id, { ...input, ...extra })).toContain('最多支持');
      }
      expect(normalizeHmStudioVideoResolution(id, resolution.toUpperCase())).toBe(resolution);
    }
    expect(normalizeHmStudioVideoResolution(id, undefined)).toBe('720p');
    expect(validateHmStudioAdditionalVideoInput(id, { seconds: 4, resolution: '480p', imageCount: 0, videoCount: 0, audioCount: 0 })).not.toBeNull();
    if (id === HM_STUDIO_MINI503_MODEL) {
      expect(validateHmStudioAdditionalVideoInput(id, { seconds: 4, resolution: '1080p', imageCount: 0, videoCount: 0, audioCount: 0 })).toContain('720p');
    }
  });
  it('maps public model ids to the current HM upstream model names', () => {
    expect(getHmStudioUpstreamVideoModel('seedance_v2.5')).toBe('MINIMAX-H3-2.5采样');
    expect(getHmStudioUpstreamVideoModel(HM_STUDIO_SEEDANCE_V20_933_MODEL)).toBe('MINIMAX-H3-2.0采样-933');
    expect(getHmStudioUpstreamVideoModel(HM_STUDIO_SEEDANCE_V25_101010_MODEL)).toBe('MINIMAX-H3-2.5采样-101010');
    expect(getHmStudioUpstreamVideoModel(HM_STUDIO_SEEDANCE_V25_301010_MODEL)).toBe('MINIMAX-H3-2.5采样-301010');
  });

  it('defines the HM mixed-material models with their documented limits', () => {
    expect(getHmStudioAdditionalVideoModel(HM_STUDIO_SEEDANCE_V20_933_MODEL)).toMatchObject({
      faceRestricted: true,
      maxImages: 9,
      maxVideos: 3,
      maxAudios: 3,
      defaultPrice: 0.5,
    });
    expect(getHmStudioAdditionalVideoModel(HM_STUDIO_SEEDANCE_V25_101010_MODEL)).toMatchObject({
      faceRestricted: true,
      maxImages: 10,
      maxVideos: 10,
      maxAudios: 10,
      defaultPrice: 0.7,
    });
    expect(getHmStudioAdditionalVideoModel(HM_STUDIO_SEEDANCE_V25_301010_MODEL)).toMatchObject({
      faceRestricted: true,
      maxImages: 30,
      maxVideos: 10,
      maxAudios: 10,
      defaultPrice: 5.5,
      supportsDedicatedFrames: true,
    });
  });

  it('accepts each model at its documented material limit', () => {
    expect(validateHmStudioAdditionalVideoInput(HM_STUDIO_SEEDANCE_V20_933_MODEL, {
      seconds: 15, resolution: '720p', imageCount: 9, videoCount: 3, audioCount: 3,
    })).toBeNull();
    expect(validateHmStudioAdditionalVideoInput(HM_STUDIO_SEEDANCE_V25_101010_MODEL, {
      seconds: 30, resolution: '720p', imageCount: 10, videoCount: 10, audioCount: 10,
    })).toBeNull();
    expect(validateHmStudioAdditionalVideoInput(HM_STUDIO_SEEDANCE_V25_301010_MODEL, {
      seconds: 30, resolution: '720p', imageCount: 29, videoCount: 10, audioCount: 10,
      hasFirstFrame: true,
    })).toBeNull();
  });

  it('rejects unsupported resolution, duration, and excess media', () => {
    expect(validateHmStudioAdditionalVideoInput(HM_STUDIO_SEEDANCE_V20_933_MODEL, {
      seconds: 16, resolution: '720p', imageCount: 0, videoCount: 0, audioCount: 0,
    })).toContain('4-15');
    expect(validateHmStudioAdditionalVideoInput(HM_STUDIO_SEEDANCE_V25_101010_MODEL, {
      seconds: 10, resolution: '1080p', imageCount: 0, videoCount: 0, audioCount: 0,
    })).toContain('720p');
    expect(validateHmStudioAdditionalVideoInput(HM_STUDIO_SEEDANCE_V20_933_MODEL, {
      seconds: 10, resolution: '720p', imageCount: 9, videoCount: 4, audioCount: 3,
    })).toContain('9 张图片、3 个视频和 3 段音频');
    expect(validateHmStudioAdditionalVideoInput(HM_STUDIO_SEEDANCE_V25_301010_MODEL, {
      seconds: 10, resolution: '720p', imageCount: 31, videoCount: 10, audioCount: 10,
    })).toContain('30 张图片、10 个视频和 10 段音频');
  });
});
