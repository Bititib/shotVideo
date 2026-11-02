import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { removeTtBbFallbacks } from '../server/db/removeTtBbFallbacks.js';

describe('withdraw TT BB fallback configuration without touching accepted jobs', () => {
  it('removes only TT V6K BB routes and their discovery snapshot, once, preserving prices, switches and receipts', () => {
    const d = new Database(':memory:');
    try {
      d.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE channels(id INTEGER,type TEXT);
        CREATE TABLE contents(id INTEGER,status TEXT,cost REAL,metadata TEXT); CREATE TABLE users(id INTEGER,balance REAL);
        CREATE TABLE billing_reservations(id TEXT,state TEXT,amount REAL); CREATE TABLE model_pricing(id TEXT,input_price REAL);
        INSERT INTO channels VALUES(21,'zongheng-v6k'),(22,'huss'); INSERT INTO users VALUES(1,96);
        INSERT INTO contents VALUES(1,'processing',4,'{"videoId":"accepted_bb","upstreamModel":"BBseadanco-720","channelId":21}');
        INSERT INTO billing_reservations VALUES('original','reserved',4); INSERT INTO model_pricing VALUES('TTseadanco2.5-720',0.4);`);
      const primary = { id: 'original', channelId: 21, upstreamModel: 'TTseadanco2.5-720', enabled: false, cost: .31 };
      const unrelated = { id: 'huss-existing', channelId: 22, upstreamModel: 'BBseadanco-720', enabled: true };
      const specs = [{ modelId: 'ZH-TTseadanco2.5-720', enabled: true, routes: [primary,
        { id: 'v6k-tt-bb-21-720p', channelId: 21, upstreamModel: 'BBseadanco-720', enabled: true }, unrelated] },
        { modelId: 'TTseadanco2.5-480', enabled: false, routes: [{ id: 'v6k-tt-bb-99-480p', channelId: 99, upstreamModel: 'BBseadanco-480' }] }];
      d.prepare('INSERT INTO settings VALUES(?,?)').run('model_specification_routes_v1', JSON.stringify(specs));
      d.prepare('INSERT INTO settings VALUES(?,?)').run('v6k_tt_bb_catalog_v1', '{}');
      const snapshot = () => JSON.stringify(['channels','contents','users','billing_reservations','model_pricing'].map(t => d.prepare(`SELECT * FROM ${t}`).all()));
      const before = snapshot();
      expect(removeTtBbFallbacks(d)).toBe(2); expect(removeTtBbFallbacks(d)).toBe(0);
      const saved = JSON.parse((d.prepare('SELECT value FROM settings WHERE key=?').get('model_specification_routes_v1') as any).value);
      expect(saved).toEqual([{...specs[0],routes:[primary,unrelated]},{...specs[1],routes:[]}]);
      expect(snapshot()).toBe(before);
      expect(d.prepare('SELECT * FROM settings WHERE key=?').get('v6k_tt_bb_catalog_v1')).toBeUndefined();
    } finally { d.close(); }
  });
});
