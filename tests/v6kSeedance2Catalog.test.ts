import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ensureV6kSeedance20Models, bindV6kSeedance20Routes } from '../server/services/v6kSeedance2Catalog';
import { V6K_SEEDANCE_20_MODEL, V6K_XX_SEEDANCE_20_MODEL, v6kSeedance20Limits } from '../shared/v6kSeedance2';
import { zonghengPublicModelId } from '../shared/zonghengVideo';
import { existingModelLimits } from '../server/services/modelInputPresets';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function database() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE models(provider TEXT,model_id TEXT UNIQUE,display_name TEXT,description TEXT,capabilities TEXT,is_active INTEGER);
    CREATE TABLE model_pricing(model_pattern TEXT,billing_type TEXT,input_price REAL,output_price REAL,extra_params TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE contents(id INTEGER,status TEXT,cost REAL,metadata TEXT);
    INSERT INTO contents VALUES(1,'processing',7,'{"videoId":"original"}');`);
  return db;
}
function specs(db: Database.Database): any[] {
  return JSON.parse((db.prepare("SELECT value FROM settings WHERE key='model_specification_routes_v1'").get() as any).value);
}

describe('separate V6K Seedance 2.0 sale products', () => {
  it('registers exactly two disabled entries at 4 per call without changing historical tasks or admin settings', () => {
    const db = database(); ensureV6kSeedance20Models(db);
    expect(db.prepare('SELECT model_id,is_active FROM models ORDER BY model_id').all()).toEqual([
      {model_id: V6K_XX_SEEDANCE_20_MODEL,is_active:0}, {model_id:V6K_SEEDANCE_20_MODEL,is_active:0}]);
    expect(db.prepare('SELECT billing_type,input_price FROM model_pricing').all()).toEqual([
      {billing_type:'per_call',input_price:4},{billing_type:'per_call',input_price:4}]);
    db.exec('UPDATE models SET is_active=1; UPDATE model_pricing SET input_price=9');
    const changed = specs(db); changed[0].enabled = true; changed[0].limits.duration.max = 10;
    db.prepare('UPDATE settings SET value=?').run(JSON.stringify(changed));
    ensureV6kSeedance20Models(db);
    expect(specs(db)).toEqual(changed);
    expect(db.prepare('SELECT input_price FROM model_pricing').all()).toEqual([{input_price:9},{input_price:9}]);
    expect(db.prepare('SELECT is_active FROM models').all()).toEqual([{is_active:1},{is_active:1}]);
    expect(db.prepare('SELECT * FROM contents').get()).toEqual({id:1,status:'processing',cost:7,metadata:'{"videoId":"original"}'});
  });
  it('binds both A routes but keeps XX independent, and preserves manual costs and route switches on sync', () => {
    const db = database(); ensureV6kSeedance20Models(db);
    bindV6kSeedance20Routes(db,21,['Asedanco2.05','Asedanco2.0','XXsedanco2.0']);
    const entries = specs(db);
    expect(entries[0].routes.map((r: any) => [r.executionModel,r.upstreamModel,r.cost])).toEqual([
      [V6K_SEEDANCE_20_MODEL,'Asedanco2.0',2.5],[V6K_SEEDANCE_20_MODEL,'Asedanco2.05',3]]);
    expect(entries[1].routes.map((r: any) => [r.executionModel,r.upstreamModel,r.limits.maxVideos])).toEqual([
      [V6K_XX_SEEDANCE_20_MODEL,'XXsedanco2.0',0]]);
    entries[0].routes[0].enabled=false; entries[0].routes[0].cost=8;
    db.prepare('UPDATE settings SET value=?').run(JSON.stringify(entries));
    bindV6kSeedance20Routes(db,21,['Asedanco2.0','XXsedanco2.0']);
    expect(specs(db)[0].routes).toEqual(entries[0].routes);
    expect(specs(db)[1]).toEqual(entries[1]);
    bindV6kSeedance20Routes(db,22,['Asedanco2.05']);
    bindV6kSeedance20Routes(db,21,[]);
    expect(specs(db)[0].routes.map((r: any) => r.channelId)).toEqual([21,21,22]);
    expect(specs(db)[1]).toEqual(entries[1]);
  });
  it('does not grant public-square-only models or collapse the XX capability into the A product', () => {
    const db = database(); ensureV6kSeedance20Models(db);
    bindV6kSeedance20Routes(db,21,['Asedanco2.05']);
    expect(specs(db)[0].routes.map((r: any) => r.upstreamModel)).toEqual(['Asedanco2.05']);
    expect(specs(db)[1].routes).toEqual([]);
    expect(zonghengPublicModelId('Asedanco2.0')).toBe(V6K_SEEDANCE_20_MODEL);
    expect(zonghengPublicModelId('Asedanco2.05')).toBe(V6K_SEEDANCE_20_MODEL);
    expect(zonghengPublicModelId('XXsedanco2.0')).toBe(V6K_XX_SEEDANCE_20_MODEL);
    expect(v6kSeedance20Limits(V6K_SEEDANCE_20_MODEL)).toMatchObject({maxImages:9,maxAudios:3,maxVideos:3,resolutions:['720p'],duration:{min:5,max:15}});
    expect(existingModelLimits(V6K_XX_SEEDANCE_20_MODEL,'video')).toMatchObject({maxImages:9,maxAudios:3,maxVideos:0});
  });
  it('rolls back if a requested public ID already belongs to another product', () => {
    const db=database(); db.prepare('INSERT INTO models VALUES(?,?,?,?,?,?)').run('other',V6K_XX_SEEDANCE_20_MODEL,'custom','custom','["video"]',1);
    expect(()=>ensureV6kSeedance20Models(db)).toThrow('已被其他产品占用');
    expect(db.prepare('SELECT COUNT(*) AS count FROM models').get()).toEqual({count:1});
    expect(db.prepare('SELECT * FROM model_pricing').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM settings').all()).toEqual([]);
  });
});
