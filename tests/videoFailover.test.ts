import { describe, expect, it } from 'vitest';
import {
  canUseMjOverflowModel,
  isHmStudioConcurrencyError,
  shouldOverflowHmStudio,
} from '../server/services/videoFailoverService.js';

const compatibleRequest = {
  requestedModel: 'seedance_v2.5',
  resolution: '720p',
  seconds: 10,
  imageCount: 9,
  videoCount: 0,
  audioCount: 0,
};

describe('HM Studio to MJ video failover', () => {
  it('uses xd-seedance only when the HM pool is full and MJ is available', () => {
    expect(shouldOverflowHmStudio({
      ...compatibleRequest,
      poolLoad: 10,
      poolLimit: 10,
      fallbackAvailable: true,
    })).toBe(true);

    expect(shouldOverflowHmStudio({
      ...compatibleRequest,
      poolLoad: 9,
      poolLimit: 10,
      fallbackAvailable: true,
    })).toBe(false);
  });

  it('never drops incompatible reference material to force failover', () => {
    expect(canUseMjOverflowModel({ ...compatibleRequest, imageCount: 10 })).toBe(false);
    expect(canUseMjOverflowModel({ ...compatibleRequest, videoCount: 1 })).toBe(false);
    expect(canUseMjOverflowModel({ ...compatibleRequest, audioCount: 1 })).toBe(false);
    expect(canUseMjOverflowModel({ ...compatibleRequest, resolution: '480p' })).toBe(false);
  });

  it('recognizes explicit upstream concurrency errors but not ordinary failures', () => {
    expect(isHmStudioConcurrencyError(429, 'upstream concurrency limit reached')).toBe(true);
    expect(isHmStudioConcurrencyError(503, '当前并发已满，请稍后')).toBe(true);
    expect(isHmStudioConcurrencyError(400, 'invalid aspect ratio')).toBe(false);
    expect(isHmStudioConcurrencyError(200, 'concurrency limit')).toBe(false);
  });
});

