import type Database from 'better-sqlite3';
import { V6K_TTT_720_MODEL, V6K_TTT_720_DESCRIPTION } from '../../shared/zonghengVideo.js';
import { V6K_CHANNEL_TYPE } from './zonghengProtocol.js';
import type { ModelInputLimits, ModelSpecification } from '../../shared/modelRouting.js';

/** Correct only this product's old resolution configuration; never modify task snapshots. */
function correctTttResolution(sqlite: Database.Database) {
  sqlite.prepare('UPDATE models SET description=? WHERE model_id=? AND description=?')
    .run(V6K_TTT_720_DESCRIPTION, V6K_TTT_720_MODEL, '30图10音10视/480P/5-30秒/全天稳定10分钟出片');
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get()) return;
  const key = 'model_specification_routes_v1';
  const row = sqlite.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
  if (!row) return;
  const specs = JSON.parse(row.value) as ModelSpecification[];
  if (!Array.isArray(specs)) throw new Error('模型规格配置无效，停止清晰度修正');
  const correct = (limits?: ModelInputLimits) => {
    if (!limits?.resolutions?.some(r => r.toLowerCase() === '480p')) return false;
    limits.resolutions = [...new Set(limits.resolutions.map(r => r.toLowerCase() === '480p' ? '720p' : r))];
    return true;
  };
  let changed = false;
  for (const spec of specs) {
    if (spec.kind !== 'video' || spec.modelId !== V6K_TTT_720_MODEL) continue;
    changed = correct(spec.limits) || changed;
    for (const route of spec.routes) {
      if (route.upstreamModel === V6K_TTT_720_MODEL) changed = correct(route.limits) || changed;
    }
  }
  if (changed) sqlite.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(specs), key);
}

/** Register the requested product, without granting channel access or changing admin prices. */
export function ensureV6kTttModel(sqlite: Database.Database) {
  return sqlite.transaction(() => {
    const addedModel = sqlite.prepare(`INSERT OR IGNORE INTO models
      (provider,model_id,display_name,description,capabilities,is_active) VALUES(?,?,?,?,?,0)`)
      .run(V6K_CHANNEL_TYPE, V6K_TTT_720_MODEL, V6K_TTT_720_MODEL, V6K_TTT_720_DESCRIPTION, '["video"]').changes;
    const addedPrice = sqlite.prepare(`INSERT INTO model_pricing
      (model_pattern,billing_type,input_price,output_price,extra_params)
      SELECT ?,'per_call',6.5,0,'{}' WHERE NOT EXISTS (SELECT 1 FROM model_pricing WHERE model_pattern=?)`)
      .run(V6K_TTT_720_MODEL, V6K_TTT_720_MODEL).changes;
    correctTttResolution(sqlite);
    return { addedModel, addedPrice };
  })();
}
