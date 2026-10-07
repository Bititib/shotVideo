import { describe, expect, it } from 'vitest';
import { calculateVideoModelStatus } from '../server/services/videoModelStatusService.js';
import { currentVideoModelStatus } from '../shared/videoModelStatus.js';

const now = Date.parse('2026-10-07T04:00:00Z');
const row = (status: string, minutesAgo = 0, resultUrl = status === 'completed' ? '/video.mp4' : '') =>
  ({ status, resultUrl, createdAt: new Date(now - minutesAgo * 60000).toISOString() });

describe('video model status without synthetic success percentages', () => {
  it('keeps empty and small successful samples unknown', () => {
    for (const rows of [[], [row('completed')], [row('completed'), row('completed', 1)]]) {
      expect(calculateVideoModelStatus(rows, true, now).state).toBe('unknown');
    }
  });
  it('requires actual result URLs for a healthy state', () => {
    expect(calculateVideoModelStatus([row('completed'), row('completed', 1), row('completed', 2)], true, now).state).toBe('healthy');
    expect(calculateVideoModelStatus([row('completed', 0, ' ')], true, now).state).toBe('degraded');
  });
  it('shows an isolated failure as degraded, not an invented percentage', () => {
    expect(calculateVideoModelStatus([row('failed')], true, now)).toMatchObject({ state: 'degraded', reason: 'recent_failures' });
  });
  it('sorts records and only marks consecutive latest failures abnormal', () => {
    const rows = [row('failed', 2), row('completed', 3), row('failed', 0), row('failed', 1)];
    expect(calculateVideoModelStatus(rows, true, now)).toMatchObject({ state: 'unavailable', reason: 'consecutive_failures' });
    expect(calculateVideoModelStatus([...rows, row('completed', -0.01)], true, now).state).toBe('unavailable'); // future records excluded
    expect(calculateVideoModelStatus([row('completed'), row('failed', 1), row('failed', 2), row('failed', 3)], true, now).state).toBe('degraded');
  });
  it('ignores stale, malformed, pending and cancelled samples', () => {
    expect(calculateVideoModelStatus([row('failed', 1441), row('queued'), row('processing'), row('cancelled'),
      { ...row('failed'), createdAt: 'invalid' }], true, now).state).toBe('unknown');
  });
  it('limits the window to the latest twenty terminal records', () => {
    expect(calculateVideoModelStatus([...Array.from({ length: 20 }, (_, i) => row('completed', i)), row('failed', 21)], true, now).state).toBe('healthy');
  });
  it('uses the id to break ties for SQLite timestamps and reads UTC timestamps', () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, status: i ? 'failed' : 'completed', resultUrl: i ? '' : '/video', createdAt: '2026-10-07 04:00:00' }));
    expect(calculateVideoModelStatus(rows, true, now).state).toBe('unavailable');
  });
  it('marks disabled/unroutable channels unavailable even with old successes', () => {
    expect(calculateVideoModelStatus([row('completed')], false, now)).toMatchObject({ state: 'unavailable', reason: 'no_channel' });
  });
  it('does not reuse missing, stale or invalid cached statuses as healthy', () => {
    const status = calculateVideoModelStatus([row('completed'), row('completed', 1), row('completed', 2)], true, now);
    expect(currentVideoModelStatus(status, now).state).toBe('healthy');
    expect(currentVideoModelStatus(status, now + 120001).state).toBe('unknown');
    expect(currentVideoModelStatus(undefined, now).state).toBe('unknown');
    expect(currentVideoModelStatus({ ...status, state: 'fake' } as any, now).state).toBe('unknown');
  });
});
