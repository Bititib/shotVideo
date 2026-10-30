import type Database from 'better-sqlite3';
import type { ModelSpecification, ModelRoute } from '../../shared/modelRouting.js';
import { V6K_SEEDANCE_20_PRODUCTS, v6kSeedance20Limits } from '../../shared/v6kSeedance2.js';
import { V6K_CHANNEL_TYPE } from './zonghengProtocol.js';

const CONFIG_KEY = 'model_specification_routes_v1';
function readSpecifications(sqlite: Database.Database): ModelSpecification[] {
  const row = sqlite.prepare('SELECT value FROM settings WHERE key=?').get(CONFIG_KEY) as { value: string } | undefined;
  const specs = JSON.parse(row?.value || '[]');
  if (!Array.isArray(specs)) throw new Error('模型规格配置无效，停止 Seedance 2.0 接入');
  return specs;
}
function saveSpecifications(sqlite: Database.Database, specs: ModelSpecification[]) {
  sqlite.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(CONFIG_KEY, JSON.stringify(specs));
}

/** Register two independent products. Admin prices, switches and historical tasks are untouched. */
export function ensureV6kSeedance20Models(sqlite: Database.Database) {
  return sqlite.transaction(() => {
    const specs = readSpecifications(sqlite);
    let changed = false;
    for (const product of V6K_SEEDANCE_20_PRODUCTS) {
      const existing = sqlite.prepare('SELECT provider,capabilities FROM models WHERE model_id=?').get(product.id) as any;
      if (existing && (existing.provider !== V6K_CHANNEL_TYPE || !JSON.parse(existing.capabilities || '[]').includes('video')))
        throw new Error('模型 ID ' + product.id + ' 已被其他产品占用，未覆盖原配置');
      sqlite.prepare(`INSERT OR IGNORE INTO models(provider,model_id,display_name,description,capabilities,is_active)
        VALUES(?,?,?,?,?,0)`).run(V6K_CHANNEL_TYPE, product.id, product.id, product.description, '["video"]');
      sqlite.prepare(`INSERT INTO model_pricing(model_pattern,billing_type,input_price,output_price,extra_params)
        SELECT ?,'per_call',4,0,'{}' WHERE NOT EXISTS(SELECT 1 FROM model_pricing WHERE model_pattern=?)`)
        .run(product.id, product.id);
      if (specs.some(spec => spec.modelId === product.id)) continue;
      specs.push({ modelId: product.id, kind: 'video', enabled: false, aliases: [],
        limits: v6kSeedance20Limits(product.id)!, routes: [] });
      changed = true;
    }
    if (changed) saveSpecifications(sqlite, specs);
  })();
}

/** Called only with IDs returned by this channel's authenticated model discovery. */
export function bindV6kSeedance20Routes(sqlite: Database.Database, channelId: number, authorizedIds: string[]) {
  const allowed = new Set(authorizedIds), specs = readSpecifications(sqlite);
  for (const product of V6K_SEEDANCE_20_PRODUCTS) {
    const spec = specs.find(spec => spec.modelId === product.id)!;
    const previous = spec.routes;
    const matching = previous.filter(route => route.channelId === channelId && route.executionModel === product.id
      && product.upstreamModels.some(model => model.id === route.upstreamModel));
    const retained = previous.filter(route => !matching.includes(route));
    const routes: ModelRoute[] = product.upstreamModels.filter(model => allowed.has(model.id)).map((model, index) => {
      const existing = matching.find(route => route.upstreamModel === model.id);
      return existing || { id: `v6k-seedance20-${channelId}-${model.id}`, channelId, executionModel: product.id,
        upstreamModel: model.id, enabled: true, limits: v6kSeedance20Limits(product.id)!, cost: model.cost,
        costUnit: 'per_call', resolutionCosts: {}, priority: index };
    });
    spec.routes = [...retained, ...routes];
  }
  saveSpecifications(sqlite, specs);
}
