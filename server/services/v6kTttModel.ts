import type Database from 'better-sqlite3';
import { V6K_TTT_720_MODEL, V6K_TTT_720_DESCRIPTION } from '../../shared/zonghengVideo.js';
import { V6K_CHANNEL_TYPE } from './zonghengProtocol.js';

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
    return { addedModel, addedPrice };
  })();
}
