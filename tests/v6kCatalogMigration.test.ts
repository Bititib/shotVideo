import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrateV6kCatalog } from '../server/services/v6kCatalogMigration';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE models(id INTEGER PRIMARY KEY AUTOINCREMENT, model_id TEXT, provider TEXT, is_active INTEGER);
    CREATE TABLE model_pricing(id INTEGER PRIMARY KEY, model_pattern TEXT, input_price REAL);
    CREATE TABLE channels(id INTEGER PRIMARY KEY, type TEXT, supported_models TEXT, model_mapping TEXT);
    CREATE TABLE contents(id INTEGER PRIMARY KEY,model_id TEXT,status TEXT,cost REAL,metadata TEXT,result_url TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY,balance REAL);
    CREATE TABLE user_model_pricing(id INTEGER PRIMARY KEY,model_id INTEGER,input_price REAL);
    CREATE TABLE settings(id INTEGER PRIMARY KEY,key TEXT,value TEXT);
    INSERT INTO models VALUES(1,'ZH-TTsedanco2.5-480','zongheng',1),
      (2,'ZH-QQsedanco2.5/720','zongheng-v6k',1),(3,'ZH-TTseadanco2.5-480YT','zongheng-v6k',1),
      (4,'other-video','huss',1),(5,'ZH-TTseadanco2.5-720','zongheng',1);
    INSERT INTO model_pricing VALUES(1,'ZH-TTsedanco2.5-480',10.5),(2,'ZH-QQsedanco2.5/720',5),
      (3,'ZH-TTseadanco2.5-480YT',7),(4,'other-video',3),(5,'ZH-*',2),(6,'ZH-TTseadanco2.5-720',8);
    INSERT INTO channels VALUES(21,'zongheng-v6k','["ZH-TTsedanco2.5-480","ZH-QQsedanco2.5/720","ZH-TTseadanco2.5-480YT","*"]',
      '{"ZH-TTsedanco2.5-480":"TTsedanco2.5-480","ZH-QQsedanco2.5/720":"QQsedanco2.5/720","ZH-TTseadanco2.5-480YT":"TTseadanco2.5-480YT"}'),
      (22,'huss','["other-video"]','{"other-video":"other-upstream"}');
    INSERT INTO contents VALUES(1,'ZH-QQsedanco2.5/720','completed',5,'{}','/uploads/result.mp4'),
      (2,'ZH-TTsedanco2.5-480','failed',0,'{"billingStatus":"refunded"}',NULL),
      (3,'ZH-TTseadanco2.5-480YT','processing',7,'{"zonghengProtocol":"v6k","videoId":"accepted"}',NULL);
    INSERT INTO users VALUES(1,88);
    INSERT INTO user_model_pricing VALUES(1,1,3),(2,3,6);
    INSERT INTO settings VALUES(1,'public_model_name_aliases_v1','{"old name":1,"new name":3,"other name":4}');`);
  return db;
}
describe('new-site catalog cleanup', () => {
  it('archives and removes old model entries, prices, mappings and per-user overrides without touching money or tasks', () => {
    const db = fixture();
    try {
      const tasks = db.prepare('SELECT * FROM contents').all();
      expect(migrateV6kCatalog(db)).toEqual({ removedModels: 3, removedPrices: 4 });
      expect(db.prepare('SELECT model_id FROM models ORDER BY id').all()).toEqual([{ model_id: 'ZH-TTseadanco2.5-480YT' }, { model_id: 'other-video' }]);
      expect(db.prepare('SELECT model_pattern FROM model_pricing ORDER BY id').all()).toEqual([{ model_pattern: 'ZH-TTseadanco2.5-480YT' }, { model_pattern: 'other-video' }]);
      expect(db.prepare('SELECT supported_models,model_mapping FROM channels WHERE id=21').get()).toEqual({
        supported_models: '["ZH-TTseadanco2.5-480YT"]', model_mapping: '{"ZH-TTseadanco2.5-480YT":"TTseadanco2.5-480YT"}' });
      expect(db.prepare('SELECT supported_models FROM channels WHERE id=22').get()).toEqual({ supported_models: '["other-video"]' });
      expect(db.prepare('SELECT * FROM contents').all()).toEqual(tasks);
      expect(db.prepare('SELECT balance FROM users').get()).toEqual({ balance: 88 });
      expect(db.prepare('SELECT model_id FROM user_model_pricing').all()).toEqual([{ model_id: 3 }]);
      expect(JSON.parse((db.prepare('SELECT value FROM settings').get() as any).value)).toEqual({ 'new name': 3, 'other name': 4 });
      expect(JSON.parse((db.prepare("SELECT payload FROM v6k_retired_configuration WHERE kind='models' AND source_id=1").get() as any).payload)).toMatchObject({ model_id: 'ZH-TTsedanco2.5-480', is_active: 1 });
      // A same-ID model resynchronized from the new site must survive every subsequent restart.
      db.prepare('INSERT INTO models VALUES(6,?,?,1)').run('ZH-TTseadanco2.5-720', 'zongheng-v6k');
      expect(migrateV6kCatalog(db)).toEqual({ removedModels: 0, removedPrices: 0 });
      expect(db.prepare('SELECT id FROM models WHERE id=6').get()).toEqual({ id: 6 });
    } finally { db.close(); }
  });
  it('rolls back the entire cleanup if a configuration write fails', () => {
    const db = fixture();
    try {
      db.exec("CREATE TRIGGER refuse_cleanup BEFORE DELETE ON models BEGIN SELECT RAISE(ABORT,'storage failure'); END");
      expect(() => migrateV6kCatalog(db)).toThrow('storage failure');
      expect(db.prepare('SELECT count(*) AS n FROM model_pricing').get()).toEqual({ n: 6 });
      expect(db.prepare('SELECT count(*) AS n FROM models').get()).toEqual({ n: 5 });
    } finally { db.close(); }
  });
  it('removes old sales routes and aliases without changing routes for other channels', () => {
    const db = fixture();
    try {
      db.prepare('INSERT INTO settings VALUES(2,?,?)').run('model_specification_routes_v1', JSON.stringify([
        { modelId: 'ZH-QQsedanco2.5/720', aliases: [], routes: [] },
        { modelId: 'public-video', aliases: ['ZH-QQsedanco2.5/720', 'other-video'], routes: [
          { id: 'old', channelId: 21, executionModel: 'ZH-QQsedanco2.5/720', upstreamModel: 'QQsedanco2.5/720' },
          { id: 'new', channelId: 21, executionModel: 'ZH-TTseadanco2.5-480YT', upstreamModel: 'TTseadanco2.5-480YT' },
          { id: 'other', channelId: 22, executionModel: 'other-video', upstreamModel: 'other-upstream' },
        ] },
      ]));
      migrateV6kCatalog(db);
      const routes = JSON.parse((db.prepare('SELECT value FROM settings WHERE id=2').get() as any).value);
      expect(routes).toHaveLength(1);
      expect(routes[0].aliases).toEqual(['other-video']);
      expect(routes[0].routes.map((route: any) => route.id)).toEqual(['new', 'other']);
    } finally { db.close(); }
  });
});
