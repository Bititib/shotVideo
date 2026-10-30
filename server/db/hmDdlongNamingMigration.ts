import type Database from 'better-sqlite3';
import { HM_STUDIO_NOVA_MODEL, HM_STUDIO_LEGACY_NOVA_PUBLIC_MODEL, getHmStudioAdditionalVideoModel, normalizeHmStudioPublicModelId } from '../../shared/hmStudioVideo.js';

const modelFields = new Set(['model', 'modelId', 'requestedModel', 'actualModel', 'executionModel', 'modelPattern', 'videoModel']);
const modelArrays = new Set(['aliases', 'supportedModels', 'allowedModels', 'supported_models', 'allowed_models']);

// Never alter prompts, task IDs, upstream identities, results or financial receipts.
function renamePublicReferences(value: any, field: string): any {
  if (typeof value === 'string') return modelFields.has(field) || modelArrays.has(field) ? normalizeHmStudioPublicModelId(value) : value;
  if (Array.isArray(value)) return value.map(item => renamePublicReferences(item, field));
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    const renamed = normalizeHmStudioPublicModelId(key);
    if (renamed !== key && Object.hasOwn(value, renamed)) throw new Error('HM 933 配置存在新旧标识冲突，迁移未执行');
    result[renamed] = renamePublicReferences(item, key);
  }
  return result;
}

/** Before catalog seeding: retain the model's numeric ID, prices, access and orders. */
export function migrateHmDdlongNaming(sqlite: Database.Database) {
  const hasColumn = (table: string, column: string) => (sqlite.pragma(`table_info(${table})`) as { name: string }[]).some(item => item.name === column);
  const oldId = HM_STUDIO_LEGACY_NOVA_PUBLIC_MODEL, newId = HM_STUDIO_NOVA_MODEL;
  sqlite.transaction(() => {
    if (hasColumn('models', 'model_id')) {
      const old = sqlite.prepare('SELECT id, provider, display_name FROM models WHERE model_id=?').get(oldId) as any;
      if (old) {
        if (old.provider !== 'hmstudio') throw new Error('旧 sd2.5 模型不属于 HM，933 迁移未执行');
        if (sqlite.prepare('SELECT id FROM models WHERE model_id=?').get(newId)) throw new Error('sd2.5-933 已存在，请先核对重复模型；原定价和权限未修改');
        sqlite.prepare('UPDATE models SET model_id=?, display_name=?, description=? WHERE id=?').run(newId,
          String(old.display_name).replace(/301010/g, '933'), getHmStudioAdditionalVideoModel(newId)!.description, old.id);
      }
    }
    if (hasColumn('model_pricing', 'model_pattern')) {
      const hasOld = sqlite.prepare('SELECT 1 FROM model_pricing WHERE model_pattern=?').get(oldId);
      if (hasOld && sqlite.prepare('SELECT 1 FROM model_pricing WHERE model_pattern=?').get(newId)) throw new Error('HM 933 新旧计费规则同时存在，迁移未执行');
      sqlite.prepare('UPDATE model_pricing SET model_pattern=? WHERE model_pattern=?').run(newId, oldId);
    }
    for (const [table, column] of [['contents', 'model_id'], ['model_feedbacks', 'model_id'], ['video_batches', 'model']]) {
      if (hasColumn(table, column)) sqlite.prepare(`UPDATE ${table} SET ${column}=? WHERE ${column}=?`).run(newId, oldId);
    }
    for (const [table, column] of [['channels', 'supported_models'], ['channels', 'model_mapping'], ['api_tokens', 'allowed_models'],
      ['settings', 'value'], ['contents', 'metadata'], ['canvas_workspaces', 'document'], ['video_batches', 'payload'],
      ['comic_drama_tasks', 'payload'], ['comic_drama_projects', 'state'], ['comic_drama_episodes', 'state']]) {
      if (!hasColumn(table, column)) continue;
      const rows = sqlite.prepare(`SELECT rowid AS row_key, ${column} AS value FROM ${table} WHERE instr(${column}, ?) > 0`).all(oldId) as {row_key: number; value: string}[];
      for (const row of rows) {
        let parsed: any;
        try { parsed = JSON.parse(row.value); } catch { continue; }
        const updated = JSON.stringify(renamePublicReferences(parsed, column));
        if (updated !== row.value) sqlite.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`).run(updated, row.row_key);
      }
    }
  })();
}
