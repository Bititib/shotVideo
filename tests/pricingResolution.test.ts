import { describe, expect, it } from 'vitest';
import { isResolutionPriceKey, pricingResolutionFields } from '../client/src/utils/pricingResolution.js';

describe('pricing resolution fields', () => {
  it('recognizes common resolution price keys', () => {
    expect(isResolutionPriceKey('480p')).toBe(true);
    expect(isResolutionPriceKey('1080P')).toBe(true);
    expect(isResolutionPriceKey('2k')).toBe(true);
    expect(isResolutionPriceKey('duration')).toBe(false);
  });

  it('always exposes the three WAN resolution prices independently', () => {
    expect(pricingResolutionFields('wan3.0-video', {
      category: 'video',
      '480p': 0.12,
      '720p': 0.14,
      '1080p': 0.16,
    })).toEqual({
      keys: ['480p', '720p', '1080p'],
      values: { '480p': 0.12, '720p': 0.14, '1080p': 0.16 },
      otherText: '',
    });
  });

  it('keeps non-resolution extras in the advanced field', () => {
    expect(pricingResolutionFields('custom-video', {
      category: 'video',
      '768p': 0.18,
      quality: 2,
    })).toEqual({
      keys: ['768p'],
      values: { '768p': 0.18 },
      otherText: 'quality: 2',
    });
  });
});
