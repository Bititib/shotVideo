import { describe, expect, it } from 'vitest';
import { calculateSuccessRate, isWithinRecentDays } from '../server/services/successRateService.js';

describe('success rate smoothing', () => {
  it('uses a neutral 60% reference rate with no recent samples', () => {
    expect(calculateSuccessRate(0, 0)).toEqual({ rate: 60, estimated: true, sampleSize: 0 });
  });

  it('keeps sparse failure-only samples within the 50%-70% reference band', () => {
    expect(calculateSuccessRate(0, 1).rate).toBe(54.5);
    expect(calculateSuccessRate(0, 3).rate).toBe(50);
  });

  it('uses the observed rate once there are enough samples', () => {
    expect(calculateSuccessRate(8, 2)).toEqual({ rate: 80, estimated: false, sampleSize: 10 });
  });

  it('recognizes SQLite timestamps inside the recent window', () => {
    const now = Date.UTC(2026, 7, 27, 12, 0, 0);
    expect(isWithinRecentDays('2026-08-20 10:00:00', 30, now)).toBe(true);
    expect(isWithinRecentDays('2026-06-01 10:00:00', 30, now)).toBe(false);
  });
});
