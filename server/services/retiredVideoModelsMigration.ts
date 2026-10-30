import type Database from 'better-sqlite3';
import { RETIRED_VIDEO_MODELS, isRetiredVideoModel } from '../../shared/retiredVideoModels.js';

/** Remove live bindings only. Preserve historical orders, prices, wallets and ledgers. */
export function retireRemovedVideoModels(db: Database.Database): void {
  db.transaction(() => {
    const disable = db.prepare('UPDATE models SET is_active=0 WHERE model_id=? AND is_active<>0');
    for (const id of RETIRED_VIDEO_MODELS) disable.run(id);
    const update = db.prepare('UPDATE channels SET supported_models=?,model_mapping=? WHERE id=?');
    for (const row of db.prepare('SELECT id,supported_models,model_mapping FROM channels').all() as any[]) {
      // Invalid operator data is not silently replaced by migration.
      let ids: unknown, mapping: unknown;
      try { ids=JSON.parse(row.supported_models || '[]');mapping=JSON.parse(row.model_mapping || '{}'); } catch { continue; }
      if (!Array.isArray(ids) || !mapping || typeof mapping!=='object' || Array.isArray(mapping)) continue;
      const kept=ids.filter(id=>!isRetiredVideoModel(id)&&!isRetiredVideoModel((mapping as Record<string,unknown>)[id]));
      const entries=Object.entries(mapping).filter(([id,target])=>!isRetiredVideoModel(id)&&!isRetiredVideoModel(target));
      if(kept.length!==ids.length || entries.length!==Object.keys(mapping).length) update.run(JSON.stringify(kept),JSON.stringify(Object.fromEntries(entries)),row.id);
    }
  })();
}
