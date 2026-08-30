import { describe, expect, it } from 'vitest';
import { isOmniVideoEditModel } from '../client/src/utils/videoModelCapabilities.js';

describe('video model capabilities', () => {
  it('recognizes both Omni video-edit model IDs', () => {
    expect(isOmniVideoEditModel('omni-flash-vref')).toBe(true);
    expect(isOmniVideoEditModel('veo-omni-flash-video-edit')).toBe(true);
    expect(isOmniVideoEditModel('veo-omni-flash')).toBe(false);
  });
});
