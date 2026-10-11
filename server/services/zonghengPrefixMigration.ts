import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { models, modelPricing, channels, apiTokens, settings } from '../db/schema.js';
import { canonicalZonghengModelId, LEGACY_ZONGHENG_MODEL_PREFIX, ZONGHENG_MODEL_PREFIX } from '../../shared/zonghengVideo.js';

/** Rename configuration only. Numeric model IDs, task history and financial records stay intact. */
export function migrateZonghengModelPrefix() {
  return db.transaction(tx => {
    const counts = { models: 0, prices: 0, channels: 0, tokens: 0 };
    const rows = tx.select().from(models).all();
    // The old synchronizer generated these labels even after IDs had the ZH- prefix.
    const generatedName = (row: typeof models.$inferSelect) => row.displayName.startsWith('纵横科技 · ');
    const renamedRows = rows.filter(row => row.modelId.startsWith(LEGACY_ZONGHENG_MODEL_PREFIX)
      || row.provider === 'zongheng' && row.modelId.startsWith(ZONGHENG_MODEL_PREFIX) && generatedName(row));
    const aliasKey = 'public_model_name_aliases_v1';
    const aliasRow = tx.select().from(settings).where(eq(settings.key, aliasKey)).get();
    const aliases = JSON.parse(aliasRow?.value || '{}');
    if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) throw new Error('模型历史名称映射无效，停止前缀迁移');
    for (const row of renamedRows) {
      const next = canonicalZonghengModelId(row.modelId);
      const displayName = generatedName(row) || row.displayName === row.modelId ? next : row.displayName;
      const priorNames = [...new Set([row.modelId, ...(displayName !== row.displayName ? [row.displayName] : [])])];
      if (rows.some(other => other.id !== row.id && (other.modelId === next || other.displayName === next))
        || aliases[next] !== undefined && aliases[next] !== row.id
        || priorNames.some(name => aliases[name] !== undefined && aliases[name] !== row.id
          || rows.some(other => other.id !== row.id && (other.modelId === name || other.displayName === name)))) {
        throw new Error('模型前缀迁移存在冲突：' + next + '；已保留原配置');
      }
      // Keep former display names callable by existing API clients.
      for (const name of priorNames) aliases[name] = row.id;
      tx.update(models).set({ modelId: next, displayName }).where(eq(models.id, row.id)).run();
      counts.models++;
    }
    const prices = tx.select().from(modelPricing).all();
    for (const rule of prices.filter(rule => rule.modelPattern.startsWith(LEGACY_ZONGHENG_MODEL_PREFIX))) {
      const next = canonicalZonghengModelId(rule.modelPattern);
      if (prices.some(other => other.modelPattern === next)) throw new Error('模型价格迁移存在冲突：' + next + '；已保留原配置');
      tx.update(modelPricing).set({ modelPattern: next }).where(eq(modelPricing.id, rule.id)).run();
      counts.prices++;
    }
    const renameList = (values: string[]) => [...new Set(values.map(canonicalZonghengModelId))];
    for (const row of tx.select().from(channels).all()) {
      const supported = JSON.parse(row.supportedModels || '[]') as string[];
      const mapping = JSON.parse(row.modelMapping || '{}') as Record<string, string>;
      if (!supported.some(id => id.startsWith(LEGACY_ZONGHENG_MODEL_PREFIX)) && !Object.keys(mapping).some(id => id.startsWith(LEGACY_ZONGHENG_MODEL_PREFIX))) continue;
      const renamed: Record<string, string> = {};
      for (const [id, upstream] of Object.entries(mapping)) {
        const next = canonicalZonghengModelId(id);
        if (Object.hasOwn(renamed, next) && renamed[next] !== upstream) throw new Error('渠道模型映射迁移冲突：' + next);
        renamed[next] = upstream;
      }
      tx.update(channels).set({supportedModels:JSON.stringify(renameList(supported)),modelMapping:JSON.stringify(renamed)}).where(eq(channels.id,row.id)).run();
      counts.channels++;
    }
    for (const row of tx.select().from(apiTokens).all()) {
      const allowed = JSON.parse(row.allowedModels || '[]') as string[];
      if (!allowed.some(id => id.startsWith(LEGACY_ZONGHENG_MODEL_PREFIX))) continue;
      tx.update(apiTokens).set({allowedModels:JSON.stringify(renameList(allowed))}).where(eq(apiTokens.id,row.id)).run();
      counts.tokens++;
    }
    if (renamedRows.length) tx.insert(settings).values({key:aliasKey,value:JSON.stringify(aliases),label:'API 模型历史名称映射'})
      .onConflictDoUpdate({target:settings.key,set:{value:JSON.stringify(aliases)}}).run();
    return counts;
  });
}
