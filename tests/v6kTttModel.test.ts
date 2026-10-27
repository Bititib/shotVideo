import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ensureV6kTttModel } from '../server/services/v6kTttModel';
import { V6K_TTT_720_MODEL, V6K_TTT_720_DESCRIPTION, getZonghengVideoSpec } from '../shared/zonghengVideo';
import { existingModelLimits } from '../server/services/modelInputPresets';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function database() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE models(provider TEXT, model_id TEXT UNIQUE, display_name TEXT, description TEXT, capabilities TEXT, is_active INTEGER);
    CREATE TABLE model_pricing(model_pattern TEXT, billing_type TEXT, input_price REAL, output_price REAL, extra_params TEXT);`);
  return db;
}
describe('requested TTT V6K product', () => {
  it('registers an exact unprefixed ID, disabled until authorized channel sync, at 6.5 per call', () => {
    const db = database();
    expect(ensureV6kTttModel(db)).toEqual({ addedModel: 1, addedPrice: 1 });
    expect(db.prepare('SELECT * FROM models').get()).toMatchObject({ model_id: V6K_TTT_720_MODEL, description: V6K_TTT_720_DESCRIPTION, is_active: 0 });
    expect(db.prepare('SELECT * FROM model_pricing').get()).toMatchObject({ model_pattern: V6K_TTT_720_MODEL, billing_type: 'per_call', input_price: 6.5 });
    expect(ensureV6kTttModel(db)).toEqual({ addedModel: 0, addedPrice: 0 });
    db.exec('UPDATE models SET is_active=1; UPDATE model_pricing SET input_price=8.8');
    ensureV6kTttModel(db);
    expect(db.prepare('SELECT is_active FROM models').get()).toEqual({ is_active: 1 });
    expect(db.prepare('SELECT input_price FROM model_pricing').get()).toEqual({ input_price: 8.8 });
  });
  it('uses the user-confirmed 720p/30-image/10-video/10-audio specification consistently', () => {
    expect(getZonghengVideoSpec(V6K_TTT_720_MODEL)).toMatchObject({ resolution: '720p', references: { images: 30, videos: 10, audios: 10 } });
    expect(existingModelLimits(V6K_TTT_720_MODEL, 'video')).toMatchObject({ resolutions: ['720p'], maxImages: 30, maxVideos: 10, maxAudios: 10, duration: { min: 5, max: 30 } });
  });
  it('corrects existing default descriptions and this product\'s saved route limits without touching prices, switches or historical tasks', () => {
    const db = database(); ensureV6kTttModel(db);
    const oldDescription = '30图10音10视/480P/5-30秒/全天稳定10分钟出片';
    db.prepare('UPDATE models SET description=?,is_active=1').run(oldDescription);
    db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE contents(id INTEGER,status TEXT,cost REAL,metadata TEXT)');
    db.prepare('INSERT INTO contents VALUES(14555,?,?,?)').run('failed',0,JSON.stringify({ model: V6K_TTT_720_MODEL, resolution: '480p', billingStatus: 'refunded' }));
    const historical = db.prepare('SELECT * FROM contents').get();
    const other = { modelId: 'other-model', kind: 'video', limits: { resolutions: ['480p'] }, routes: [] };
    const target = { modelId: V6K_TTT_720_MODEL, kind: 'video', enabled: false, limits: { resolutions: ['480P'] },
      routes: [{ upstreamModel: V6K_TTT_720_MODEL, enabled: false, cost: 3, limits: { resolutions: ['480p'] } },
        { upstreamModel: 'other-upstream', limits: { resolutions: ['480p'] } }] };
    db.prepare('INSERT INTO settings VALUES(?,?)').run('model_specification_routes_v1',JSON.stringify([target,other]));
    ensureV6kTttModel(db);
    expect(db.prepare('SELECT description,is_active FROM models').get()).toEqual({ description: V6K_TTT_720_DESCRIPTION, is_active: 1 });
    expect(db.prepare('SELECT billing_type,input_price FROM model_pricing').get()).toEqual({ billing_type: 'per_call', input_price: 6.5 });
    const saved = (db.prepare('SELECT value FROM settings').get() as {value:string}).value;
    expect(JSON.parse(saved)).toEqual([{ ...target, limits: { resolutions: ['720p'] }, routes: [
      { ...target.routes[0], limits: { resolutions: ['720p'] } }, target.routes[1]] },other]);
    expect(db.prepare('SELECT * FROM contents').get()).toEqual(historical);
    ensureV6kTttModel(db);
    expect((db.prepare('SELECT value FROM settings').get() as {value:string}).value).toBe(saved);
  });
});
