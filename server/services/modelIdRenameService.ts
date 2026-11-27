import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { apiTokens, channels, models, modelPricing, settings } from '../db/schema.js';
import { rememberPublicModelNames, validatePublicModelName } from './publicModelNameService.js';
import { getModelSpecifications } from './modelRoutingService.js';
import { MODEL_ID_RENAMES_KEY } from './renamedModelIds.js';

const fail = (message: string) => Object.assign(new Error(message), { status: 409 });

/** Called inside the editor's immediate transaction, retaining numeric identity and original task receipts. */
export function renameSiYueTianModelId(channelId: number, oldId: string, newId: string, displayName: string) {
  if (oldId === newId) return;
  if (!sqlite.inTransaction) throw new Error('模型 ID 修改须在保存事务中执行');
  const model = db.select().from(models).where(eq(models.modelId, oldId)).get();
  if (!model) throw fail('原模型已变化，请重新打开后保存');
  validatePublicModelName(newId, displayName, model.id);
  const specs = getModelSpecifications();
  if (specs.some(spec => spec.modelId === newId || spec.aliases.includes(newId)
    || spec.routes.some(route => route.executionModel === newId))) throw fail('新模型 ID 已被其他规格或线路使用');
  const channelRows = db.select().from(channels).all();
  if (channelRows.some(channel => JSON.parse(channel.supportedModels).includes(newId)
    || Object.hasOwn(JSON.parse(channel.modelMapping), newId))) throw fail('新模型 ID 已被渠道关联使用');
  const rules = db.select().from(modelPricing).all();
  if (rules.some(rule => rule.modelPattern === newId)) throw fail('新模型 ID 已有价格配置，请使用其他 ID');

  const oldSpec = specs.find(spec => spec.modelId === oldId);
  if (model.provider !== 'siyuetian' || oldSpec?.kind !== 'video' || oldSpec.routes.length !== 1
    || !oldSpec.routes[0].siYueTianVideo || oldSpec.routes[0].channelId !== channelId
    || oldSpec.routes[0].executionModel !== oldId) throw fail('该模型须通过对应的专用配置修改');
  if (specs.some(spec => spec.modelId !== oldId && (spec.aliases.includes(oldId)
    || spec.routes.some(route => route.executionModel === oldId)))) throw fail('原模型正被其他规格使用，请先核对关联');

  rememberPublicModelNames(model);
  db.update(models).set({ modelId: newId }).where(eq(models.id, model.id)).run();
  for (const rule of rules.filter(rule => rule.modelPattern === oldId)) {
    db.update(modelPricing).set({ modelPattern: newId }).where(eq(modelPricing.id, rule.id)).run();
  }
  const channel = channelRows.find(row => row.id === channelId)!;
  const mapping: Record<string, string> = JSON.parse(channel.modelMapping);
  const upstreamModel = mapping[oldId];
  delete mapping[oldId];
  if (upstreamModel !== undefined) mapping[newId] = upstreamModel;
  db.update(channels).set({
    supportedModels: JSON.stringify(JSON.parse(channel.supportedModels).map((id: string) => id === oldId ? newId : id)),
    modelMapping: JSON.stringify(mapping), updatedAt: new Date().toISOString(),
  }).where(eq(channels.id, channelId)).run();
  oldSpec.modelId = newId;
  oldSpec.routes[0].executionModel = newId;
  db.update(settings).set({ value: JSON.stringify(specs), updatedAt: new Date().toISOString() })
    .where(eq(settings.key, 'model_specification_routes_v1')).run();
  const previous = db.select().from(settings).where(eq(settings.key, MODEL_ID_RENAMES_KEY)).get();
  const aliases: Record<string, number> = JSON.parse(previous?.value || '{}');
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)
    || !Object.values(aliases).every(id => Number.isSafeInteger(id) && id > 0)) throw fail('模型 ID 改名配置无效，已保留原配置');
  aliases[oldId] = model.id;
  db.insert(settings).values({ key: MODEL_ID_RENAMES_KEY, value: JSON.stringify(aliases), label: '模型 ID 改名兼容' })
    .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(aliases) } }).run();
  for (const token of db.select().from(apiTokens).all()) {
    const allowed: string[] = JSON.parse(token.allowedModels);
    if (!allowed.includes(oldId)) continue;
    db.update(apiTokens).set({ allowedModels: JSON.stringify([...new Set(allowed.map(id => id === oldId ? newId : id))]) })
      .where(eq(apiTokens.id, token.id)).run();
  }
}
