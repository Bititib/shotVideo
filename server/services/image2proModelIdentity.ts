import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { apiTokens, channels, modelPricing, models, settings } from '../db/schema.js';
import { getModelSpecifications } from './modelRoutingService.js';
import { rememberPublicModelNames, validatePublicModelName } from './publicModelNameService.js';
import type { ChannelModelDraft } from '../../shared/channelModelConfiguration.js';

const fail = (message: string) => Object.assign(new Error(message), {status:409});

/** Called inside the configuration save transaction; historical tasks/ledger are never rewritten. */
export function migrateImage2proIdentity(model: typeof models.$inferSelect, draft: ChannelModelDraft, channelId: number) {
  const oldId = model.modelId, newId = draft.modelId;
  const rename = oldId !== newId;
  const typeChange = !JSON.parse(model.capabilities).includes(draft.kind);
  if (!rename && !typeChange) return;
  if (model.provider !== 'image2pro') throw fail('只能修改 Image2Pro 模型身份');
  validatePublicModelName(newId, draft.displayName.trim(), model.id);
  const specs = getModelSpecifications();
  const allChannels = db.select().from(channels).all();
  if (typeChange && (specs.some(s => s.modelId === oldId ? s.aliases.length > 0 || s.routes.some(r => r.channelId !== channelId)
    : s.aliases.includes(oldId) || s.imageFamily === oldId || s.routes.some(r => r.executionModel === oldId))
    || allChannels.some(c => c.id !== channelId && (JSON.parse(c.supportedModels || '[]').includes(oldId) || Object.hasOwn(JSON.parse(c.modelMapping || '{}'), oldId))))) {
    throw fail('该型号被其他渠道或规格共用，请先解除关联再跨类型修改');
  }
  if (rename) {
    if (db.select().from(modelPricing).where(eq(modelPricing.modelPattern,newId)).get()) throw fail('目标 ID 已有售价配置，请先处理冲突');
    if (specs.some(s => s.modelId === newId || s.aliases.includes(newId) || s.routes.some(r => r.executionModel === newId))) throw fail('目标 ID 已被规格关联使用');
    if (allChannels.some(c => JSON.parse(c.supportedModels || '[]').includes(newId) || Object.hasOwn(JSON.parse(c.modelMapping || '{}'),newId))) throw fail('目标 ID 已被渠道使用');
    rememberPublicModelNames(model);
    db.update(modelPricing).set({modelPattern:newId}).where(eq(modelPricing.modelPattern,oldId)).run();
    for (const token of db.select().from(apiTokens).all()) {
      const allowed: string[] = JSON.parse(token.allowedModels);
      if (allowed.includes(oldId)) db.update(apiTokens).set({allowedModels:JSON.stringify([...new Set(allowed.map(id => id === oldId ? newId : id))])}).where(eq(apiTokens.id,token.id)).run();
    }
    for (const channel of allChannels) {
      const supported: string[] = JSON.parse(channel.supportedModels || '[]');
      const mapping = JSON.parse(channel.modelMapping || '{}');
      if (!supported.includes(oldId) && !Object.hasOwn(mapping,oldId)) continue;
      if (Object.hasOwn(mapping,oldId)) { mapping[newId]=mapping[oldId];delete mapping[oldId]; }
      db.update(channels).set({supportedModels:JSON.stringify([...new Set(supported.map(id => id === oldId ? newId : id))]),modelMapping:JSON.stringify(mapping),updatedAt:new Date().toISOString()}).where(eq(channels.id,channel.id)).run();
    }
  }
  const updatedSpecs = specs.filter(s => !(typeChange && s.modelId === oldId)).map(s => ({...s,
    modelId:s.modelId === oldId ? newId : s.modelId,
    ...(s.imageFamily === oldId ? {imageFamily:newId} : {}),
    aliases:s.aliases.map(id => id === oldId ? newId : id),
    routes:s.routes.map(r => ({...r,executionModel:r.executionModel === oldId ? newId : r.executionModel})),
  }));
  db.insert(settings).values({key:'model_specification_routes_v1',value:JSON.stringify(updatedSpecs),label:'模型规格与渠道线路'})
    .onConflictDoUpdate({target:settings.key,set:{value:JSON.stringify(updatedSpecs)}}).run();
  // Numeric model identity is retained: organization/user access and custom prices keep their FK.
  db.update(models).set({modelId:newId,capabilities:JSON.stringify([draft.kind]),...(typeChange ? {isActive:0} : {})}).where(eq(models.id,model.id)).run();
}
