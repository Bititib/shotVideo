import { beforeEach,afterEach,afterAll,expect,it,vi } from 'vitest';
vi.mock('../server/db/index.js',async()=>(await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
import {db,sqlite} from '../server/db/index.js';
import {channels,models,modelPricing,settings,contents,users} from '../server/db/schema.js';
import {pruneUnapprovedV6kBindings} from '../server/services/v6kApprovedBindings.js';
import {defaultRoutingLimits} from '../shared/modelRouting.js';
const CONFIG='model_specification_routes_v1';
const route=(channelId:number,executionModel:string,upstreamModel:string)=>({id:channelId+'-'+executionModel,channelId,executionModel,upstreamModel,enabled:false,limits:defaultRoutingLimits(),cost:9,costUnit:'per_call',resolutionCosts:{},priority:7});
beforeEach(()=>sqlite.exec('SAVEPOINT approved_bindings'));
afterEach(()=>sqlite.exec('ROLLBACK TO approved_bindings; RELEASE approved_bindings'));
afterAll(()=>sqlite.close());
it('archives obsolete V6K associations and routes without deleting model identities, prices, switches, jobs, credentials or other channels',()=>{
  const old='ZH-dola2.0',tt='ZH-TTseadanco2.5-480',sale='bb-2.5-301010';
  db.insert(channels).values([{id:21,name:'V6K',type:'zongheng-v6k',status:0,apiKey:'keep-original-key',baseUrl:'https://www.v6k.top',supportedModels:JSON.stringify([old,tt,sale,'*']),modelMapping:JSON.stringify({[old]:'dola2.0',[tt]:'TTseadanco2.5-480',[sale]:'kkseadanco2.5',mappingOnly:'unknown'})},
    {id:22,name:'Other provider',type:'other',apiKey:'other-key',supportedModels:JSON.stringify([old]),modelMapping:JSON.stringify({[old]:'dola2.0'})}]).run();
  db.insert(users).values({id:1,email:'preserve@test',username:'preserve',passwordHash:'test',balance:93.5}).run();
  db.insert(contents).values({userId:1,type:'video',modelId:old,status:'processing',cost:6.5,metadata:'{"channelId":21,"videoId":"accepted-original","billingStatus":"reserved"}'}).run();
  db.insert(models).values({modelId:old,displayName:'Historic model',provider:'zongheng-v6k',capabilities:'["video"]',isActive:1}).run();
  db.insert(modelPricing).values({modelPattern:old,billingType:'per_call',inputPrice:6.5}).run();
  const specs=[{modelId:old,enabled:true,limits:defaultRoutingLimits(),routes:[route(21,old,'dola2.0'),route(22,old,'dola2.0')]},
    {modelId:tt,enabled:false,limits:defaultRoutingLimits(),routes:[route(21,tt,'TTseadanco2.5-480')]},
    {modelId:sale,enabled:true,limits:defaultRoutingLimits(),routes:[route(21,sale,'kkseadanco2.5')]}];
  db.insert(settings).values({key:CONFIG,value:JSON.stringify(specs)}).run();
  const untouched=()=>JSON.stringify([db.select().from(models).all(),db.select().from(modelPricing).all(),db.select().from(users).all(),db.select().from(contents).all(),sqlite.prepare('SELECT * FROM channels WHERE id=22').get()]);
  const before=untouched();expect(pruneUnapprovedV6kBindings(sqlite)).toEqual({removedBindings:3,removedRoutes:1});expect(untouched()).toBe(before);
  expect(sqlite.prepare('SELECT supported_models,model_mapping,status,api_key FROM channels WHERE id=21').get()).toEqual({supported_models:JSON.stringify([tt,sale]),model_mapping:JSON.stringify({[tt]:'TTseadanco2.5-480',[sale]:'kkseadanco2.5'}),status:0,api_key:'keep-original-key'});
  const after=JSON.parse((sqlite.prepare('SELECT value FROM settings WHERE key=?').get(CONFIG) as any).value);
  expect(after).toEqual([{...specs[0],routes:[specs[0].routes[1]]},...specs.slice(1)]);
  const archive=sqlite.prepare('SELECT * FROM v6k_unapproved_binding_archive').all() as any[];expect(archive).toHaveLength(1);expect(archive[0].removed_routes).toContain('dola2.0');expect(JSON.stringify(archive)).not.toContain('keep-original-key');
  expect(pruneUnapprovedV6kBindings(sqlite)).toEqual({removedBindings:0,removedRoutes:0});expect(sqlite.prepare('SELECT count(*) n FROM v6k_unapproved_binding_archive').get()).toEqual({n:1});
});
it('rolls back the entire cleanup rather than stripping malformed configuration',()=>{
  db.insert(channels).values([{id:21,name:'valid',type:'zongheng-v6k',supportedModels:'["ZH-dola2.0"]',modelMapping:'{}'},
    {id:22,name:'invalid',type:'zongheng-v6k',supportedModels:'{"not":"a list"}',modelMapping:'{}'}]).run();
  const before=db.select().from(channels).all();expect(()=>pruneUnapprovedV6kBindings(sqlite)).toThrow('格式无效');expect(db.select().from(channels).all()).toEqual(before);
});
