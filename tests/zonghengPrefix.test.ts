import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { getTableConfig, SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core');
  const schema = await import('../server/db/schema');
  const sqlite = new Database(':memory:');
  const dialect = new SQLiteSyncDialect();
  for (const table of Object.values(schema)) {
    const config = getTableConfig(table as any);
    const columns = config.columns.map(c => {
      let def = '';
      if (c.default !== undefined) {
        const value = typeof c.default === 'object' ? dialect.sqlToQuery(c.default as any).sql
          : typeof c.default === 'string' ? "'" + c.default.replace(/'/g, "''") + "'" : String(c.default);
        def = ' DEFAULT ' + value;
      }
      return '"' + c.name + '" ' + c.getSQLType() + (c.primary ? ' PRIMARY KEY' : c.isUnique ? ' UNIQUE' : '') + def;
    });
    sqlite.exec('CREATE TABLE "' + config.name + '" (' + columns.join(',') + ')');
  }
  return { sqlite, db: drizzle(sqlite, { schema }) };
});

import { db, sqlite } from '../server/db/index';
import { models, channels, modelPricing, apiTokens, settings, contents, tierModelAccess } from '../server/db/schema';
import { migrateZonghengModelPrefix } from '../server/services/zonghengPrefixMigration';
import { resolvePublicModelId } from '../server/services/publicModelNameService';
import { PricingService } from '../server/services/pricingService';
import { ChannelService } from '../server/services/channelService';

const oldId = 'zongheng-Cseadanco2.5K', nextId = 'ZH-Cseadanco2.5K';
let modelId: number;
beforeEach(() => {
  for (const table of ['models','channels','model_pricing','api_tokens','settings','contents','tier_model_access']) sqlite.exec('DELETE FROM ' + table);
  modelId = Number(db.insert(models).values({modelId:oldId,displayName:'自定义名称',provider:'zongheng',capabilities:'["video"]',isActive:0}).run().lastInsertRowid);
  db.insert(tierModelAccess).values({tierId:7,modelId}).run();
  db.insert(modelPricing).values({modelPattern:oldId,billingType:'per_call',inputPrice:3,outputPrice:4,extraParams:'{"720p":5}'}).run();
  db.insert(channels).values({name:'test',type:'zongheng',baseUrl:'https://channel.invalid',apiKey:'test-key',supportedModels:JSON.stringify([oldId]),modelMapping:JSON.stringify({[oldId]:'Cseadanco2.5K'})}).run();
  db.insert(apiTokens).values({tokenKey:'test-token',allowedModels:JSON.stringify([oldId,'unrelated-model']),balance:20,usedAmount:8}).run();
  db.insert(contents).values({userId:1,type:'video',modelId:oldId,cost:9,status:'processing',metadata:'{"videoId":"vid_original"}'}).run();
  db.insert(settings).values({key:'public_model_name_aliases_v1',value:JSON.stringify({'prior-custom-name':modelId})}).run();
});
afterAll(() => sqlite.close());

describe('Zongheng namespace migration in isolated storage', () => {
  it('preserves model identity, prices, permissions and historical records, and is idempotent', () => {
    expect(migrateZonghengModelPrefix()).toEqual({models:1,prices:1,channels:1,tokens:1});
    expect(db.select().from(models).get()).toMatchObject({id:modelId,modelId:nextId,displayName:'自定义名称',isActive:0,capabilities:'["video"]'});
    expect(db.select().from(tierModelAccess).get()).toMatchObject({modelId,tierId:7});
    expect(db.select().from(modelPricing).get()).toMatchObject({modelPattern:nextId,billingType:'per_call',inputPrice:3,outputPrice:4,extraParams:'{"720p":5}'});
    const channel=db.select().from(channels).get()!;
    expect(JSON.parse(channel.supportedModels)).toEqual([nextId]);expect(JSON.parse(channel.modelMapping)).toEqual({[nextId]:'Cseadanco2.5K'});expect(channel.apiKey).toBe('test-key');
    const token=db.select().from(apiTokens).get()!;
    expect(JSON.parse(token.allowedModels)).toEqual([nextId,'unrelated-model']);expect(token).toMatchObject({balance:20,usedAmount:8});
    expect(db.select().from(contents).get()).toMatchObject({modelId:oldId,cost:9,status:'processing',metadata:'{"videoId":"vid_original"}'});
    expect(resolvePublicModelId(oldId)).toBe(nextId);expect(resolvePublicModelId('prior-custom-name')).toBe(nextId);
    expect(PricingService.quote(oldId,{resolution:'720p'},false).cost).toBe(5);
    expect(migrateZonghengModelPrefix()).toEqual({models:0,prices:0,channels:0,tokens:0});
    expect(ChannelService.findChannelForModel(oldId)).toBeNull(); // disabled still blocks both IDs
    sqlite.prepare('UPDATE models SET is_active=1').run();
    expect(ChannelService.findChannelForModel(oldId)?.modelMapping[nextId]).toBe('Cseadanco2.5K');
  });
  it('resolves an old-prefix API ID for a model first registered with ZH-', () => {
    sqlite.prepare('UPDATE models SET model_id=?').run(nextId);
    sqlite.prepare('DELETE FROM settings').run();
    expect(resolvePublicModelId(oldId)).toBe(nextId);
  });
  it('updates an ID used as its display name while keeping the former ID as an alias', () => {
    sqlite.prepare('UPDATE models SET display_name=?').run(oldId);
    migrateZonghengModelPrefix();expect(db.select().from(models).get()?.displayName).toBe(nextId);expect(resolvePublicModelId(oldId)).toBe(nextId);
  });
  it.each(['model','price','mapping'])('rolls back all changes when a %s conflicts with the new prefix', conflict => {
    if(conflict==='model') db.insert(models).values({modelId:nextId,displayName:'existing',provider:'zongheng'}).run();
    if(conflict==='price') db.insert(modelPricing).values({modelPattern:nextId,billingType:'per_call',inputPrice:11}).run();
    if(conflict==='mapping') sqlite.prepare('UPDATE channels SET model_mapping=?').run(JSON.stringify({[oldId]:'Cseadanco2.5K',[nextId]:'different-public-id'}));
    expect(()=>migrateZonghengModelPrefix()).toThrow('冲突');
    expect(db.select().from(models).all().find(m=>m.id===modelId)?.modelId).toBe(oldId);
    expect(db.select().from(modelPricing).all().some(p=>p.modelPattern===oldId)).toBe(true);
    expect(JSON.parse(db.select().from(channels).get()!.supportedModels)).toEqual([oldId]);
    expect(JSON.parse(db.select().from(apiTokens).get()!.allowedModels)).toEqual([oldId,'unrelated-model']);
    expect(JSON.parse(db.select().from(settings).get()!.value)[oldId]).toBeUndefined();
  });
});
