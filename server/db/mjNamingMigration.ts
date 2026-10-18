import type Database from 'better-sqlite3';
import { LEGACY_MJ_MODEL_ID, MJ_FAMILY, MJ_MODEL_ID, normalizeMjModelId } from '../../shared/mj.js';
import { normalizeMjBaseUrl } from '../services/mjAdapter.js';

const modelKeys = new Set(['model', 'modelId', 'requestedModel', 'actualModel', 'executionModel', 'upstreamModel', 'modelPattern']);
const modelArrays = new Set(['aliases', 'supportedModels', 'allowedModels']);

/** Rewrite identifiers only. Prompts, saved image URLs, receipts and prices stay intact. */
function renameIdentifiers(value: any, key = ''): any {
  if (typeof value === 'string') {
    if (modelKeys.has(key) || modelArrays.has(key) || !key) return normalizeMjModelId(value);
    if (key === 'imageFamily' && value === 'kmai-mj-imagine') return MJ_FAMILY;
    if (['type', 'provider'].includes(key) && value === 'kmai') return 'mj';
    if (key === 'id' && /^kmai-mj-\d+$/.test(value)) return value.replace('kmai-mj-', 'mj-');
    return value;
  }
  if (Array.isArray(value)) return value.map(item => renameIdentifiers(item, key));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [normalizeMjModelId(name), renameIdentifiers(item, name)]));
}

/** Runs before task recovery, retaining numeric model IDs and their access/price relations. */
export function migrateMjNaming(sqlite: Database.Database) {
  const hasColumn = (table: string, column: string) => (sqlite.pragma('table_info(' + table + ')') as { name: string }[]).some(item => item.name === column);
  sqlite.transaction(() => {
    if (hasColumn('models', 'model_id')) {
      const legacy = sqlite.prepare('SELECT id, display_name FROM models WHERE model_id = ?').get(LEGACY_MJ_MODEL_ID) as { id: number; display_name: string } | undefined;
      if (legacy) {
        if (sqlite.prepare('SELECT id FROM models WHERE model_id = ?').get(MJ_MODEL_ID)) throw new Error('MJ 模型 ID 已存在，请先合并重复配置');
        sqlite.prepare('UPDATE models SET model_id = ?, provider = ?, display_name = ? WHERE model_id = ?')
          .run(MJ_MODEL_ID, 'mj', legacy.display_name.replace(/（kmai）|\(kmai\)/gi, '').replace(/kmai/gi, 'MJ').trim() || 'MJ · 1K', LEGACY_MJ_MODEL_ID);
      }
    }
    if (hasColumn('channels', 'type')) {
      const rows = sqlite.prepare("SELECT id, name, base_url FROM channels WHERE type IN ('kmai', 'mj')").all() as { id: number; name: string; base_url: string }[];
      for (const row of rows) sqlite.prepare('UPDATE channels SET type = ?, name = ?, base_url = ? WHERE id = ?')
        .run('mj', row.name.replace(/kmai\s*[·-]?\s*/gi, '').trim() || 'MJ', normalizeMjBaseUrl(row.base_url), row.id);
    }
    for (const [table, column] of [['model_pricing','model_pattern'], ['contents','model_id'], ['api_logs','model'], ['model_feedbacks','model_id']]) {
      if (hasColumn(table, column)) sqlite.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(MJ_MODEL_ID, LEGACY_MJ_MODEL_ID);
    }
    for (const [table, column] of [['channels','supported_models'], ['channels','model_mapping'], ['api_tokens','allowed_models'],
      ['settings','value'], ['contents','metadata'], ['canvas_workspaces','document'], ['comic_drama_tasks','payload'],
      ['comic_drama_projects','state'], ['comic_drama_episodes','state']]) {
      if (!hasColumn(table, column)) continue;
      const rows = sqlite.prepare(`SELECT rowid AS row_key, ${column} AS value FROM ${table} WHERE instr(${column}, 'kmai') > 0`).all() as { row_key: number; value: string }[];
      for (const row of rows) {
        let value: string;
        try { value = JSON.stringify(renameIdentifiers(JSON.parse(row.value))); } catch { continue; }
        if (value !== row.value) sqlite.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`).run(value, row.row_key);
      }
    }
  })();
}
