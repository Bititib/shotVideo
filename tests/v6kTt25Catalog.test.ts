import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ensureV6kTt25Models, bindV6kTt25Routes, v6kTt25SaleId } from '../server/services/v6kTt25Catalog';
import { V6K_TT25_PRODUCTS, v6kTt25Limits } from '../shared/v6kTt25';
import { existingModelLimits } from '../server/services/modelInputPresets';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function database() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE models(id INTEGER PRIMARY KEY,provider TEXT,model_id TEXT UNIQUE,display_name TEXT,description TEXT,capabilities TEXT,is_active INTEGER);
    CREATE TABLE model_pricing(id INTEGER PRIMARY KEY,model_pattern TEXT,billing_type TEXT,input_price REAL,output_price REAL,extra_params TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE contents(id INTEGER,status TEXT,cost REAL,metadata TEXT);
    CREATE TABLE users(id INTEGER,balance REAL);
    CREATE TABLE user_model_access(user_id INTEGER,model_id INTEGER,access_mode TEXT);
    INSERT INTO users VALUES(1,93.5);
    INSERT INTO contents VALUES(123,'processing',6.5,'{"videoId":"original","pricingSnapshot":{"billingType":"per_call","inputPrice":6.5}}');`);
  return db;
}
function specs(db: Database.Database): any[] {
  return JSON.parse((db.prepare("SELECT value FROM settings WHERE key='model_specification_routes_v1'").get() as any).value);
}

describe('TT 2.5 requested per-second sale configuration', () => {
  it('keeps an enabled legacy product usable on its previously mapped channel without requiring a new sync',()=>{
    const db=database(),id='ZH-TTseadanco2.5-480';
    db.exec('CREATE TABLE channels(id INTEGER,type TEXT,supported_models TEXT,model_mapping TEXT)');
    db.prepare('INSERT INTO models(provider,model_id,display_name,capabilities,is_active) VALUES(?,?,?,?,?)').run('zongheng-v6k',id,'legacy','["video"]',1);
    db.prepare('INSERT INTO channels VALUES(?,?,?,?)').run(21,'zongheng-v6k',JSON.stringify([id]),JSON.stringify({[id]:'TTseadanco2.5-480'}));
    db.prepare('INSERT INTO channels VALUES(?,?,?,?)').run(22,'openai',JSON.stringify([id]),JSON.stringify({[id]:'TTseadanco2.5-480'}));
    ensureV6kTt25Models(db);
    expect(specs(db).find(s=>s.modelId===id)).toMatchObject({enabled:true,routes:[{channelId:21,executionModel:id,upstreamModel:'TTseadanco2.5-480',enabled:true,costUnit:'per_second'}]});
    expect(specs(db).find(s=>s.modelId==='TTseadanco2.5-720').routes).toEqual([]);
  });
  it('registers three independent raw IDs at .28/.4/.9 per second and preserves later administrator changes', () => {
    const db=database();ensureV6kTt25Models(db);
    for(const product of V6K_TT25_PRODUCTS){
      expect(db.prepare('SELECT * FROM models WHERE model_id=?').get(product.id)).toMatchObject({model_id:product.id,is_active:0});
      expect(db.prepare('SELECT * FROM model_pricing WHERE model_pattern=?').get(product.id)).toMatchObject({billing_type:'per_second',input_price:product.saleRate});
      expect(specs(db).find(s=>s.modelId===product.id)).toMatchObject({enabled:false,limits:{maxImages:30,maxVideos:10,maxAudios:10,resolutions:[product.resolution],duration:{min:5,max:30,step:1}},routes:[]});
      expect(existingModelLimits(product.id,'video')).toEqual(v6kTt25Limits(product.id));
    }
    db.exec('UPDATE models SET is_active=1; UPDATE model_pricing SET input_price=7.7,extra_params=\'{}\'');
    const custom=specs(db);custom[0].enabled=true;custom[0].limits.maxImages=20;
    db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(custom),'model_specification_routes_v1');
    ensureV6kTt25Models(db);
    expect(specs(db)).toEqual(custom);
    expect(db.prepare('SELECT DISTINCT input_price FROM model_pricing').all()).toEqual([{input_price:7.7}]);
    expect(db.prepare('SELECT DISTINCT is_active FROM models').all()).toEqual([{is_active:1}]);
  });
  it('updates the explicitly requested legacy product prices once without renaming IDs, permissions, switches or accepted-task snapshots',()=>{
    const db=database();
    const insert=db.prepare('INSERT INTO models VALUES(?,?,?,?,?,?,?)');
    for(const [index,product] of V6K_TT25_PRODUCTS.entries()){
      insert.run(index+1,'zongheng-v6k','ZH-'+product.id,'custom '+index,'custom description','["video"]',1);
      db.prepare('INSERT INTO model_pricing VALUES(?,?,?,?,?,?)').run(index+1,'ZH-'+product.id,'per_call',6.5,0,JSON.stringify({[product.resolution.toUpperCase()]:8,category:'video'}));
      db.prepare('INSERT INTO user_model_access VALUES(?,?,?)').run(1,index+1,'allow');
    }
    const models=db.prepare('SELECT * FROM models').all(),access=db.prepare('SELECT * FROM user_model_access').all(),task=db.prepare('SELECT * FROM contents').get();
    ensureV6kTt25Models(db);
    expect(db.prepare('SELECT * FROM models').all()).toEqual(models);
    expect(db.prepare('SELECT * FROM user_model_access').all()).toEqual(access);
    expect(db.prepare('SELECT * FROM contents').get()).toEqual(task);
    expect(db.prepare('SELECT balance FROM users').get()).toEqual({balance:93.5});
    const applied=JSON.parse((db.prepare('SELECT value FROM settings WHERE key=?').get('v6k_tt25_requested_second_prices_v1') as any).value);
    for(const product of V6K_TT25_PRODUCTS){
      const id='ZH-'+product.id;expect(v6kTt25SaleId(db,product.id)).toBe(id);
      const price=db.prepare('SELECT * FROM model_pricing WHERE model_pattern=?').get(id) as any;
      expect(price).toMatchObject({billing_type:'per_second',input_price:product.saleRate});
      expect(JSON.parse(price.extra_params)).toMatchObject({[product.resolution]:product.saleRate,[product.resolution.toUpperCase()]:product.saleRate,category:'video'});
      expect(applied[product.id].previousPrices[0]).toMatchObject({billing_type:'per_call',input_price:6.5});
      expect(specs(db).find(s=>s.modelId===id).enabled).toBe(true);
    }
  });
  it('binds only authorized native resolutions and preserves existing route IDs, costs, switches and other channels',()=>{
    const db=database();ensureV6kTt25Models(db);
    bindV6kTt25Routes(db,21,V6K_TT25_PRODUCTS.map(p=>p.id));
    const saved=specs(db);saved[0].routes[0].enabled=false;saved[0].routes[0].cost=2;
    saved[0].routes.push({...saved[0].routes[0],id:'existing-queued-route',priority:1});
    db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(saved),'model_specification_routes_v1');
    bindV6kTt25Routes(db,21,[V6K_TT25_PRODUCTS[0].id]);
    expect(specs(db)[0].routes).toEqual(saved[0].routes);
    expect(specs(db)[1].routes).toEqual([]);expect(specs(db)[2].routes).toEqual([]);
    bindV6kTt25Routes(db,22,[V6K_TT25_PRODUCTS[0].id]);bindV6kTt25Routes(db,21,[]);
    expect(specs(db)[0].routes.map((r:any)=>r.channelId)).toEqual([22]);
    expect(specs(db)[0].routes[0]).toMatchObject({cost:.21,costUnit:'per_second',limits:{resolutions:['480p']}});
  });
  it('does not touch unrelated products, fixed-price TTT or A/XX models and rolls back namespace conflicts',()=>{
    const db=database();
    for(const id of ['TTTseadanco2.5/720','zh-seedance.2.0','XXsedanco2.0']){
      db.prepare('INSERT INTO models(provider,model_id,display_name,description,capabilities,is_active) VALUES(?,?,?,?,?,?)').run('zongheng-v6k',id,id,'original','["video"]',1);
      db.prepare('INSERT INTO model_pricing(model_pattern,billing_type,input_price,output_price,extra_params) VALUES(?,?,?,?,?)').run(id,'per_call',id.startsWith('TTT')?6.5:4,0,'{}');
    }
    const models=db.prepare('SELECT * FROM models').all(),prices=db.prepare('SELECT * FROM model_pricing').all();
    db.prepare('INSERT INTO models(provider,model_id,display_name,capabilities,is_active) VALUES(?,?,?,?,?)').run('another',V6K_TT25_PRODUCTS[1].id,'occupied','["video"]',1);
    expect(()=>ensureV6kTt25Models(db)).toThrow('已被其他产品占用');
    expect(db.prepare('SELECT * FROM models WHERE model_id<>?').all(V6K_TT25_PRODUCTS[1].id)).toEqual(models);
    expect(db.prepare('SELECT * FROM model_pricing').all()).toEqual(prices);
    expect(db.prepare('SELECT * FROM settings').all()).toEqual([]);
  });
});
