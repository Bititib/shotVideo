import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryDatabase } from './helpers/memoryDatabase.js';
import { migrateMjNaming } from '../server/db/mjNamingMigration.js';
import { channels, contents, models, modelPricing, settings, apiTokens, tierModelAccess } from '../server/db/schema.js';
import { LEGACY_MJ_MODEL_ID, MJ_MODEL_ID } from '../shared/mj.js';
import { newDocument, newNode, parseDocument } from '../shared/canvasModel.js';

const databases: ReturnType<typeof createMemoryDatabase>[] = [];
afterEach(() => { databases.splice(0).forEach(database => database.sqlite.close()); });

describe('MJ public naming compatibility', () => {
  it('migrates existing configuration and pending tasks without changing prices, keys or saved results', () => {
    const database = createMemoryDatabase(); databases.push(database);
    const { db, sqlite } = database;
    db.insert(models).values({ id:88, modelId:LEGACY_MJ_MODEL_ID, provider:'kmai', displayName:'MJ · 1K（KMAI）', isActive:1 }).run();
    db.insert(channels).values({ id:9, name:'KMAI MJ', type:'kmai', baseUrl:'https://kmai.us.ci/v1/', apiKey:'private-test-key',
      supportedModels:JSON.stringify([LEGACY_MJ_MODEL_ID]), modelMapping:JSON.stringify({ [LEGACY_MJ_MODEL_ID]:'mj_imagine' }) }).run();
    db.insert(modelPricing).values({ modelPattern:LEGACY_MJ_MODEL_ID, billingType:'per_call', inputPrice:2 }).run();
    db.insert(tierModelAccess).values({ tierId:1, modelId:88 }).run();
    db.insert(apiTokens).values({ tokenKey:'test-key', allowedModels:JSON.stringify([LEGACY_MJ_MODEL_ID]) }).run();
    db.insert(settings).values({ key:'model_specification_routes_v1', value:JSON.stringify([{ modelId:LEGACY_MJ_MODEL_ID,
      imageFamily:'kmai-mj-imagine', enabled:true, routes:[{ id:'kmai-mj-9', channelId:9, executionModel:LEGACY_MJ_MODEL_ID, upstreamModel:'mj_imagine', cost:0.5 }] }]) }).run();
    const batch = { sourceUrls:['https://cdn.example/one.png'], jobs:[{ index:0, localUrl:'/api/uploads/result.png', status:'completed' }] };
    db.insert(contents).values({ userId:1, type:'image', modelId:LEGACY_MJ_MODEL_ID, cost:2, status:'processing',
      inputText:LEGACY_MJ_MODEL_ID, metadata:JSON.stringify({ model:LEGACY_MJ_MODEL_ID, requestedModel:LEGACY_MJ_MODEL_ID,
        prompt:LEGACY_MJ_MODEL_ID, nativeImageOutputs:4, nativeImageBatch:batch, billingStatus:'settled' }) }).run();
    migrateMjNaming(sqlite); migrateMjNaming(sqlite);
    expect(db.select().from(models).get()).toMatchObject({ id:88, modelId:MJ_MODEL_ID, provider:'mj', displayName:'MJ · 1K', isActive:1 });
    expect(db.select().from(channels).get()).toMatchObject({ id:9, type:'mj', name:'MJ', baseUrl:'', apiKey:'private-test-key',
      supportedModels:JSON.stringify([MJ_MODEL_ID]), modelMapping:JSON.stringify({ [MJ_MODEL_ID]:'mj_imagine' }) });
    expect(db.select().from(tierModelAccess).get()?.modelId).toBe(88);
    expect(db.select().from(modelPricing).get()).toMatchObject({ modelPattern:MJ_MODEL_ID, inputPrice:2 });
    expect(db.select().from(apiTokens).get()?.allowedModels).toBe(JSON.stringify([MJ_MODEL_ID]));
    expect(JSON.parse(db.select().from(settings).get()!.value)[0]).toMatchObject({ modelId:MJ_MODEL_ID, imageFamily:'mj-imagine',
      routes:[{ id:'mj-9', executionModel:MJ_MODEL_ID, cost:0.5 }] });
    const content = db.select().from(contents).get()!;
    expect(content).toMatchObject({ modelId:MJ_MODEL_ID, cost:2, status:'processing', inputText:LEGACY_MJ_MODEL_ID });
    expect(JSON.parse(content.metadata)).toMatchObject({ model:MJ_MODEL_ID, requestedModel:MJ_MODEL_ID, prompt:LEGACY_MJ_MODEL_ID,
      nativeImageOutputs:4, nativeImageBatch:batch, billingStatus:'settled' });
  });
  it('normalizes saved canvas model choices while retaining image history and prompts', () => {
    const node = { ...newNode('image', {x:100,y:200}), model:LEGACY_MJ_MODEL_ID,
      versions:[{ id:'v1', src:'/image.png', prompt:LEGACY_MJ_MODEL_ID, model:LEGACY_MJ_MODEL_ID, createdAt:1 }] };
    const parsed = parseDocument({ ...newDocument(), nodes:[node], drafts:{ [node.id]:{
      kind:'image', prompt:LEGACY_MJ_MODEL_ID, model:LEGACY_MJ_MODEL_ID, ratio:'1:1', resolution:'1K', seconds:5, count:4 } } });
    expect(parsed.nodes[0]).toMatchObject({ id:node.id, model:MJ_MODEL_ID, versions:[{ src:'/image.png', model:MJ_MODEL_ID, prompt:LEGACY_MJ_MODEL_ID }] });
    expect(parsed.drafts?.[node.id]).toMatchObject({ model:MJ_MODEL_ID, prompt:LEGACY_MJ_MODEL_ID, count:4 });
  });
  it('leaves a fresh installation without legacy tables intact', () => {
    const database = createMemoryDatabase(); databases.push(database);
    expect(() => migrateMjNaming(database.sqlite)).not.toThrow();
  });
});
