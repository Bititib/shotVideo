import type Database from 'better-sqlite3';
import { V6K_BASE_URL, V6K_CHANNEL_TYPE, retiredZonghengBase, RETIRED_ZONGHENG_MESSAGE } from './zonghengProtocol.js';

/** Retire the old transport without deleting records or changing any balance. */
export function migrateZonghengToV6k(sqlite: Database.Database) {
  return sqlite.transaction(() => {
    const channels = sqlite.prepare("SELECT id,type,base_url FROM channels WHERE type IN ('zongheng','zongheng-v6k')").all() as any[];
    const ids = new Set(channels.map(c => c.id));
    const tasks = sqlite.prepare("SELECT id,metadata FROM contents WHERE type='video' AND status IN ('processing','queued','review')").all() as any[];
    let retired = 0;
    for (const row of tasks) {
      let meta: any; try { meta = JSON.parse(row.metadata || '{}'); } catch { continue; }
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
      if (!ids.has(Number(meta.channelId)) || meta.zonghengProtocol === 'v6k' || meta.zonghengLegacyTask) continue;
      Object.assign(meta, { zonghengLegacyTask: true, requiresReview: true,
        reviewKind: meta.videoId || meta.upstreamTaskId ? 'query' : 'submission',
        progressText: RETIRED_ZONGHENG_MESSAGE, error: RETIRED_ZONGHENG_MESSAGE });
      sqlite.prepare("UPDATE contents SET status='review',metadata=? WHERE id=?").run(JSON.stringify(meta), row.id);
      retired++;
    }
    for (const channel of channels) {
      const obsolete = retiredZonghengBase(channel.base_url);
      if (obsolete) {
        // The new site requires its own token. Do not spend with an unverified old key.
        sqlite.prepare('UPDATE channels SET type=?,base_url=?,status=0,max_retries=0 WHERE id=?')
          .run(V6K_CHANNEL_TYPE, V6K_BASE_URL, channel.id);
      } else sqlite.prepare('UPDATE channels SET type=?,max_retries=0 WHERE id=?').run(V6K_CHANNEL_TYPE, channel.id);
    }
    return { retiredTasks: retired };
  })();
}
