import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { ModelRoute, ModelSpecification } from '../../shared/modelRouting.js';
import { V6K_TT_BB_FALLBACKS, isTtBbFallbackRoute, ttBbFallbackProduct } from '../../shared/v6kTt25Fallback.js';
import { V6K_TT25_PRODUCTS, v6kTt25Limits } from '../../shared/v6kTt25.js';
import { v6kTt25SaleId } from './v6kTt25Catalog.js';

const KEY = 'v6k_tt_bb_catalog_v1';
type Channel = { id: number; baseUrl: string; apiKey: string; type?: string };
type Catalog = Record<string, { identity: string; models: string[] }>;
function identity(c: Channel) { return createHash('sha256').update(JSON.stringify([c.baseUrl, c.apiKey])).digest('hex'); }
function catalogs(d: Database.Database): Catalog {
  const row = d.prepare('SELECT value FROM settings WHERE key=?').get(KEY) as { value: string } | undefined;
  return JSON.parse(row?.value || '{}');
}
function write(d: Database.Database, key: string, value: unknown) {
  d.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
}
/** Called inside authenticated sync's configuration transaction. No public BB product or retail price is created. */
export function bindV6kTtBbFallbacks(d: Database.Database, channel: Channel, authorized: string[]) {
  const recognized = authorized.filter(id => V6K_TT25_PRODUCTS.some(p => p.id === id) || V6K_TT_BB_FALLBACKS.some(p => p.upstream === id));
  if (!recognized.length) return;
  const state = catalogs(d); state[channel.id] = { identity: identity(channel), models: recognized };
  write(d, KEY, state);
  const row = d.prepare('SELECT value FROM settings WHERE key=?').get('model_specification_routes_v1') as { value: string };
  const specs: ModelSpecification[] = JSON.parse(row.value); let changed = false;
  for (const product of V6K_TT_BB_FALLBACKS) {
    if (!authorized.includes(product.upstream)) continue;
    const id = v6kTt25SaleId(d, product.primary), spec = specs.find(s => s.modelId === id)!;
    if (spec.routes.some(r => r.channelId === channel.id && r.executionModel === id && r.upstreamModel === product.upstream)) continue;
    spec.routes.push({ id: `v6k-tt-bb-${channel.id}-${product.resolution}`, channelId: channel.id, executionModel: id,
      upstreamModel: product.upstream, enabled: false, limits: v6kTt25Limits(id)!, cost: product.costRate,
      costUnit: 'per_second', resolutionCosts: {}, priority: 100 }); changed = true;
  }
  if (changed) write(d, 'model_specification_routes_v1', specs);
}
/** Catalog availability is independent from operator switches. Accepted jobs never use this check. */
export function v6kTtBbUnavailable(d: Database.Database, route: ModelRoute, channel: Channel): string {
  const product = ttBbFallbackProduct(route.executionModel);
  if (!product || !['zongheng-v6k', 'zongheng'].includes(channel.type || '')
    || ![product.primary, product.upstream].includes(route.upstreamModel as any)) return '';
  const current = catalogs(d)[channel.id];
  const verified = current?.identity === identity(channel);
  if (isTtBbFallbackRoute(route) && !verified) return 'BB 备用型号尚未通过当前 Key 核实，请同步模型';
  return verified && !current.models.includes(route.upstreamModel) ? '当前 Key 的模型目录未提供此型号' : '';
}
