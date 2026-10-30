import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryDatabase } from './helpers/memoryDatabase.js';
import { migrateHmDdlongNaming } from '../server/db/hmDdlongNamingMigration.js';
import { channels, contents, models, modelPricing, settings, apiTokens, tierModelAccess, userModelAccess, userModelPricing } from '../server/db/schema.js';
import { newDocument, newNode, parseDocument } from '../shared/canvasModel.js';

const oldId = 'sd2.5-301010', newId = 'sd2.5-933';
const databases: ReturnType<typeof createMemoryDatabase>[] = [];
function setup() { const database = createMemoryDatabase(); databases.push(database); return database; }
afterEach(() => databases.splice(0).forEach(database => database.sqlite.close()));

describe('HM DDLONG public model rename', () => {
  it('preserves numeric identity, individual prices, access, task evidence and funds across repeated migrations', () => {
    const { db, sqlite } = setup();
    db.insert(models).values({ id:88, modelId:oldId, provider:'hmstudio', displayName:'HM-Sd2.5-301010', isActive:0 }).run();
    db.insert(modelPricing).values({ modelPattern:oldId, billingType:'per_call', inputPrice:6.1, extraParams:'{"720p":6.1,"1080p":10.1}' }).run();
    db.insert(userModelPricing).values({ userId:1, modelId:88, billingType:'per_call', inputPrice:5.5, outputPrice:0, extraParams:'{"1080p":8.5}', updatedBy:1 }).run();
    db.insert(userModelAccess).values({ userId:1, modelId:88, accessMode:'allow' }).run();
    db.insert(tierModelAccess).values({ tierId:1, modelId:88 }).run();
    db.insert(channels).values({ name:'HM', type:'hmstudio', baseUrl:'https://example.test', apiKey:'test-key',
      supportedModels:JSON.stringify([oldId]), modelMapping:JSON.stringify({[oldId]:'SD2.5-30-10-10'}) }).run();
    db.insert(apiTokens).values({ tokenKey:'test-token', allowedModels:JSON.stringify([oldId]) }).run();
    db.insert(settings).values({ key:'model_specification_routes_v1', value:JSON.stringify([{ modelId:oldId, aliases:[oldId], routes:[{executionModel:oldId,upstreamModel:'SD2.5-30-10-10',cost:4}] }]) }).run();
    db.insert(contents).values({ userId:1, type:'video', modelId:oldId, status:'processing', cost:5.5, inputText:oldId,
      metadata:JSON.stringify({ model:oldId, requestedModel:oldId, prompt:oldId, upstreamModel:'SD2.5-30-10-10', upstreamTaskId:'original-task', billingStatus:'reserved' }) }).run();
    sqlite.exec('CREATE TABLE video_batches (model TEXT, payload TEXT)');
    sqlite.prepare('INSERT INTO video_batches VALUES (?,?)').run(oldId,JSON.stringify({model:oldId,prompt:oldId}));
    const originalPrice = db.select().from(userModelPricing).get();
    migrateHmDdlongNaming(sqlite); migrateHmDdlongNaming(sqlite);
    expect(db.select().from(models).get()).toMatchObject({id:88,modelId:newId,displayName:'HM-Sd2.5-933',isActive:0});
    expect(db.select().from(modelPricing).get()).toMatchObject({modelPattern:newId,inputPrice:6.1,extraParams:'{"720p":6.1,"1080p":10.1}'});
    expect(db.select().from(userModelPricing).get()).toEqual(originalPrice);
    expect(db.select().from(userModelAccess).get()).toMatchObject({modelId:88,accessMode:'allow'});
    expect(db.select().from(tierModelAccess).get()?.modelId).toBe(88);
    expect(db.select().from(channels).get()).toMatchObject({apiKey:'test-key',supportedModels:JSON.stringify([newId]),modelMapping:JSON.stringify({[newId]:'SD2.5-30-10-10'})});
    expect(db.select().from(apiTokens).get()?.allowedModels).toBe(JSON.stringify([newId]));
    expect(JSON.parse(db.select().from(settings).get()!.value)[0]).toMatchObject({modelId:newId,aliases:[newId],routes:[{executionModel:newId,upstreamModel:'SD2.5-30-10-10',cost:4}]});
    const order = db.select().from(contents).get()!;
    expect(order).toMatchObject({modelId:newId,status:'processing',cost:5.5,inputText:oldId});
    expect(JSON.parse(order.metadata)).toMatchObject({model:newId,requestedModel:newId,prompt:oldId,upstreamModel:'SD2.5-30-10-10',upstreamTaskId:'original-task',billingStatus:'reserved'});
    expect(sqlite.prepare('SELECT * FROM video_batches').get()).toEqual({model:newId,payload:JSON.stringify({model:newId,prompt:oldId})});
  });
  it.each(['model','price','configuration'])('rolls back all changes on a %s naming collision', conflict => {
    const { db, sqlite } = setup();
    db.insert(models).values({id:88,modelId:oldId,provider:'hmstudio',displayName:oldId}).run();
    db.insert(modelPricing).values({modelPattern:oldId,billingType:'per_call',inputPrice:5.5}).run();
    if(conflict==='model') db.insert(models).values({modelId:newId,provider:'hmstudio',displayName:newId}).run();
    if(conflict==='price') db.insert(modelPricing).values({modelPattern:newId,billingType:'per_call',inputPrice:7}).run();
    if(conflict==='configuration') db.insert(channels).values({name:'HM',type:'hmstudio',baseUrl:'',apiKey:'',modelMapping:JSON.stringify({[oldId]:'old',[newId]:'new'})}).run();
    expect(()=>migrateHmDdlongNaming(sqlite)).toThrow();
    expect(db.select().from(models).all().find(m=>m.id===88)?.modelId).toBe(oldId);
    expect(db.select().from(modelPricing).all().find(m=>m.modelPattern===oldId)?.inputPrice).toBe(5.5);
  });
  it('updates saved canvas selections and versions without rewriting prompts or media', () => {
    const node = {...newNode('video',{x:0,y:0}),model:oldId,versions:[{id:'v1',src:'/video.mp4',model:oldId,prompt:oldId,createdAt:1}]};
    const parsed = parseDocument({...newDocument(),nodes:[node],drafts:{[node.id]:{kind:'video',model:oldId,prompt:oldId,ratio:'16:9',resolution:'720p',seconds:30,count:1}}});
    expect(parsed.nodes[0]).toMatchObject({model:newId,versions:[{model:newId,src:'/video.mp4',prompt:oldId}]});
    expect(parsed.drafts?.[node.id]).toMatchObject({model:newId,prompt:oldId});
  });
  it('supports fresh installations', () => expect(()=>migrateHmDdlongNaming(setup().sqlite)).not.toThrow());
});
