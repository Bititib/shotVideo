import { describe, expect, it } from 'vitest';
import {
  isOmniVideoEditModel,
  isSnumomGrokImagineVideoModel,
  SNUMOM_GROK_IMAGINE_VIDEO_MODEL,
} from '../client/src/utils/videoModelCapabilities.js';

describe('video model capabilities', () => {
  it('recognizes both Omni video-edit model IDs', () => {
    expect(isOmniVideoEditModel('omni-flash-vref')).toBe(true);
    expect(isOmniVideoEditModel('veo-omni-flash-video-edit')).toBe(true);
    expect(isOmniVideoEditModel('veo-omni-flash')).toBe(false);
  });

  it('recognizes the exact snumom Grok per-request model ID', () => {
    expect(SNUMOM_GROK_IMAGINE_VIDEO_MODEL).toBe('grok-imagine-video-1.5（按次）');
    expect(isSnumomGrokImagineVideoModel('grok-imagine-video-1.5（按次）')).toBe(true);
    expect(isSnumomGrokImagineVideoModel('grok-imagine-video-1.5')).toBe(false);
  });
});
