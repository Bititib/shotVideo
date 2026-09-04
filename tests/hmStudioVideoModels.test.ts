import { describe, expect, it } from 'vitest';
import {
  getHmStudioAdditionalVideoModel,
  HM_STUDIO_SEEDANCE_V20_933_MODEL,
  HM_STUDIO_SEEDANCE_V25_101010_MODEL,
  validateHmStudioAdditionalVideoInput,
} from '../server/services/hmStudioVideoModels.js';

describe('HM Studio additional video models', () => {
  it('defines both models as face-restricted flat-rate HM models', () => {
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
  });

  it('accepts each model at its documented material limit', () => {
    expect(validateHmStudioAdditionalVideoInput(HM_STUDIO_SEEDANCE_V20_933_MODEL, {
      seconds: 15, resolution: '720p', imageCount: 9, videoCount: 3, audioCount: 3,
    })).toBeNull();
    expect(validateHmStudioAdditionalVideoInput(HM_STUDIO_SEEDANCE_V25_101010_MODEL, {
      seconds: 30, resolution: '720p', imageCount: 10, videoCount: 10, audioCount: 10,
    })).toBeNull();
  });

  it('rejects unsupported resolution, duration, excess media, and first/last frames', () => {
    expect(validateHmStudioAdditionalVideoInput(HM_STUDIO_SEEDANCE_V20_933_MODEL, {
      seconds: 16, resolution: '720p', imageCount: 0, videoCount: 0, audioCount: 0,
    })).toContain('4-15');
    expect(validateHmStudioAdditionalVideoInput(HM_STUDIO_SEEDANCE_V25_101010_MODEL, {
      seconds: 10, resolution: '1080p', imageCount: 0, videoCount: 0, audioCount: 0,
    })).toContain('720p');
    expect(validateHmStudioAdditionalVideoInput(HM_STUDIO_SEEDANCE_V20_933_MODEL, {
      seconds: 10, resolution: '720p', imageCount: 9, videoCount: 4, audioCount: 3,
    })).toContain('9 张图片、3 个视频和 3 段音频');
    expect(validateHmStudioAdditionalVideoInput(HM_STUDIO_SEEDANCE_V25_101010_MODEL, {
      seconds: 10, resolution: '720p', imageCount: 0, videoCount: 0, audioCount: 0, hasFirstFrame: true,
    })).toContain('首尾帧');
  });
});
