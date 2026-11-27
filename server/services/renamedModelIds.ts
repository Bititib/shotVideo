import { sqlite } from '../db/index.js';

export const MODEL_ID_RENAMES_KEY = 'public_model_id_renames_v1';

/** Resolve only explicit ID renames. Display names and upstream IDs do not participate. */
export function renamedModelIds(): Map<string, string> {
  const row = sqlite.prepare('SELECT value FROM settings WHERE key=?').get(MODEL_ID_RENAMES_KEY) as { value: string } | undefined;
  if (!row) return new Map();
  const aliases: Record<string, number> = JSON.parse(row.value);
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)
    || !Object.values(aliases).every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('模型 ID 改名配置无效');
  const rows = sqlite.prepare('SELECT id,model_id FROM models').all() as { id: number; model_id: string }[];
  const byId = new Map(rows.map(model => [model.id, model.model_id]));
  const currentIds = new Set(byId.values());
  return new Map(Object.entries(aliases).flatMap(([oldId, numericId]) => {
    const current = byId.get(numericId);
    return current && !currentIds.has(oldId) ? [[oldId, current] as const] : [];
  }));
}

export function resolveRenamedModelId(id: string): string {
  return renamedModelIds().get(id) ?? id;
}
