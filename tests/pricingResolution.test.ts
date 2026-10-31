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
    expect(pricingResolutionFields('wan3.0-video-nsfw', {
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

  it.each(['gpt-image-2-mingfei', 'gpt-image-2-5-sunburst'])('exposes %s 1K, 2K and 4K prices independently', model => {
    expect(pricingResolutionFields(model, { category: 'image' })).toEqual({
      keys: ['1K', '2K', '4K'],
      values: { '1K': '', '2K': '', '4K': '' },
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

  it.each(['sd2.5-933', 'sd2.5-301010', '30-10-10', 'DDLONG-SD2.5'])('exposes current DDLONG resolution for an empty %s rule without inventing prices', model => {
    expect(pricingResolutionFields(model, { category: 'video' })).toEqual({
      keys: ['720p'], values: { '720p': '' }, otherText: '',
    });
  });

  it('preserves custom and case-insensitive HM resolution prices without duplicate controls', () => {
    expect(pricingResolutionFields('sd2.5-301010', { '720P': 0, '1080p': 13, quality: 2 })).toEqual({
      keys: ['720P'], values: { '720P': 0 }, otherText: 'quality: 2',
    });
    expect(pricingResolutionFields('SD2.0FAST803').keys).toEqual(['720p', '1080p', '2k']);
    expect(pricingResolutionFields('SD2.0MINI503').keys).toEqual(['720p']);
  });
});

it.each(['MiniMax-H3','MINIMAXH3 9-3-3'])('shows both H3 resolution pricing fields for %s',model=>{
  expect(pricingResolutionFields(model,{category:'video','720p':1.5,'2k':2.2})).toEqual({keys:['720p','2k'],values:{'720p':1.5,'2k':2.2},otherText:''});
});
