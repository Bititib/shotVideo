import { parseUtcTimestamp } from '../../shared/time.js';
import type { VideoModelStatus } from '../../shared/videoModelStatus.js';

type VideoStatusRecord = { id?: number; status: string | null; resultUrl?: string | null; createdAt?: string | null };

/** Passive observation only: never creates paid tasks or probes the upstream. */
export function calculateVideoModelStatus(
  records: readonly VideoStatusRecord[], available: boolean, now = Date.now(),
): VideoModelStatus {
  const result = (state: VideoModelStatus['state'], reason: VideoModelStatus['reason']): VideoModelStatus =>
    ({ state, reason, checkedAt: new Date(now).toISOString() });
  if (!available) return result('unavailable', 'no_channel');
  const recent = records.map(row => ({ ...row, time: parseUtcTimestamp(row.createdAt) }))
    .filter(row => Number.isFinite(row.time) && row.time >= now - 86400000 && row.time <= now
      && ['failed', 'error', 'completed', 'success'].includes(row.status || ''))
    .sort((a, b) => b.time - a.time || (b.id || 0) - (a.id || 0))
    .slice(0, 20);
  const succeeded = (row: VideoStatusRecord) =>
    (row.status === 'completed' || row.status === 'success') && Boolean(row.resultUrl?.trim());
  if (recent.length >= 3 && recent.slice(0, 3).every(row => !succeeded(row))) {
    return result('unavailable', 'consecutive_failures');
  }
  if (recent.some(row => !succeeded(row))) return result('degraded', 'recent_failures');
  if (recent.length < 3) return result('unknown', 'insufficient_data');
  return result('healthy', 'recent_successes');
}
