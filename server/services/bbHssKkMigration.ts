import type Database from 'better-sqlite3';
import { BB_HSS_KK_ENTRIES, bbHssKkLimits, isBbHssKkEntry } from '../../shared/bbHssKk.js';
import { V6K_KK25_MODEL } from '../../shared/zonghengVideo.js';
import type { ModelSpecification } from '../../shared/modelRouting.js';
import { readBbHssSources } from './bbHssSourcePolicy.js';
import { bbHssMoManaged } from './bbHssMoMigration.js';
const KEY='bb_hss_kk_source_v1', CONFIG='model_specification_routes_v1';
const read=(d:Database.Database,key:string,fallback:any)=>{const r=d.prepare('SELECT value FROM settings WHERE key=?').get(key) as any;return r?JSON.parse(r.value):fallback;};
const write=(d:Database.Database,key:string,value:any)=>d.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));
export function bbHssKkManaged(d:Database.Database,id:string):boolean {return isBbHssKkEntry(id)&&(bbHssMoManaged(d,id)||Boolean(read(d,KEY,{}).products?.[id]));}
/** One-time authorized retail/spec migration, then additive authenticated route binding only. No order or wallet writes. */
export function ensureBbHssKkMapping(d:Database.Database,authorizedChannelId?:number) {
  return d.transaction(()=>{
    const state=read(d,KEY,{products:{}}),specs:ModelSpecification[]=read(d,CONFIG,[]),selections=readBbHssSources(d);
    const channels=d.prepare('SELECT id,type,supported_models,model_mapping FROM channels').all() as any[];
    let changed=false;
    for(const id of BB_HSS_KK_ENTRIES){
      if(bbHssMoManaged(d,id))continue;
      let model=d.prepare('SELECT * FROM models WHERE model_id=?').get(id) as any;
      let spec=specs.find(s=>s.modelId===id);
      if(!state.products[id]){
        if(model&&!JSON.parse(model.capabilities||'[]').includes('video'))throw Error(id+' 已被其他类型产品占用，未修改配置');
        state.products[id]={previousModel:model||null,previousSpecification:spec?structuredClone(spec):null,
          previousPrices:d.prepare('SELECT * FROM model_pricing WHERE model_pattern=?').all(id),appliedAt:new Date().toISOString()};
        if(!model){d.prepare('INSERT INTO models(provider,model_id,display_name,description,capabilities,is_active) VALUES(?,?,?,?,?,0)').run('zongheng-v6k',id,id,'30图10音10视/720P/5-30秒/按条计费','["video"]');model={is_active:0};}
        d.prepare('UPDATE models SET provider=?,description=? WHERE model_id=?').run('zongheng-v6k','30图10音10视/720P/5-30秒/按条计费',id);
        const prices=d.prepare('SELECT id,extra_params FROM model_pricing WHERE model_pattern=?').all(id) as any[];
        if(!prices.length)d.prepare("INSERT INTO model_pricing(model_pattern,billing_type,input_price,output_price,extra_params) VALUES(?,'per_call',6.5,0,?)").run(id,'{"720p":6.5}');
        for(const p of prices){const e=JSON.parse(p.extra_params||'{}');for(const k of Object.keys(e))if(k.toLowerCase()==='720p')e[k]=6.5;e['720p']=6.5;
          d.prepare("UPDATE model_pricing SET billing_type='per_call',input_price=6.5,output_price=0,extra_params=? WHERE id=?").run(JSON.stringify(e),p.id);}
        if(!spec){spec={modelId:id,kind:'video',enabled:model.is_active===1,aliases:[],limits:bbHssKkLimits(),routes:[]};specs.push(spec);}
        else{spec.limits=bbHssKkLimits();spec.routes=[];}
        changed=true;
      }
      if(!spec)continue; // A later administrator deletion must not be silently undone.
      // An explicit operator choice owns its routes. Neither startup nor catalog sync may rebind them.
      if(selections[id])continue;
      const kk=specs.find(s=>s.modelId===V6K_KK25_MODEL);
      const verified=authorizedChannelId===undefined?(kk?.routes||[]).filter(r=>r.upstreamModel===V6K_KK25_MODEL).map(r=>r.channelId):[authorizedChannelId];
      for(const channelId of new Set(verified)){
        const channel=channels.find(c=>c.id===channelId&&c.type==='zongheng-v6k');if(!channel)continue;
        const supported=JSON.parse(channel.supported_models||'[]'),mapping=JSON.parse(channel.model_mapping||'{}');
        if(!supported.includes(V6K_KK25_MODEL)||(mapping[V6K_KK25_MODEL]||V6K_KK25_MODEL)!==V6K_KK25_MODEL)continue;
        if(!spec.routes.some(r=>r.channelId===channelId&&r.upstreamModel===V6K_KK25_MODEL&&r.executionModel===id)){
          spec.routes.push({id:'kk-sale-'+channelId+'-'+id,channelId,executionModel:id,upstreamModel:V6K_KK25_MODEL,enabled:true,
            limits:bbHssKkLimits(),cost:5.5,costUnit:'per_call',resolutionCosts:{},priority:0});changed=true;}
        if(!supported.includes(id))supported.push(id);mapping[id]=V6K_KK25_MODEL;
        channel.supported_models=JSON.stringify(supported);channel.model_mapping=JSON.stringify(mapping);
        d.prepare('UPDATE channels SET supported_models=?,model_mapping=? WHERE id=?').run(JSON.stringify(supported),JSON.stringify(mapping),channelId);
      }
    }
    // Keep old channels/keys for original task recovery, but remove these sales from new HUSS selection.
    for(const channel of channels.filter(c=>c.type==='huss')){
      const supported=JSON.parse(channel.supported_models||'[]'),mapping=JSON.parse(channel.model_mapping||'{}');
      const remove=(id:string)=>isBbHssKkEntry(id)&&!(selections[id]?.source!=='KK'&&selections[id]?.channelId===channel.id);
      const kept=supported.filter((id:string)=>!remove(id));let altered=kept.length!==supported.length;
      for(const id of BB_HSS_KK_ENTRIES)if(remove(id)&&Object.hasOwn(mapping,id)){delete mapping[id];altered=true;}
      if(altered)d.prepare('UPDATE channels SET supported_models=?,model_mapping=? WHERE id=?').run(JSON.stringify(kept),JSON.stringify(mapping),channel.id);
    }
    if(changed)write(d,CONFIG,specs);write(d,KEY,state);
  })();
}
