import { describe, expect, it } from 'vitest';
import { beijingDateKey, beijingDayBounds, beijingLocalInputToUtc, formatBeijingLocalInput, formatBeijingTime, parseUtcTimestamp, recentBeijingDateKeys } from '../shared/time';
import { formatContentGenerationTime, formatVideoGenerationTime } from '../client/src/utils/videoTiming';

describe('Beijing timestamps and video elapsed time', () => {
  it('treats SQLite timestamps as UTC and preserves explicit offsets', () => {
    const utc = parseUtcTimestamp('2026-09-26 16:05:06');
    expect(utc).toBe(Date.parse('2026-09-26T16:05:06Z'));
    expect(parseUtcTimestamp('2026-09-27T00:05:06+08:00')).toBe(utc);
    expect(parseUtcTimestamp('2026-09-26T16:05:06')).toBe(utc);
    expect(formatBeijingTime('2026-09-26 16:05:06')).toBe('2026/09/27 00:05:06');
    expect(formatBeijingTime('invalid')).toBe('—');
  });

  it('filters complete Beijing days with an exclusive end boundary', () => {
    expect(beijingDayBounds('2026-09-27')).toEqual({ start: '2026-09-26 16:00:00', end: '2026-09-27 16:00:00' });
    expect(beijingDayBounds('invalid')).toBeNull();
  });

  it('builds Beijing calendar keys without depending on the machine timezone', () => {
    expect(beijingDateKey(Date.parse('2026-10-18T15:59:59Z'))).toBe('2026-10-18');
    expect(beijingDateKey(Date.parse('2026-10-18T16:00:00Z'))).toBe('2026-10-19');
    expect(recentBeijingDateKeys(3, Date.parse('2026-10-18T16:30:00Z'))).toEqual([
      '2026-10-17', '2026-10-18', '2026-10-19',
    ]);
  });

  it('round-trips Beijing datetime-local values through UTC storage', () => {
    expect(beijingLocalInputToUtc('2026-10-19T18:30')).toBe('2026-10-19T10:30:00.000Z');
    expect(formatBeijingLocalInput('2026-10-19T10:30:00.000Z')).toBe('2026-10-19T18:30');
    expect(beijingLocalInputToUtc('')).toBeNull();
  });

  it('calculates elapsed time across mixed SQLite/ISO timestamps, ignoring old timezone-skewed duration', () => {
    expect(formatVideoGenerationTime({ status: 'completed', createdAt: '2026-09-26 16:00:00', metadata: JSON.stringify({ completedAt: '2026-09-27T00:02:35+08:00', durationMs: 28955000, seconds: 10 }) })).toBe('2分35秒');
  });

  it('distinguishes pending, failed, missing and duration-only historical records', () => {
    const item = { createdAt: '2026-09-26 16:00:00', metadata: {} };
    expect(formatVideoGenerationTime({ ...item, status: 'processing' })).toBe('生成中');
    expect(formatVideoGenerationTime({ ...item, status: 'completed' })).toBe('未记录');
    expect(formatVideoGenerationTime({ ...item, status: 'completed', metadata: { durationMs: 3605000 } })).toBe('1小时5秒');
    expect(formatVideoGenerationTime({ ...item, status: 'failed', metadata: { failedAt: '2026-09-26T16:01:00Z' } })).toBe('1分（至失败）');
    expect(formatVideoGenerationTime({ ...item, status: 'completed', metadata: { completedAt: 'invalid', durationMs: -1 } })).toBe('未记录');
  });

  it('formats persisted image generation timing with the same submission-to-result rule', () => {
    expect(formatContentGenerationTime({
      status: 'completed',
      createdAt: '2026-09-30 05:50:00',
      metadata: { completedAt: '2026-09-30T05:50:42.500Z', durationMs: 42_500 },
    })).toBe('42秒');
  });
});
