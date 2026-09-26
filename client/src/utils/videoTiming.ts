import { parseUtcTimestamp } from '../../../shared/time';

/** Total submission-to-result time, including queueing and saving the video. */
export function formatVideoGenerationTime(item: { status: string; createdAt: string; metadata?: unknown }): string {
  if (['processing', 'queued'].includes(item.status)) return '生成中';
  let meta: Record<string, any> = {};
  try {
    meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata || {};
  } catch { /* Older records may not have timing metadata. */ }
  if (!meta || typeof meta !== 'object') meta = {};
  const failed = ['failed', 'error'].includes(item.status);
  const start = parseUtcTimestamp(item.createdAt);
  const end = parseUtcTimestamp(failed ? meta.failedAt : meta.completedAt);
  // Prefer explicit timestamps: older durationMs values may have parsed UTC as local time.
  const duration = Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? end - start
    : (!failed && typeof meta.durationMs === 'number' ? meta.durationMs : NaN);
  if (!Number.isFinite(duration) || duration < 0) return '未记录';
  const seconds = Math.floor(duration / 1000);
  if (seconds < 1) return '不足1秒';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return `${hours ? `${hours}小时` : ''}${minutes ? `${minutes}分` : ''}${seconds % 60 || (!hours && !minutes) ? `${seconds % 60}秒` : ''}${failed ? '（至失败）' : ''}`;
}
