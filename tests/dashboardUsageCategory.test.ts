import { describe, expect, it } from 'vitest';
import { dashboardUsageCategory } from '../server/services/adminService';

describe('dashboard usage categories', () => {
  it('keeps generated media separate from analysis features', () => {
    expect(dashboardUsageCategory('generate_video')).toBe('video');
    expect(dashboardUsageCategory('generate_image')).toBe('image');
    expect(dashboardUsageCategory('generate_tts')).toBe('audio');
    expect(dashboardUsageCategory('image')).toBe('analysis');
    expect(dashboardUsageCategory('ecommerce')).toBe('analysis');
  });
});
