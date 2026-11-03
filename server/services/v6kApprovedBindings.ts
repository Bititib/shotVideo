import type Database from 'better-sqlite3';
import { isV6kSyncModel } from '../../shared/v6kSyncModels.js';
import type { ModelSpecification } from '../../shared/modelRouting.js';

const CONFIG = 'model_specification_routes_v1';
const inferredUpstream = (id: string) => id.replace(/^(?:ZH-|zongheng-)/, '');

/** Retire obsolete channel associations, never models, prices, accepted receipts, orders or money. */
export function pruneUnapprovedV6kBindings(d: Database.Database, channelId?: number) {
  return d.transaction(() => {
    const row = d.prepare('SELECT value FROM settings WHERE key=?').get(CONFIG) as {value:string} | undefined;
    const specs: ModelSpecification[] = JSON.parse(row?.value || '[]');
    if (!Array.isArray(specs) || specs.some(s => !Array.isArray(s.routes))) throw new Error('模型规格配置无效，未清理渠道关联');
    const channels = d.prepare("SELECT id,supported_models,model_mapping FROM channels WHERE type='zongheng-v6k'").all() as any[];
    let removedBindings = 0, removedRoutes = 0, changedSpecs = false;
    for (const channel of channels.filter(c => channelId === undefined || c.id === channelId)) {
      const supported: string[] = JSON.parse(channel.supported_models || '[]'), mapping: Record<string,string> = JSON.parse(channel.model_mapping || '{}');
      if (!Array.isArray(supported) || supported.some(id => typeof id !== 'string') || !mapping || Array.isArray(mapping)
        || typeof mapping !== 'object' || Object.values(mapping).some(id => typeof id !== 'string')) throw new Error('渠道模型关联格式无效，未清理配置');
      const approvedExecutions = new Set(specs.flatMap(s => s.routes.filter(r => r.channelId === channel.id && isV6kSyncModel(r.upstreamModel)).map(r => r.executionModel)));
      const keep = (id: string) => id !== '*' && (approvedExecutions.has(id) || isV6kSyncModel(mapping[id] ?? inferredUpstream(id)));
      const nextSupported = supported.filter(keep);
      const nextMapping = Object.fromEntries(Object.entries(mapping).filter(([id, upstream]) => id !== '*' && isV6kSyncModel(upstream)));
      const removed = [...new Set([...supported.filter(id => !keep(id)), ...Object.keys(mapping).filter(id => !Object.hasOwn(nextMapping,id))])];
      const retiredRoutes: {modelId:string;route:unknown}[] = [];
      for (const spec of specs) {
        const retained = spec.routes.filter(route => {
          if (route.channelId !== channel.id || isV6kSyncModel(route.upstreamModel)) return true;
          retiredRoutes.push({modelId:spec.modelId,route});return false;
        });
        if (retained.length !== spec.routes.length) { spec.routes = retained; changedSpecs = true; }
      }
      if (!removed.length && !retiredRoutes.length) continue;
      // Store only configuration without credentials; repeated runs with no changes create no duplicate archive.
      d.exec(`CREATE TABLE IF NOT EXISTS v6k_unapproved_binding_archive(
        id INTEGER PRIMARY KEY,channel_id INTEGER NOT NULL,supported_models TEXT NOT NULL,
        model_mapping TEXT NOT NULL,removed_routes TEXT NOT NULL,archived_at TEXT NOT NULL)`);
      d.prepare('INSERT INTO v6k_unapproved_binding_archive(channel_id,supported_models,model_mapping,removed_routes,archived_at) VALUES(?,?,?,?,?)')
        .run(channel.id,channel.supported_models || '[]',channel.model_mapping || '{}',JSON.stringify(retiredRoutes),new Date().toISOString());
      d.prepare('UPDATE channels SET supported_models=?,model_mapping=? WHERE id=?').run(JSON.stringify(nextSupported),JSON.stringify(nextMapping),channel.id);
      removedBindings += removed.length;removedRoutes += retiredRoutes.length;
    }
    if (changedSpecs) d.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(specs),CONFIG);
    return {removedBindings,removedRoutes};
  })();
}
