/** SQLite datetime('now') and timezone-less application timestamps are UTC. */
export function parseUtcTimestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string' || !value.trim()) return NaN;
  let normalized = value.trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) normalized += 'T00:00:00';
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)) normalized += 'Z';
  return Date.parse(normalized);
}

export function formatBeijingTime(value: unknown, options?: Intl.DateTimeFormatOptions): string {
  const timestamp = parseUtcTimestamp(value);
  if (!Number.isFinite(timestamp)) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    ...(options || { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    timeZone: 'Asia/Shanghai',
    hourCycle: 'h23',
  }).format(timestamp);
}

/** UTC boundaries for an inclusive Beijing calendar date filter. */
export function beijingDayBounds(day: string): { start: string; end: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const start = Date.parse(`${day}T00:00:00+08:00`);
  if (!Number.isFinite(start)) return null;
  const sqliteTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  return { start: sqliteTime(start), end: sqliteTime(start + 86400000) };
}
