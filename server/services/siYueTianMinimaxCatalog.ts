import type Database from 'better-sqlite3';
import type { ModelSpecification } from '../../shared/modelRouting.js';
import { SI_YUE_TIAN_MINIMAX_MODEL, isSiYueTianVideoHost } from '../../shared/siYueTianMinimax.js';
import { SI_YUE_TIAN_MANAGED_VIDEO_MODELS, siYueTianManagedVideoSpec, siYueTianManagedVideoUpstreamModel } from '../../shared/siYueTianManagedVideo.js';

type CatalogChannel = { id: number; type: string; base_url: string; priority: number; supported_models: string; model_mapping: string };

function ownsLegacyModel(model: string, upstream: string, provider: string, channels: CatalogChannel[], specs: ModelSpecification[]) {
  const related = channels.filter(channel =>
    JSON.parse(channel.supported_models || '[]').includes(model)
    || Object.hasOwn(JSON.parse(channel.model_mapping || '{}'), model));
  const owners = related.filter(channel => isSiYueTianVideoHost(channel.base_url)
    && JSON.parse(channel.model_mapping || '{}')[model] === upstream);
  if (!owners.some(channel => channel.type === provider) || related.length !== owners.length) return false;
  const ownerIds = new Set(owners.map(channel => channel.id));
  return specs.every(spec => spec.routes.every(route =>
    (spec.modelId !== model && route.executionModel !== model)
    || (ownerIds.has(route.channelId) && route.executionModel === model && route.upstreamModel === upstream)));
}

export class SiYueTianCatalogConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiYueTianCatalogConflictError';
  }
}

/** An optional catalog association must not take the entire application offline. */
export function ensureSiYueTianVideoModelsOnStartup(sqlite: Database.Database, newChannelId?: number) {
  for (const model of SI_YUE_TIAN_MANAGED_VIDEO_MODELS) {
    try {
      ensureSiYueTianMinimaxModel(sqlite, undefined, model, newChannelId);
    } catch (error) {
      // Each model's transaction has rolled back. Skip known conflicts only and
      // continue only for known ownership/mapping conflicts, never database errors.
      if (!(error instanceof SiYueTianCatalogConflictError)) throw error;
      console.warn(`[四月天启动目录] 跳过 ${model} 自动关联：${error.message}；保留原配置，其他服务继续启动`);
    }
  }
}

/** One-time association per channel; subsequent boots preserve operator removals and switches. */
export function ensureSiYueTianMinimaxModel(sqlite: Database.Database, syncedChannelId?: number, model = SI_YUE_TIAN_MINIMAX_MODEL, newChannelId?: number) {
  const product = siYueTianManagedVideoSpec(model);
  if (!product) throw new Error('未配置此四月天视频型号');
  const MODEL = product.id;
  const upstreamModel = siYueTianManagedVideoUpstreamModel(MODEL);
  return sqlite.transaction(() => {
    const existing = sqlite.prepare('SELECT provider FROM models WHERE model_id=?').get(MODEL) as { provider: string } | undefined;
    const key = 'model_specification_routes_v1';
    const row = sqlite.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
    const specs: ModelSpecification[] = row ? JSON.parse(row.value) : [];
    if (!Array.isArray(specs)) throw new Error('模型规格配置无效，未修改原配置');
    const channels = sqlite.prepare('SELECT id,type,base_url,priority,supported_models,model_mapping FROM channels').all() as CatalogChannel[];
    if (existing && existing.provider !== 'siyuetian') {
      if (!ownsLegacyModel(MODEL, upstreamModel, existing.provider, channels, specs)) {
        throw new SiYueTianCatalogConflictError(`${MODEL} 已被其他产品占用，未修改原配置`);
      }
      sqlite.prepare("UPDATE models SET provider='siyuetian',capabilities=? WHERE model_id=?").run('["video"]', MODEL);
    }
    const added = sqlite.prepare(`INSERT OR IGNORE INTO models
      (provider,model_id,display_name,description,capabilities,is_active) VALUES('siyuetian',?,?,?,'["video"]',0)`)
      .run(MODEL, product.name, product.description).changes;
    sqlite.prepare(`INSERT INTO model_pricing (model_pattern,billing_type,input_price,output_price,extra_params)
      SELECT ?,'per_call',?,0,'{"category":"video"}' WHERE NOT EXISTS (SELECT 1 FROM model_pricing WHERE model_pattern=?)`)
      .run(MODEL, product.price, MODEL);
    let changed = false;
    for (const channel of channels) {
      if (!isSiYueTianVideoHost(channel.base_url) || syncedChannelId !== undefined && channel.id !== syncedChannelId) continue;
      const marker = product.marker + channel.id;
      if (syncedChannelId === undefined && sqlite.prepare('SELECT 1 FROM settings WHERE key=?').get(marker)) continue;
      const supported: string[] = JSON.parse(channel.supported_models || '[]');
      const mapping = JSON.parse(channel.model_mapping || '{}');
      if (!Object.hasOwn(mapping, MODEL) && channel.id !== newChannelId) continue;
      if (!supported.includes(MODEL)) supported.push(MODEL);
      if (mapping[MODEL] && mapping[MODEL] !== upstreamModel) throw new SiYueTianCatalogConflictError(`${MODEL} 的现有映射不同，未覆盖配置`);
      mapping[MODEL] = upstreamModel;
      sqlite.prepare('UPDATE channels SET supported_models=?,model_mapping=? WHERE id=?').run(JSON.stringify(supported), JSON.stringify(mapping), channel.id);
      let spec = specs.find(s => s.modelId === MODEL);
      if (!spec) {
        spec = { modelId: MODEL, kind: 'video', enabled: true, aliases: [], limits: structuredClone(product.limits), routes: [] };
        specs.push(spec); changed = true;
      }
      if (!spec.routes.some(route => route.channelId === channel.id)) {
        spec.routes.push({ id: product.route + channel.id, channelId: channel.id, executionModel: MODEL,
          upstreamModel, enabled: true, limits: structuredClone(product.limits), cost: product.cost, costUnit: 'per_call', resolutionCosts: {}, priority: channel.priority });
        changed = true;
      }
      sqlite.prepare('INSERT OR IGNORE INTO settings(key,value,label) VALUES(?,\'1\',\'四月天视频初始关联\')').run(marker);
    }
    if (changed) sqlite.prepare(`INSERT INTO settings(key,value,label) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, JSON.stringify(specs), '模型规格与渠道线路');
    return added;
  })();
}
