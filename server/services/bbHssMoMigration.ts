import type Database from 'better-sqlite3';
import { BB_HSS_KK_ENTRIES } from '../../shared/bbHssKk.js';
import { BB_HSS_SOURCE_KEY } from '../../shared/bbHssSources.js';
import { BB_HSS_MO_MIGRATION_KEY, HAYA_MO_MODEL, hayaMoLimits } from '../../shared/hayaMoVideo.js';
import type { ModelSpecification } from '../../shared/modelRouting.js';

const CONFIG = 'model_specification_routes_v1';
const read = (d: Database.Database, key: string, fallback: any) => {
  const row = d.prepare('SELECT value FROM settings WHERE key=?').get(key) as any;
  return row ? JSON.parse(row.value) : fallback;
};
const write = (d: Database.Database, key: string, value: any) => d.prepare(
  'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
export function bbHssMoManaged(d: Database.Database, id: string): boolean {
  return Boolean(read(d, BB_HSS_MO_MIGRATION_KEY, {}).products?.[id]);
}
export function bbHssMoInitialRouteEnabled(d: Database.Database, id: string): boolean {
  return read(d, BB_HSS_MO_MIGRATION_KEY, {}).products?.[id]?.routeEnabled !== false;
}
/** Replace new-order routes only. An authenticated Mo catalog response is required before binding a Key. */
export function ensureBbHssMoMapping(d: Database.Database, authorizedChannelId?: number) {
  return d.transaction(() => {
    const state = read(d, BB_HSS_MO_MIGRATION_KEY, { products: {} });
    const selections = read(d, BB_HSS_SOURCE_KEY, {});
    const specs: ModelSpecification[] = read(d, CONFIG, []);
    const rows = d.prepare('SELECT id,type,status,api_key,supported_models,model_mapping FROM channels').all() as any[];
    const authorized = rows.find(c => c.id === authorizedChannelId && c.type === 'haya' && c.status === 1 && c.api_key);
    for (const id of BB_HSS_KK_ENTRIES) {
      let model = d.prepare('SELECT * FROM models WHERE model_id=?').get(id) as any;
      let spec = specs.find(s => s.modelId === id);
      if (!state.products[id]) {
        if (model && !JSON.parse(model.capabilities || '[]').includes('video')) throw Error(id + ' 已被非视频产品占用');
        state.products[id] = { previousModel: model || null, previousSpecification: spec ? structuredClone(spec) : null,
          previousSelection: selections[id] || null,
          previousBindings: rows.map(c => ({ channelId: c.id, supportedModels: c.supported_models, modelMapping: c.model_mapping })),
          appliedAt: new Date().toISOString(), routeEnabled: !spec?.routes.length || spec.routes.some(r => r.enabled) };
        if (!model) {
          d.prepare('INSERT INTO models(provider,model_id,display_name,capabilities,is_active) VALUES(?,?,?,?,0)').run('haya', id, id, '["video"]');
          model = { is_active: 0 };
        }
        d.prepare('UPDATE models SET provider=?,description=? WHERE model_id=?').run('haya', '720p；5–30秒；30图/10视频/10音频，素材合计最多16项；按条计费', id);
        if (!spec) { spec = { modelId: id, kind: 'video', enabled: model.is_active === 1, aliases: [], limits: hayaMoLimits(), routes: [] }; specs.push(spec); }
        spec.limits = hayaMoLimits(); spec.routes = [];
        selections[id] = { source: 'MO', channelId: 0 };
        // Retain channels, keys and all accepted-task metadata for original-task recovery.
        for (const c of rows) {
          const supported = JSON.parse(c.supported_models || '[]'), mapping = JSON.parse(c.model_mapping || '{}');
          delete mapping[id];
          c.supported_models = JSON.stringify(supported.filter((m: string) => m !== id)); c.model_mapping = JSON.stringify(mapping);
          d.prepare('UPDATE channels SET supported_models=?,model_mapping=? WHERE id=?').run(c.supported_models, c.model_mapping, c.id);
        }
      }
      if (!spec || !authorized || selections[id]?.channelId) continue;
      const limits = hayaMoLimits();
      spec.routes = [{ id: 'mo-' + authorized.id + '-' + id, channelId: authorized.id, executionModel: id,
        upstreamModel: HAYA_MO_MODEL, enabled: state.products[id].routeEnabled, limits,
        cost: 5, costUnit: 'per_call', resolutionCosts: {}, priority: 0 }];
      selections[id] = { source: 'MO', channelId: authorized.id };
      const supported = JSON.parse(authorized.supported_models || '[]'), mapping = JSON.parse(authorized.model_mapping || '{}');
      if (!supported.includes(id)) supported.push(id); mapping[id] = HAYA_MO_MODEL;
      authorized.supported_models = JSON.stringify(supported); authorized.model_mapping = JSON.stringify(mapping);
      d.prepare('UPDATE channels SET supported_models=?,model_mapping=? WHERE id=?').run(authorized.supported_models, authorized.model_mapping, authorized.id);
    }
    write(d, CONFIG, specs); write(d, BB_HSS_SOURCE_KEY, selections); write(d, BB_HSS_MO_MIGRATION_KEY, state);
  })();
}
