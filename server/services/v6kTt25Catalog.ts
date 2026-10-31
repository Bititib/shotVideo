import type Database from 'better-sqlite3';
import type { ModelSpecification, ModelRoute } from '../../shared/modelRouting.js';
import { V6K_TT25_PRODUCTS, v6kTt25Description, v6kTt25Limits } from '../../shared/v6kTt25.js';
import { V6K_CHANNEL_TYPE } from './zonghengProtocol.js';

const CONFIG_KEY = 'model_specification_routes_v1';
const PRICE_KEY = 'v6k_tt25_requested_second_prices_v1';
type PriceMigration = Record<string, { modelId: string; previousPrices: unknown[]; appliedAt: string }>;
function read<T>(sqlite: Database.Database, key: string, fallback: T): T {
  const row = sqlite.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : fallback;
}
function write(sqlite: Database.Database, key: string, value: unknown) {
  sqlite.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));
}
function newRoute(channelId: number, id: string, product: typeof V6K_TT25_PRODUCTS[number]): ModelRoute {
  return { id: `v6k-tt25-${channelId}-${product.resolution}`, channelId, executionModel: id,
    upstreamModel: product.id, enabled: true, limits: v6kTt25Limits(id)!, cost: product.costRate,
    costUnit: 'per_second', resolutionCosts: {}, priority: 0 };
}
/** Preserve a previously configured product/channel association when introducing managed billing. */
function existingRoutes(sqlite: Database.Database, id: string, product: typeof V6K_TT25_PRODUCTS[number]): ModelRoute[] {
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='channels'").get()) return [];
  const channels = sqlite.prepare('SELECT id,supported_models,model_mapping FROM channels WHERE type=?').all(V6K_CHANNEL_TYPE) as any[];
  return channels.filter(channel => {
    const supported = JSON.parse(channel.supported_models || '[]'), mapping = JSON.parse(channel.model_mapping || '{}');
    return supported.includes(id) && (mapping[id] || id) === product.id;
  }).map(channel => newRoute(channel.id, id, product));
}

/** Existing products keep their numeric IDs, public names, permissions and queued route identities. */
export function v6kTt25SaleId(sqlite: Database.Database, upstreamId: string): string {
  const applied = read<PriceMigration>(sqlite, PRICE_KEY, {});
  const previous = applied[upstreamId]?.modelId;
  if (previous && ![upstreamId, 'ZH-' + upstreamId].includes(previous)) throw new Error('TT 2.5 既有产品身份不一致，停止接入');
  if (previous && sqlite.prepare('SELECT 1 FROM models WHERE model_id=?').get(previous)) return previous;
  for (const id of ['ZH-' + upstreamId, upstreamId]) {
    if (sqlite.prepare('SELECT 1 FROM models WHERE model_id=?').get(id)) return id;
  }
  return upstreamId;
}

/** Apply this explicit pricing request once; subsequent restarts preserve administrator edits. */
export function ensureV6kTt25Models(sqlite: Database.Database) {
  return sqlite.transaction(() => {
    const applied = read<PriceMigration>(sqlite, PRICE_KEY, {}), specs = read<ModelSpecification[]>(sqlite, CONFIG_KEY, []);
    if (!applied || typeof applied !== 'object' || Array.isArray(applied) || !Array.isArray(specs)) throw new Error('TT 2.5 配置无效，停止接入');
    let specChanged = false, priceChanged = false;
    for (const product of V6K_TT25_PRODUCTS) {
      const id = v6kTt25SaleId(sqlite, product.id);
      const model = sqlite.prepare('SELECT provider,capabilities,is_active FROM models WHERE model_id=?').get(id) as any;
      if (model && (model.provider !== V6K_CHANNEL_TYPE || !JSON.parse(model.capabilities || '[]').includes('video')))
        throw new Error('模型 ID ' + id + ' 已被其他产品占用，未覆盖原配置');
      sqlite.prepare(`INSERT OR IGNORE INTO models(provider,model_id,display_name,description,capabilities,is_active)
        VALUES(?,?,?,?,?,0)`).run(V6K_CHANNEL_TYPE, id, id, v6kTt25Description(id), '["video"]');
      if (!applied[product.id]) {
        const previousPrices = sqlite.prepare('SELECT * FROM model_pricing WHERE model_pattern=?').all(id) as any[];
        if (previousPrices.length) for (const price of previousPrices) {
          const extra = JSON.parse(price.extra_params || '{}');
          if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error(id + ' 价格参数无效，未覆盖');
          for (const key of Object.keys(extra)) if (key.toLowerCase() === product.resolution) extra[key] = product.saleRate;
          extra[product.resolution] = product.saleRate;
          sqlite.prepare('UPDATE model_pricing SET billing_type=?,input_price=?,extra_params=? WHERE id=?')
            .run('per_second', product.saleRate, JSON.stringify(extra), price.id);
        } else sqlite.prepare(`INSERT INTO model_pricing(model_pattern,billing_type,input_price,output_price,extra_params)
          VALUES(?,'per_second',?,0,?)`).run(id, product.saleRate, JSON.stringify({ [product.resolution]: product.saleRate }));
        applied[product.id] = { modelId: id, previousPrices, appliedAt: new Date().toISOString() };
        priceChanged = true;
      }
      if (!specs.some(spec => spec.modelId === id)) {
        specs.push({ modelId: id, kind: 'video', enabled: model?.is_active === 1, aliases: [], limits: v6kTt25Limits(id)!,
          routes: model ? existingRoutes(sqlite, id, product) : [] });
        specChanged = true;
      }
    }
    if (specChanged) write(sqlite, CONFIG_KEY, specs);
    if (priceChanged) write(sqlite, PRICE_KEY, applied);
  })();
}

/** Only authenticated /v1/models discoveries may create new routes. */
export function bindV6kTt25Routes(sqlite: Database.Database, channelId: number, authorizedIds: string[]) {
  const specs = read<ModelSpecification[]>(sqlite, CONFIG_KEY, []);
  for (const product of V6K_TT25_PRODUCTS) {
    const id = v6kTt25SaleId(sqlite, product.id), spec = specs.find(spec => spec.modelId === id)!;
    const previous = spec.routes.filter(route => route.channelId === channelId && route.executionModel === id && route.upstreamModel === product.id);
    spec.routes = spec.routes.filter(route => !previous.includes(route));
    if (authorizedIds.includes(product.id)) {
      if (previous.length) spec.routes.push(...previous);
      else {
        spec.routes.push(newRoute(channelId, id, product));
      }
    }
  }
  write(sqlite, CONFIG_KEY, specs);
}
