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

/** YYYY-MM-DD calendar key in Beijing, independent of the server/browser timezone. */
export function beijingDateKey(value: Date | number = Date.now()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Beijing calendar date keys ending with today. */
export function recentBeijingDateKeys(days: number, value: Date | number = Date.now()): string[] {
  const count = Math.max(0, Math.floor(days));
  const today = beijingDateKey(value);
  const bounds = beijingDayBounds(today);
  if (!bounds) return [];
  const todayStart = Date.parse(bounds.start.replace(' ', 'T') + 'Z');
  return Array.from({ length: count }, (_, index) =>
    beijingDateKey(todayStart - (count - 1 - index) * 86400000),
  );
}

/** Convert a stored UTC timestamp to the value expected by a Beijing datetime-local input. */
export function formatBeijingLocalInput(value: unknown): string {
  const timestamp = parseUtcTimestamp(value);
  if (!Number.isFinite(timestamp)) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(timestamp);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

/** Convert a Beijing datetime-local input to an absolute UTC ISO timestamp. */
export function beijingLocalInputToUtc(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const local = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(local)) return null;
  const timestamp = Date.parse(`${local.length === 16 ? `${local}:00` : local}+08:00`);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/** UTC boundaries for an inclusive Beijing calendar date filter. */
export function beijingDayBounds(day: string): { start: string; end: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const start = Date.parse(`${day}T00:00:00+08:00`);
  if (!Number.isFinite(start)) return null;
  const sqliteTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  return { start: sqliteTime(start), end: sqliteTime(start + 86400000) };
}
