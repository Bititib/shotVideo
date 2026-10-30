import { migrateHmDdlongNaming } from '../db/hmDdlongNamingMigration.js';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { channels, modelPricing, models } from '../db/schema.js';
import {
  getHmStudioAdditionalVideoModel, getHmStudioPublicVideoModel,
  getHmStudioUpstreamVideoModel, HM_STUDIO_UPSTREAM_VIDEO_MODEL_MAP,
  HM_STUDIO_NOVA_MODEL, HM_STUDIO_NOVA_LEGACY_UPSTREAM_MODELS,
} from '../../shared/hmStudioVideo.js';

/** HM catalog normalization only. Generation and settlement keep their existing paths. */
export function registerHmStudioCatalog(channel: { id: number; name: string }, rawModels: unknown[]) {
  const entries = rawModels.map((raw: any) => {
    const id = typeof raw === 'string' ? raw : raw?.id || raw?.model || raw?.model_id;
    if (typeof id !== 'string' || !id.trim()) {
      throw { status: 502, message: 'HM Studio 同步模型列表包含无效模型标识，原配置未修改' };
    }
    const publicId = getHmStudioPublicVideoModel(id.trim());
    const upstreamId = getHmStudioUpstreamVideoModel(publicId);
    const spec = getHmStudioAdditionalVideoModel(publicId);
    const knownVideo = Object.hasOwn(HM_STUDIO_UPSTREAM_VIDEO_MODEL_MAP, publicId);
    const explicitType = String(raw?.type || raw?.category || '').toLowerCase();
    const capability = knownVideo ? 'video'
      : explicitType.includes('tts') || /tts|speech/i.test(publicId) ? 'tts'
      : explicitType.includes('lip') || /lip-sync/i.test(publicId) ? 'lip_sync'
      : explicitType.includes('video') || /video|seedance/i.test(publicId) ? 'video'
      : explicitType.includes('image') || /image|jimeng|banana/i.test(publicId) ? 'image' : 'text';
    const displayName = spec?.displayName || (publicId === 'seedance_v2.5' ? 'HM-Seedance V2.5'
      : String(raw?.display_name || raw?.name || publicId));
    return { publicId, upstreamId, spec, knownVideo, capability, displayName };
  });
  const unique = [...new Map(entries.map(entry => [entry.publicId, entry])).values()];
  return sqlite.transaction(() => {
    migrateHmDdlongNaming(sqlite);
    let added = 0;
    const warnings: string[] = [];
    for (const entry of unique) {
      const { publicId, upstreamId, spec, knownVideo } = entry;
      const existing = db.select().from(models).where(eq(models.modelId, publicId)).get();
      if (knownVideo && existing && existing.provider !== 'hmstudio') {
        throw { status: 409, message: `HM Studio 同步冲突：${publicId} 已属于其他渠道，原配置未修改` };
      }
      if (!existing) {
        db.insert(models).values({ provider: 'hmstudio', modelId: publicId,
          displayName: entry.displayName, description: spec?.description || `由 ${channel.name} 同步`,
          capabilities: JSON.stringify([entry.capability]), isActive: 0 }).run();
        added++;
      } else if (knownVideo) {
        // Correct generic-sync capability classification, but preserve custom names and switches.
        db.update(models).set({ capabilities: '["video"]', ...(spec ? { description: spec.description } : {}) })
          .where(eq(models.id, existing.id)).run();
      }

      const price = db.select().from(modelPricing).where(eq(modelPricing.modelPattern, publicId)).get();
      const legacyIds = publicId !== upstreamId
        ? [upstreamId, ...(publicId === HM_STUDIO_NOVA_MODEL ? HM_STUDIO_NOVA_LEGACY_UPSTREAM_MODELS : [])] : [];
      const legacyModels = legacyIds.map(id => db.select().from(models).where(eq(models.modelId, id)).get())
        .filter(model => model?.provider === 'hmstudio');
      const legacyModel = legacyModels.find(model => db.select().from(modelPricing).where(eq(modelPricing.modelPattern, model!.modelId)).get()) || legacyModels[0];
      const legacyId = legacyModel?.modelId || upstreamId;
      const legacyPrice = legacyModel
        ? db.select().from(modelPricing).where(eq(modelPricing.modelPattern, legacyId)).get() : undefined;
      if (!price && legacyPrice) {
        // Copy, never delete or overwrite. Missing resolution rates retain the admin's base-rate fallback.
        db.insert(modelPricing).values({ modelPattern: publicId, billingType: legacyPrice.billingType,
          inputPrice: legacyPrice.inputPrice, outputPrice: legacyPrice.outputPrice,
          extraParams: legacyPrice.extraParams }).run();
        warnings.push(`已沿用 ${legacyId} 的价格至 ${publicId}，请核对分辨率售价。`);
      } else if (!price && spec) {
        // These are user-confirmed retail prices, NOT prices returned by the upstream catalog.
        db.insert(modelPricing).values({ modelPattern: publicId, billingType: 'per_call',
          inputPrice: spec.defaultPrice, outputPrice: 0,
          extraParams: JSON.stringify({ category: 'video', ...(spec.resolutionPrices || {}) }) }).run();
      }
      if (legacyModel?.provider === 'hmstudio') {
        warnings.push(`旧记录 ${legacyId} 及其价格、权限和历史数据已保留；本渠道现在使用 ${publicId}。`
          + (price && legacyPrice ? '两份价格均未覆盖，请在新模型的管理价格中核对。' : ''));
      }
    }
    const modelIds = unique.map(entry => entry.publicId);
    db.update(channels).set({ supportedModels: JSON.stringify(modelIds),
      modelMapping: JSON.stringify(Object.fromEntries(unique.map(entry => [entry.publicId, entry.upstreamId]))),
      updatedAt: new Date().toISOString() }).where(eq(channels.id, channel.id)).run();
    return { count: modelIds.length, added, models: modelIds, warnings };
  })();
}
