import type Database from 'better-sqlite3';
import { FUNAI_MODEL_PREFIX, FUNAI_OMNI_FLASH_11_MODEL, FUNAI_OMNI_FLASH_ENTRY } from '../../shared/funAi.js';

const ROUTES_KEY = 'model_specification_routes_v1';
const MIGRATION_KEY = 'funai_omni_flash_11_switch_v1';
const oldEntries = new Set([FUNAI_OMNI_FLASH_ENTRY, FUNAI_MODEL_PREFIX + FUNAI_OMNI_FLASH_ENTRY]);

/** One-time config change. Accepted tasks and all financial data are untouched. */
export function migrateFunAiOmniFlash11(sqlite: Database.Database) {
  return sqlite.transaction(() => migrateConfiguration(sqlite))();
}

function migrateConfiguration(sqlite: Database.Database) {
  if (sqlite.prepare('SELECT 1 FROM settings WHERE key=?').get(MIGRATION_KEY)) return;
  const channelRows = sqlite.prepare('SELECT id,type,base_url,model_mapping,supported_models FROM channels').all() as any[];
  const relevant = channelRows.filter(channel => {
    if (channel.type === 'funai') return true;
    try { return new URL(channel.base_url).hostname === 'ztyunjuan.com'; } catch { return false; }
  });
  if (!relevant.length) return;
  const config = sqlite.prepare('SELECT value FROM settings WHERE key=?').get(ROUTES_KEY) as { value: string } | undefined;
  const specs = config ? JSON.parse(config.value) : [];
  if (!Array.isArray(specs)) throw new Error('Omni 模型切换：原规格配置不是数组，未修改配置');
  const changedChannels: { id: number; mapping: string }[] = [];
  for (const channel of relevant) {
    const mapping = JSON.parse(channel.model_mapping || '{}'), supported = JSON.parse(channel.supported_models || '[]');
    if (!mapping || Array.isArray(mapping) || typeof mapping !== 'object' || !Array.isArray(supported)) throw new Error('Omni 模型切换：原渠道映射格式无效，未修改配置');
    let changed = false;
    for (const [key, value] of Object.entries(mapping)) {
      if (value === FUNAI_OMNI_FLASH_ENTRY) { mapping[key] = FUNAI_OMNI_FLASH_11_MODEL; changed = true; }
    }
    for (const entry of supported) {
      if (oldEntries.has(entry) && !mapping[entry]) { mapping[entry] = FUNAI_OMNI_FLASH_11_MODEL; changed = true; }
    }
    if (changed) changedChannels.push({ id: channel.id, mapping: JSON.stringify(mapping) });
  }
  const ids = new Set(relevant.map(channel => channel.id));
  let routesChanged = false;
  for (const spec of specs) for (const route of spec.routes || []) {
    if (ids.has(route.channelId) && route.upstreamModel === FUNAI_OMNI_FLASH_ENTRY) {
      route.upstreamModel = FUNAI_OMNI_FLASH_11_MODEL; routesChanged = true;
    }
  }
  for (const channel of changedChannels) sqlite.prepare("UPDATE channels SET model_mapping=?,updated_at=datetime('now') WHERE id=?").run(channel.mapping, channel.id);
  if (routesChanged) sqlite.prepare("UPDATE settings SET value=?,updated_at=datetime('now') WHERE key=?").run(JSON.stringify(specs), ROUTES_KEY);
  sqlite.prepare('INSERT INTO settings(key,value,label) VALUES(?,?,?)').run(MIGRATION_KEY, 'done', 'Omni Flash 1.1 上游型号切换');
}
