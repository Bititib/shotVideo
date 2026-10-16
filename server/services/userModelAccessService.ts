import { sqlite } from '../db/index.js';
import { ensureUserModelTables } from '../db/userModelMigration.js';

/** Missing override preserves each entry point's existing permission policy. */
export function modelAccessMode(userId: number | null | undefined, modelId: number): 'inherit' | 'allow' | 'deny' {
  if (!userId) return 'inherit';
  ensureUserModelTables(sqlite);
  return (sqlite.prepare('SELECT access_mode FROM user_model_access WHERE user_id=? AND model_id=?').get(userId, modelId) as any)?.access_mode || 'inherit';
}

export function filterUserModels<T extends { id: number }>(userId: number | null | undefined, candidates: T[], inheritedIds?: number[]): T[] {
  if (!userId) return inheritedIds ? candidates.filter(m => inheritedIds.includes(m.id)) : candidates;
  ensureUserModelTables(sqlite);
  const overrides = new Map((sqlite.prepare('SELECT model_id,access_mode FROM user_model_access WHERE user_id=?').all(userId) as any[])
    .map(row => [row.model_id, row.access_mode]));
  return candidates.filter(model => overrides.get(model.id) === 'allow'
    || (overrides.get(model.id) !== 'deny' && (!inheritedIds || inheritedIds.includes(model.id))));
}

/** Enforced at execution as well as discovery, including legacy media routes. */
export function assertUserModelAccess(userId: number | null | undefined, modelName: string) {
  if (!userId) return;
  const model = sqlite.prepare('SELECT id,is_active FROM models WHERE model_id=?').get(modelName) as any;
  if (model?.is_active === 0) throw Object.assign(new Error('该模型已被平台禁用'), { status: 404 });
  if (model && modelAccessMode(userId, model.id) === 'deny') {
    throw Object.assign(new Error('该用户已被禁止使用此模型'), { status: 403 });
  }
}

export function userModelDenied(userId: number | null | undefined, modelName: string): boolean {
  if (!userId) return false;
  const model = sqlite.prepare('SELECT id,is_active FROM models WHERE model_id=?').get(modelName) as any;
  return Boolean(model && modelAccessMode(userId, model.id) === 'deny');
}
