import type Database from 'better-sqlite3';
import { BB_HSS_SOURCE_KEY, BB_HSS_SOURCES, type BbHssSourceSelection } from '../../shared/bbHssSources.js';
import type { ModelRoute } from '../../shared/modelRouting.js';

export function readBbHssSources(d: Database.Database): Record<string, BbHssSourceSelection> {
  const row = d.prepare('SELECT value FROM settings WHERE key=?').get(BB_HSS_SOURCE_KEY) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : {};
}
/** No saved choice retains the previous KK-only behavior. Accepted receipts do not use this policy. */
export function matchesBbHssSource(d: Database.Database, id: string, route: ModelRoute, type?: string): boolean {
  const selected = readBbHssSources(d)[id], source = BB_HSS_SOURCES[selected?.source || 'KK'];
  return Boolean(source && route.executionModel === id && route.upstreamModel === source.upstreamModel && type === source.type
    && (!selected || selected.channelId === route.channelId));
}
