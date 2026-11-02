import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js',async()=>(await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
import { db,sqlite } from '../server/db/index.js';
import { channels,contents,models,modelPricing,users,userModelPricing } from '../server/db/schema.js';
import { ensureBbHssKkMapping } from '../server/services/bbHssKkMigration.js';
import { ensureV6kKk25Model } from '../server/services/v6kKk25Catalog.js';
import { BB_HSS_KK_ENTRIES,bbHssKkLimits } from '../shared/bbHssKk.js';
import { eq } from 'drizzle-orm';
beforeEach(()=>{sqlite.exec('SAVEPOINT migrate_kk');});afterEach(()=>{sqlite.exec('ROLLBACK TO migrate_kk; RELEASE migrate_kk');});afterAll(()=>sqlite.close());
it('archives old definitions and prices once, preserving model identities, personal prices, jobs and wallets across repeated startup/sync',()=>{
 db.insert(channels).values([{id:1,name:'old HUSS',type:'huss',apiKey:'original-key',supportedModels:JSON.stringify([...BB_HSS_KK_ENTRIES,'mj-v8.2']),modelMapping:'{}'},
 {id:21,name:'V6K',type:'zongheng-v6k',supportedModels:'["kkseadanco2.5"]',modelMapping:'{"kkseadanco2.5":"kkseadanco2.5"}',apiKey:'kk-key'}]).run();
 db.insert(users).values({id:1,email:'old@test',username:'old',passwordHash:'test',balance:94}).run();
 db.insert(contents).values({userId:1,type:'video',modelId:BB_HSS_KK_ENTRIES[1],status:'processing',cost:6,metadata:'{"videoId":"original","channelId":1,"seconds":4}'}).run();
 for(const id of BB_HSS_KK_ENTRIES){db.insert(models).values({modelId:id,displayName:'custom '+id,provider:'huss',capabilities:'["video"]',isActive:0}).run();db.insert(modelPricing).values({modelPattern:id,billingType:'per_call',inputPrice:4.5,extraParams:'{"720P":4.5}'}).run();}
 ensureV6kKk25Model(sqlite,21);
 db.insert(userModelPricing).values({userId:1,modelId:db.select().from(models).where(eq(models.modelId,BB_HSS_KK_ENTRIES[0])).get()!.id,billingType:'per_call',inputPrice:3,outputPrice:0,updatedBy:1}).run();
 const identities=()=>db.select().from(models).all().map(m=>({id:m.id,modelId:m.modelId,displayName:m.displayName,isActive:m.isActive}));
 const before=JSON.stringify([db.select().from(contents).all(),db.select().from(users).all(),identities(),db.select().from(userModelPricing).all()]);
 ensureBbHssKkMapping(sqlite);
 expect(JSON.stringify([db.select().from(contents).all(),db.select().from(users).all(),identities(),db.select().from(userModelPricing).all()])).toBe(before);
 const read=()=>JSON.parse((sqlite.prepare('SELECT value FROM settings WHERE key=?').get('model_specification_routes_v1') as any).value);
 for(const id of BB_HSS_KK_ENTRIES){expect(read().find((s:any)=>s.modelId===id)).toMatchObject({enabled:false,limits:bbHssKkLimits(),routes:[{channelId:21,executionModel:id,upstreamModel:'kkseadanco2.5'}]});expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern,id)).get()).toMatchObject({inputPrice:6.5,billingType:'per_call'});}
 expect(JSON.parse(db.select().from(channels).where(eq(channels.id,21)).get()!.supportedModels)).toEqual(['kkseadanco2.5',...BB_HSS_KK_ENTRIES]);
 expect(JSON.parse(db.select().from(channels).where(eq(channels.id,1)).get()!.supportedModels)).toEqual(['mj-v8.2']);
 const specs=read();for(const s of specs.filter((s:any)=>BB_HSS_KK_ENTRIES.includes(s.modelId))){s.routes[0].enabled=false;s.limits.maxImages=20;}
 sqlite.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(specs),'model_specification_routes_v1');
 db.update(modelPricing).set({inputPrice:7.7}).where(eq(modelPricing.modelPattern,BB_HSS_KK_ENTRIES[0])).run();
 ensureBbHssKkMapping(sqlite);ensureBbHssKkMapping(sqlite,21);
 expect(read()).toEqual(specs);expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern,BB_HSS_KK_ENTRIES[0])).get()?.inputPrice).toBe(7.7);
});
it('does not invent KK authorization or grant routes from a public name alone',()=>{
 ensureV6kKk25Model(sqlite);ensureBbHssKkMapping(sqlite);
 const specs=JSON.parse((sqlite.prepare('SELECT value FROM settings WHERE key=?').get('model_specification_routes_v1') as any).value);
 for(const id of BB_HSS_KK_ENTRIES)expect(specs.find((s:any)=>s.modelId===id).routes).toEqual([]);
});
