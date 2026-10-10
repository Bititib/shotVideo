import { canonicalZonghengModelId } from '../../shared/zonghengVideo.js';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { models, settings } from '../db/schema.js';

const ALIAS_KEY = 'public_model_name_aliases_v1';
type Model = typeof models.$inferSelect;

function aliases(database = db): Record<string, number> {
  const row = database.select().from(settings).where(eq(settings.key, ALIAS_KEY)).get();
  const value = JSON.parse(row?.value || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid model aliases');
  return Object.assign(Object.create(null), value);
}

export class PublicModelNameError extends Error {
  status = 409;
}

/** Resolve before permissions, pricing and routing; unknown legacy IDs retain their old behavior. */
export function resolvePublicModelId(value: string): string {
  const rows = db.select().from(models).all();
  const oldAlias = aliases()[value];
  const matches = rows.filter(row => row.modelId === value || row.modelId === canonicalZonghengModelId(value) || row.displayName === value || row.id === oldAlias);
  if (matches.length > 1) throw new PublicModelNameError(`模型名称“${value}”存在冲突，请管理员设置唯一名称`);
  return matches[0]?.modelId || value;
}

export function publicModelName(model: Pick<Model, 'modelId' | 'displayName'>): string {
  const name = model.displayName || model.modelId;
  if (resolvePublicModelId(name) !== model.modelId) {
    throw new PublicModelNameError(`模型名称“${name}”与其他模型 ID 冲突`);
  }
  return name;
}

export function validatePublicModelName(modelId: string, name: string, excludeId?: number) {
  if (typeof name !== 'string' || !name.trim()) throw new PublicModelNameError('模型名称必须是非空文本');
  const rows = db.select().from(models).all();
  const saved = aliases();
  for (const value of new Set([modelId, name])) {
    if (rows.some(row => row.id !== excludeId && (row.modelId === value || row.displayName === value))
      || (saved[value] !== undefined && saved[value] !== excludeId)) {
      throw new PublicModelNameError(`名称或 ID“${value}”已被其他模型或历史别名使用`);
    }
  }
}

/** Persist old names in the same transaction as an admin rename; no upstream mappings are changed. */
export function rememberPublicModelNames(model: Model, database = db) {
  const saved = aliases(database);
  const otherModels = database.select().from(models).all().filter(row => row.id !== model.id);
  for (const value of [model.modelId, model.displayName]) {
    if (!value) continue;
    // Let administrators repair an existing duplicate name without reserving it for the wrong model.
    if (otherModels.some(row => row.modelId === value || row.displayName === value)) continue;
    if (saved[value] !== undefined && saved[value] !== model.id) {
      throw new PublicModelNameError(`历史名称“${value}”存在冲突`);
    }
    saved[value] = model.id;
  }
  database.insert(settings).values({ key: ALIAS_KEY, value: JSON.stringify(saved), label: 'API 模型历史名称映射' })
    .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(saved) } }).run();
}
