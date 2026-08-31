import { describe, expect, it } from 'vitest';
import {
  canUseMjOverflowModel,
  canUseSiYueTianJulunOverflow,
  canUseWxHaidiYueOverflow,
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

  it('does not overflow before the HM pool itself reaches capacity', () => {
    expect(shouldOverflowHmStudio({
      ...compatibleRequest,
      poolLoad: 2,
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

  it('uses wx-海底月 sd2.5 only for its narrower compatible request shape', () => {
    expect(canUseWxHaidiYueOverflow({ ...compatibleRequest, seconds: 30 })).toBe(true);
    expect(canUseWxHaidiYueOverflow({ ...compatibleRequest, seconds: 30, imageCount: 10 })).toBe(false);
    expect(canUseWxHaidiYueOverflow(compatibleRequest)).toBe(true);
    expect(canUseWxHaidiYueOverflow({ ...compatibleRequest, videoCount: 1 })).toBe(false);
    expect(canUseWxHaidiYueOverflow({ ...compatibleRequest, audioCount: 1 })).toBe(false);
    expect(canUseWxHaidiYueOverflow({ ...compatibleRequest, resolution: '480p' })).toBe(false);
  });

  it('routes fixed-30-second 四月天 sd2.5 only to Julun', () => {
    const siYueTianRequest = {
      ...compatibleRequest,
      requestedModel: 'sd2.5',
      seconds: 30,
    };
    expect(canUseSiYueTianJulunOverflow(siYueTianRequest)).toBe(true);
    expect(canUseWxHaidiYueOverflow(siYueTianRequest)).toBe(false);
    expect(canUseMjOverflowModel(siYueTianRequest)).toBe(false);
    expect(canUseSiYueTianJulunOverflow({ ...siYueTianRequest, seconds: 29 })).toBe(false);
    expect(canUseSiYueTianJulunOverflow({ ...siYueTianRequest, imageCount: 10 })).toBe(false);
  });

  it('recognizes explicit upstream concurrency errors but not ordinary failures', () => {
    expect(isHmStudioConcurrencyError(429, 'upstream concurrency limit reached')).toBe(true);
    expect(isHmStudioConcurrencyError(503, '当前并发已满，请稍后')).toBe(true);
    expect(isHmStudioConcurrencyError(503, '当前分组上游负载已饱和，请稍后再试')).toBe(true);
    expect(isHmStudioConcurrencyError(400, 'invalid aspect ratio')).toBe(false);
    expect(isHmStudioConcurrencyError(200, 'concurrency limit')).toBe(false);
  });
});
