import type Database from 'better-sqlite3';
import type { ModelSpecification } from '../../shared/modelRouting.js';
import { SI_YUE_TIAN_MANAGED_VIDEO_MODELS, siYueTianManagedVideoUpstreamModel } from '../../shared/siYueTianManagedVideo.js';
import { isSiYueTianVideoHost } from '../../shared/siYueTianMinimax.js';
import { SI_YUE_TIAN_C2_MODELS, SI_YUE_TIAN_SEEDANCE_25_VIDEO_MODELS } from './siYueTianVideoModels.js';
import { SI_YUE_TIAN_IMAGE_MODELS } from './siYueTianImageAdapter.js';

export const SI_YUE_TIAN_LEGACY_CATALOG_MODELS = [
  'seedance-2.0', 'sd2-mini', ...SI_YUE_TIAN_C2_MODELS.map(spec => spec.id),
  ...SI_YUE_TIAN_SEEDANCE_25_VIDEO_MODELS, ...SI_YUE_TIAN_IMAGE_MODELS,
];

export function siYueTianApprovedBindings(sqlite: Database.Database, channelId: number) {
  const bindings = new Map<string, string>(SI_YUE_TIAN_LEGACY_CATALOG_MODELS.map(id => [id, id]));
  bindings.set('gpt-image-2-siyuetian', 'gpt-image-2');
  for (const id of SI_YUE_TIAN_MANAGED_VIDEO_MODELS) bindings.set(id, siYueTianManagedVideoUpstreamModel(id));
  const row = sqlite.prepare("SELECT value FROM settings WHERE key='model_specification_routes_v1'").get() as { value: string } | undefined;
  const specs: ModelSpecification[] = JSON.parse(row?.value || '[]');
  for (const spec of specs) for (const route of spec.routes) {
    if (route.channelId === channelId && route.executionModel && route.executionModel !== '*'
      && route.upstreamModel && route.upstreamModel !== '*' && !bindings.has(route.executionModel)) {
      bindings.set(route.executionModel, route.upstreamModel);
    }
  }
  return bindings;
}

/** Detach catalog leftovers and retain a credential-free snapshot for review. */
export function pruneSiYueTianCatalogBindings(sqlite: Database.Database, channelId?: number): string[] {
  return sqlite.transaction(() => {
    const rows = sqlite.prepare('SELECT id,base_url,supported_models,model_mapping FROM channels').all() as
      { id: number; base_url: string; supported_models: string; model_mapping: string }[];
    const removed = new Set<string>();
    for (const row of rows) {
      if (!isSiYueTianVideoHost(row.base_url) || (channelId !== undefined && channelId !== row.id)) continue;
      const approved = siYueTianApprovedBindings(sqlite, row.id);
      const supported: string[] = JSON.parse(row.supported_models || '[]');
      const mapping: Record<string, string> = JSON.parse(row.model_mapping || '{}');
      const stale = [...new Set([...supported, ...Object.keys(mapping)])].filter(id => !approved.has(id));
      if (!stale.length) continue;
      const archive = { supportedModels: supported.filter(id => stale.includes(id)),
        modelMapping: Object.fromEntries(Object.entries(mapping).filter(([id]) => stale.includes(id))) };
      const key = 'siyuetian_removed_catalog_bindings_' + row.id;
      const previous = sqlite.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
      const snapshots = previous ? JSON.parse(previous.value) : [];
      snapshots.push(archive);
      sqlite.prepare(`INSERT INTO settings(key,value,label) VALUES(?,?,'四月天历史目录关联归档')
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, JSON.stringify(snapshots));
      sqlite.prepare("UPDATE channels SET supported_models=?,model_mapping=?,updated_at=datetime('now') WHERE id=?")
        .run(JSON.stringify(supported.filter(id => approved.has(id))),
          JSON.stringify(Object.fromEntries(Object.entries(mapping).filter(([id]) => approved.has(id)))), row.id);
      for (const id of stale) removed.add(id);
    }
    return [...removed];
  })();
}
