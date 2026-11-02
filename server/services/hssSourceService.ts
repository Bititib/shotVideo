import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { channels, settings } from '../db/schema.js';
import { HUSS_HSS_MODEL, HUSS_HSS_B_MODEL, HUSS_BB_A_MODEL, hussHssModelLimits, hussBbAModelLimits } from '../../shared/hussBbVideo.js';
import { getModelSpecification, saveModelSpecification } from './modelRoutingService.js';
import { bbHssKkManaged } from './bbHssKkMigration.js';
const key = 'hss_manual_video_source';
export function selectedHssSource(): 'A' | 'B' | undefined {
  const value = db.select().from(settings).where(eq(settings.key,key)).get()?.value;
  return value === 'A' || value === 'B' ? value : undefined;
}
export function switchHssSource(source: unknown) {
  const invalid = (message:string) => Object.assign(new Error(message),{status:400});
  if(bbHssKkManaged(sqlite,HUSS_HSS_MODEL))throw Object.assign(new Error('请使用 BB/HSS 来源切换，选择渠道并验证模型权限'),{status:409});
  if (source !== 'A' && source !== 'B') throw invalid('请选择原渠道B或新渠道A');
  return sqlite.transaction(() => {
    const spec = getModelSpecification(HUSS_HSS_MODEL);
    if (!spec || !spec.routes.length) throw invalid('请先同步 HUSS 模型和线路');
    const rows = db.select().from(channels).all();
    const eligible = spec.routes.filter(r => rows.some(c=>c.id===r.channelId && c.type==='huss') && [HUSS_BB_A_MODEL,HUSS_HSS_B_MODEL].includes(r.upstreamModel));
    if (!eligible.length || spec.routes.some(r=>r.enabled && !eligible.includes(r))) throw invalid('存在其他模型线路，请先核对线路配置');
    const upstreamModel = source === 'A' ? HUSS_BB_A_MODEL : HUSS_HSS_B_MODEL;
    const limits = source === 'A' ? hussBbAModelLimits() : hussHssModelLimits();
    const result = saveModelSpecification({...spec,limits,routes:spec.routes.map(r=>eligible.includes(r) ? {...r,upstreamModel,limits,...(r.upstreamModel !== upstreamModel ? {cost:null,costUnit:'unknown' as const,resolutionCosts:{}} : {})} : r)});
    for (const id of new Set(eligible.map(r=>r.channelId))) {
      const channel=rows.find(c=>c.id===id)!;
      const mapping=JSON.parse(channel.modelMapping || '{}');mapping[HUSS_HSS_MODEL]=upstreamModel;
      db.update(channels).set({modelMapping:JSON.stringify(mapping)}).where(eq(channels.id,id)).run();
    }
    db.insert(settings).values({key,value:source}).onConflictDoUpdate({target:settings.key,set:{value:source}}).run();
    return result;
  })();
}
