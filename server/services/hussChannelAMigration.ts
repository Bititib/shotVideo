import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { channels, models, settings } from '../db/schema.js';
import { HUSS_BB_A_MODEL, HUSS_BB_PUBLIC_MODEL, HUSS_HSS_MODEL, hussBbAModelLimits } from '../../shared/hussBbVideo.js';
import { isHussChannel } from './hussVideoAdapter.js';
import { getModelSpecification, saveModelSpecification } from './modelRoutingService.js';

const KEY = 'migration_huss_bb_channel_a_v1';
/** Switch new requests only. Never rewrite contents, original payloads, or billing. */
export function migrateHussChannelA() {
  if (db.select().from(settings).where(eq(settings.key, KEY)).get()) return;
  sqlite.transaction(() => {
    for (const channel of db.select().from(channels).all().filter(isHussChannel)) {
      const supported: string[] = JSON.parse(channel.supportedModels || '[]');
      const mapping = JSON.parse(channel.modelMapping || '{}');
      for (const publicId of [HUSS_BB_PUBLIC_MODEL, HUSS_HSS_MODEL]) {
        const spec = getModelSpecification(publicId);
        const related = spec?.routes.some(r => r.channelId === channel.id);
        if (!related && !supported.includes(publicId) && !mapping[publicId]) continue;
        mapping[publicId] = HUSS_BB_A_MODEL;
        if (!supported.includes(publicId)) supported.push(publicId);
        const registered = db.select().from(models).where(eq(models.modelId, publicId)).get();
        if (!registered) continue;
        const limits = hussBbAModelLimits();
        const route = {id:'huss-'+channel.id+'-'+publicId,channelId:channel.id,executionModel:publicId,
          upstreamModel:HUSS_BB_A_MODEL,enabled:true,limits,cost:null,costUnit:'unknown' as const,resolutionCosts:{},priority:channel.priority};
        const routes = related ? spec!.routes.map(r => r.channelId !== channel.id ? r : {...r,upstreamModel:HUSS_BB_A_MODEL,executionModel:publicId,limits})
          : [...(spec?.routes || []),route];
        saveModelSpecification(spec ? {...spec,limits,routes} : {modelId:publicId,kind:'video',enabled:true,aliases:[],limits,routes});
      }
      db.update(channels).set({supportedModels:JSON.stringify(supported),modelMapping:JSON.stringify(mapping)})
        .where(eq(channels.id,channel.id)).run();
    }
    db.insert(settings).values({key:KEY,value:'done',label:'HUSS 渠道A替换完成'}).run();
  })();
}
