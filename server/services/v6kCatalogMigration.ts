import type Database from 'better-sqlite3';

// Only used to retire configuration, never as a callable model catalog.
const retiredIds = ['QQsedanco2.5/720', 'Cseadanco2.5K', 'Xminimex-h3', 'wan-1080',
  'sedanco2.0-300秒必出', 'A-SD2.0', 'kksedanco2.5', 'LLseadanco2.51', 'TTsedanco2.5-480',
  'TTseadanco2.5-720', 'KKseadanco2.5X', 'MMseadanco2.5-PRO'];

/** One-time removal from live configuration; retain a private database archive for recovery.
 * Contents, usage/billing logs, balances and accepted V6K tasks are never changed here.
 */
export function migrateV6kCatalog(sqlite: Database.Database) {
  return sqlite.transaction(() => {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS v6k_catalog_migrations(version INTEGER PRIMARY KEY, completed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS v6k_retired_configuration(kind TEXT NOT NULL, source_id INTEGER NOT NULL,
        payload TEXT NOT NULL, retired_at TEXT NOT NULL, PRIMARY KEY(kind, source_id));`);
    if (sqlite.prepare('SELECT 1 FROM v6k_catalog_migrations WHERE version=1').get()) return { removedModels: 0, removedPrices: 0 };
    const now = new Date().toISOString();
    const archive = (kind: string, row: any) => sqlite.prepare('INSERT OR IGNORE INTO v6k_retired_configuration VALUES(?,?,?,?)')
      .run(kind, row.id, JSON.stringify(row), now);
    const hasTable = (name: string) => Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    const oldNames = new Set(retiredIds.flatMap(id => ['ZH-' + id, 'zongheng-' + id]));
    const rows = sqlite.prepare('SELECT * FROM models').all() as any[];
    const oldModels = rows.filter(row => row.provider === 'zongheng' || row.model_id.startsWith('zongheng-')
      || row.model_id.startsWith('ZH-') && row.provider !== 'zongheng-v6k' || oldNames.has(row.model_id));
    for (const row of oldModels) oldNames.add(row.model_id);
    const oldNumericIds = new Set(oldModels.map(row => row.id));
    const retainedModelNames = new Set(rows.filter(row => row.provider === 'zongheng-v6k' && !oldNumericIds.has(row.id)).map(row => row.model_id));
    const oldPrices = (sqlite.prepare('SELECT * FROM model_pricing').all() as any[])
      .filter(row => oldNames.has(row.model_pattern) || ['ZH-*', 'zongheng-*'].includes(row.model_pattern));
    for (const row of oldPrices) {
      archive('model_pricing', row);
      sqlite.prepare('DELETE FROM model_pricing WHERE id=?').run(row.id);
    }
    // Preserve associations privately before removing their obsolete parent models.
    for (const table of ['tier_model_access', 'user_model_access', 'user_model_pricing']) {
      if (!hasTable(table)) continue;
      for (const row of sqlite.prepare('SELECT * FROM ' + table).all() as any[]) {
        if (!oldNumericIds.has(row.model_id)) continue;
        archive(table, row);
        sqlite.prepare('DELETE FROM ' + table + ' WHERE id=?').run(row.id);
      }
    }
    for (const row of oldModels) {
      archive('models', row);
      sqlite.prepare('DELETE FROM models WHERE id=?').run(row.id);
    }
    const parse = (value: string, fallback: any) => { try { return JSON.parse(value); } catch { return fallback; } };
    for (const row of sqlite.prepare("SELECT * FROM channels WHERE type IN ('zongheng','zongheng-v6k')").all() as any[]) {
      const supported = parse(row.supported_models || '[]', []);
      const mapping = parse(row.model_mapping || '{}', {});
      const clean = (id: string) => retainedModelNames.has(id);
      const nextModels = Array.isArray(supported) ? supported.filter(id => typeof id === 'string' && clean(id)) : [];
      const nextMapping = Object.fromEntries(Object.entries(mapping || {}).filter(([id]) => nextModels.includes(id)));
      archive('channel_models', { id: row.id, supported_models: row.supported_models, model_mapping: row.model_mapping });
      sqlite.prepare('UPDATE channels SET supported_models=?,model_mapping=? WHERE id=?')
        .run(JSON.stringify(nextModels), JSON.stringify(nextMapping), row.id);
    }
    if (hasTable('settings')) {
      const aliases: any = sqlite.prepare("SELECT * FROM settings WHERE key='public_model_name_aliases_v1'").get();
      if (aliases) {
        const current = parse(aliases.value, {});
        archive('settings', aliases);
        const retained = Object.fromEntries(Object.entries(current).filter(([name, id]) => !oldNames.has(name) && !oldNumericIds.has(Number(id))));
        sqlite.prepare('UPDATE settings SET value=? WHERE id=?').run(JSON.stringify(retained), aliases.id);
      }
      const routes: any = sqlite.prepare("SELECT * FROM settings WHERE key='model_specification_routes_v1'").get();
      if (routes) {
        const current = parse(routes.value, []);
        if (!Array.isArray(current)) throw new Error('模型规格配置无效，停止旧目录清理');
        const channelIds = new Set((sqlite.prepare("SELECT id FROM channels WHERE type IN ('zongheng','zongheng-v6k')").all() as any[]).map(row => row.id));
        const retained = current.filter(spec => !oldNames.has(spec.modelId)).map(spec => ({ ...spec,
          aliases: (spec.aliases || []).filter((id: string) => !oldNames.has(id)),
          routes: (spec.routes || []).filter((route: any) => !channelIds.has(Number(route.channelId))
            || !oldNames.has(route.executionModel) && !retiredIds.includes(route.upstreamModel)),
        }));
        archive('settings', routes);
        sqlite.prepare('UPDATE settings SET value=? WHERE id=?').run(JSON.stringify(retained), routes.id);
      }
    }
    sqlite.prepare('INSERT INTO v6k_catalog_migrations VALUES(1,?)').run(now);
    return { removedModels: oldModels.length, removedPrices: oldPrices.length };
  })();
}
