import type Database from 'better-sqlite3';
import { V6K_KK25_MODEL as ID, V6K_KK25_DESCRIPTION } from '../../shared/zonghengVideo.js';
import { defaultRoutingLimits, type ModelSpecification } from '../../shared/modelRouting.js';
import { V6K_CHANNEL_TYPE } from './zonghengProtocol.js';

const KEY = 'model_specification_routes_v1';
export function ensureV6kKk25Model(d: Database.Database, channelId?: number) {
  return d.transaction(() => {
    const existing = d.prepare('SELECT provider,capabilities,is_active FROM models WHERE model_id=?').get(ID) as any;
    if (existing && (existing.provider !== V6K_CHANNEL_TYPE || !JSON.parse(existing.capabilities || '[]').includes('video')))
      throw new Error(ID + ' 已被其他产品占用，未覆盖原配置');
    d.prepare('INSERT OR IGNORE INTO models(provider,model_id,display_name,description,capabilities,is_active) VALUES(?,?,?,?,?,0)')
      .run(V6K_CHANNEL_TYPE,ID,ID,V6K_KK25_DESCRIPTION,'["video"]');
    d.prepare(`INSERT INTO model_pricing(model_pattern,billing_type,input_price,output_price,extra_params)
      SELECT ?,'per_call',6.5,0,'{}' WHERE NOT EXISTS (SELECT 1 FROM model_pricing WHERE model_pattern=?)`).run(ID,ID);
    const row = d.prepare('SELECT value FROM settings WHERE key=?').get(KEY) as { value: string } | undefined;
    const specs: ModelSpecification[] = JSON.parse(row?.value || '[]');
    if (!Array.isArray(specs)) throw new Error('模型规格配置无效，未修改配置');
    let spec = specs.find(s => s.modelId === ID), changed = false;
    const limits = { ...defaultRoutingLimits(),maxImages:30,maxVideos:10,maxAudios:10,resolutions:['720p'],
      duration:{mode:'range' as const,min:5,max:30,step:1,values:[]} };
    if (!spec) { spec = { modelId:ID,kind:'video',enabled:existing?.is_active===1,aliases:[],limits,routes:[] }; specs.push(spec); changed=true; }
    // Call with a channel ID only after authenticated discovery returned the exact ID.
    if (channelId !== undefined && !spec.routes.some(r => r.channelId===channelId && r.executionModel===ID && r.upstreamModel===ID)) {
      spec.routes.push({id:'v6k-kk25-'+channelId,channelId,executionModel:ID,upstreamModel:ID,enabled:true,
        limits:structuredClone(limits),cost:5.5,costUnit:'per_call',resolutionCosts:{},priority:0}); changed=true;
    }
    if (changed) d.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY,JSON.stringify(specs));
  })();
}
