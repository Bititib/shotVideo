import type Database from 'better-sqlite3';
import { v6kTt25Product } from '../../shared/v6kTt25.js';

/** Withdraw only the V6K BB alternatives added to TT; accepted task metadata and finances remain intact. */
export function removeTtBbFallbacks(d: Database.Database) {
  return d.transaction(() => {
    const row = d.prepare('SELECT value FROM settings WHERE key=?').get('model_specification_routes_v1') as { value: string } | undefined;
    let removed = 0;
    if (row) {
      const specs = JSON.parse(row.value);
      if (!Array.isArray(specs)) throw new Error('模型规格配置格式无效，未移除 BB 备用');
      const channels = d.prepare('SELECT id,type FROM channels').all() as { id: number; type: string }[];
      for (const spec of specs) {
        if (!v6kTt25Product(spec.modelId) || !Array.isArray(spec.routes)) continue;
        spec.routes = spec.routes.filter((route: any) => {
          const bb = ['BBseadanco-480', 'BBseadanco-720'].includes(route.upstreamModel);
          const channel = channels.find(c => c.id === route.channelId);
          const ours = ['zongheng-v6k', 'zongheng'].includes(channel?.type || '') || String(route.id || '').startsWith('v6k-tt-bb-');
          if (bb && ours) { removed++; return false; }
          return true;
        });
      }
      if (removed) d.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(specs), 'model_specification_routes_v1');
    }
    d.prepare('DELETE FROM settings WHERE key=?').run('v6k_tt_bb_catalog_v1');
    return removed;
  })();
}
