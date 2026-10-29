import type Database from 'better-sqlite3';
import type { ModelSpecification } from '../../shared/modelRouting.js';
import { SI_YUE_TIAN_MINIMAX_MODEL as MODEL, SI_YUE_TIAN_MINIMAX_DESCRIPTION, SI_YUE_TIAN_MINIMAX_PRICE,
  siYueTianMinimaxLimits, isSiYueTianVideoHost } from '../../shared/siYueTianMinimax.js';

/** One-time association per channel; subsequent boots preserve operator removals and switches. */
export function ensureSiYueTianMinimaxModel(sqlite: Database.Database, syncedChannelId?: number) {
  return sqlite.transaction(() => {
    const existing = sqlite.prepare('SELECT provider FROM models WHERE model_id=?').get(MODEL) as { provider: string } | undefined;
    if (existing && existing.provider !== 'siyuetian') throw new Error(`${MODEL} 已被其他产品占用，未修改原配置`);
    const added = sqlite.prepare(`INSERT OR IGNORE INTO models
      (provider,model_id,display_name,description,capabilities,is_active) VALUES('siyuetian',?,?,?,'["video"]',0)`)
      .run(MODEL, 'MiniMax H3 2K · 四月天', SI_YUE_TIAN_MINIMAX_DESCRIPTION).changes;
    sqlite.prepare(`INSERT INTO model_pricing (model_pattern,billing_type,input_price,output_price,extra_params)
      SELECT ?,'per_call',?,0,'{"category":"video"}' WHERE NOT EXISTS (SELECT 1 FROM model_pricing WHERE model_pattern=?)`)
      .run(MODEL, SI_YUE_TIAN_MINIMAX_PRICE, MODEL);
    const key = 'model_specification_routes_v1';
    const row = sqlite.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
    const specs: ModelSpecification[] = row ? JSON.parse(row.value) : [];
    if (!Array.isArray(specs)) throw new Error('模型规格配置无效，未修改原配置');
    let changed = false;
    for (const channel of sqlite.prepare('SELECT id,base_url,priority,supported_models,model_mapping FROM channels').all() as any[]) {
      if (!isSiYueTianVideoHost(channel.base_url) || syncedChannelId !== undefined && channel.id !== syncedChannelId) continue;
      const marker = 'catalog_siyuetian_minimax_h3_' + channel.id;
      if (syncedChannelId === undefined && sqlite.prepare('SELECT 1 FROM settings WHERE key=?').get(marker)) continue;
      const supported: string[] = JSON.parse(channel.supported_models || '[]');
      const mapping = JSON.parse(channel.model_mapping || '{}');
      if (!supported.includes(MODEL)) supported.push(MODEL);
      if (mapping[MODEL] && mapping[MODEL] !== MODEL) throw new Error(`${MODEL} 的现有映射不同，未覆盖配置`);
      mapping[MODEL] = MODEL;
      sqlite.prepare('UPDATE channels SET supported_models=?,model_mapping=? WHERE id=?').run(JSON.stringify(supported), JSON.stringify(mapping), channel.id);
      let spec = specs.find(s => s.modelId === MODEL);
      if (!spec) {
        spec = { modelId: MODEL, kind: 'video', enabled: true, aliases: [], limits: siYueTianMinimaxLimits(), routes: [] };
        specs.push(spec); changed = true;
      }
      if (!spec.routes.some(route => route.channelId === channel.id)) {
        spec.routes.push({ id: 'siyuetian-minimax-' + channel.id, channelId: channel.id, executionModel: MODEL,
          upstreamModel: MODEL, enabled: true, limits: siYueTianMinimaxLimits(), cost: 1, costUnit: 'per_call', resolutionCosts: {}, priority: channel.priority });
        changed = true;
      }
      sqlite.prepare('INSERT OR IGNORE INTO settings(key,value,label) VALUES(?,\'1\',\'四月天 H3 初始关联\')').run(marker);
    }
    if (changed) sqlite.prepare(`INSERT INTO settings(key,value,label) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, JSON.stringify(specs), '模型规格与渠道线路');
    return added;
  })();
}
