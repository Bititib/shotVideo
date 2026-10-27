import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE models(id INTEGER PRIMARY KEY AUTOINCREMENT,provider TEXT,model_id TEXT UNIQUE,display_name TEXT,
    description TEXT,api_key TEXT,capabilities TEXT,is_active INTEGER,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE channels(id INTEGER PRIMARY KEY,type TEXT,base_url TEXT,api_key TEXT,supported_models TEXT,model_mapping TEXT,updated_at TEXT);
    CREATE TABLE model_pricing(id INTEGER PRIMARY KEY,model_pattern TEXT,input_price REAL);`);
  return { sqlite, db: drizzle(sqlite) };
});
import { sqlite } from '../server/db/index';
import { syncV6kVideoModels } from '../server/services/v6kCatalogService';
const channel = { id: 21, baseUrl: 'https://www.v6k.top', apiKey: 'private-key', timeout: 1000 };
beforeEach(() => {
  sqlite.exec(`DELETE FROM models; DELETE FROM model_pricing; DELETE FROM channels;
    INSERT INTO channels VALUES(21,'zongheng-v6k','https://www.v6k.top','private-key','["old"]','{"old":"retired"}',NULL);`);
});
afterEach(() => vi.unstubAllGlobals());
describe('V6K authenticated model synchronization', () => {
  it('keeps the new TTT ID unprefixed and mapped exactly without granting unauthorized models', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: any) => String(url).endsWith('/v1/models')
      ? Response.json({ data: ['TTTseadanco2.5/720'] }) : Response.json({ data: [] })));
    expect(await syncV6kVideoModels(channel)).toMatchObject({ models: ['TTTseadanco2.5/720'], added: 1 });
    expect(sqlite.prepare('SELECT model_id,is_active,description FROM models').get()).toEqual({ model_id: 'TTTseadanco2.5/720', is_active: 0, description: '30图10音10视/720P/5-30秒/全天稳定10分钟出片' });
    expect(JSON.parse((sqlite.prepare('SELECT model_mapping FROM channels').get() as any).model_mapping)).toEqual({ 'TTTseadanco2.5/720': 'TTTseadanco2.5/720' });
  });
  it('imports exact authorized video IDs, classifies opaque names from the public square and never copies upstream prices', async () => {
    const fetcher = vi.fn(async (url: any, options: any) => {
      if (String(url).endsWith('/v1/models')) {
        expect(options.headers.Authorization).toBe('Bearer private-key');
        return Response.json({ data: [{ id: 'TTseadanco 2.0 Fast/480' }, { id: 'opaque-video' }, { id: 'gpt-text' }, { id: 'opaque-video' }] });
      }
      expect(String(url)).toBe('https://www.v6k.top/api/pricing');
      expect(options.headers).toBeUndefined();
      return Response.json({ data: [
        { model_name: 'opaque-video', supported_endpoint_types: ['openai-video'], model_price: 0.5 },
        { model_name: 'unauthorized-video', supported_endpoint_types: ['openai-video'] },
        { model_name: 'gpt-text', display_category: 'text' }] });
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await syncV6kVideoModels(channel)).toMatchObject({ count: 2, added: 2, models: ['ZH-TTseadanco 2.0 Fast/480', 'ZH-opaque-video'] });
    expect(sqlite.prepare('SELECT model_id,is_active,provider FROM models ORDER BY id').all()).toEqual([
      { model_id: 'ZH-TTseadanco 2.0 Fast/480', is_active: 0, provider: 'zongheng-v6k' },
      { model_id: 'ZH-opaque-video', is_active: 0, provider: 'zongheng-v6k' }]);
    expect(sqlite.prepare('SELECT count(*) AS n FROM model_pricing').get()).toEqual({ n: 0 });
    expect(JSON.parse((sqlite.prepare('SELECT model_mapping FROM channels').get() as any).model_mapping)).toEqual({
      'ZH-TTseadanco 2.0 Fast/480': 'TTseadanco 2.0 Fast/480', 'ZH-opaque-video': 'opaque-video' });
  });
  it('preserves existing new-site prices and activation when the public square is unavailable', async () => {
    sqlite.exec(`INSERT INTO models(provider,model_id,display_name,is_active) VALUES('zongheng-v6k','ZH-TTseadanco2.5-480','我的模型',1);
      INSERT INTO model_pricing VALUES(1,'ZH-TTseadanco2.5-480',7);`);
    vi.stubGlobal('fetch', vi.fn(async (url: any) => String(url).endsWith('/v1/models')
      ? Response.json({ data: ['TTseadanco2.5-480'] }) : new Response('', { status: 503 })));
    expect(await syncV6kVideoModels(channel)).toMatchObject({ count: 1, added: 0 });
    expect(sqlite.prepare('SELECT display_name,is_active FROM models').get()).toEqual({ display_name: '我的模型', is_active: 1 });
    expect(sqlite.prepare('SELECT input_price FROM model_pricing').get()).toEqual({ input_price: 7 });
  });
  it.each([Response.json({ error: 'bad key' }, { status: 401 }), Response.json({ success: true })])('keeps configuration intact on an invalid authenticated response', async response => {
    vi.stubGlobal('fetch', vi.fn(async () => response.clone()));
    await expect(syncV6kVideoModels(channel)).rejects.toBeDefined();
    expect(sqlite.prepare('SELECT supported_models FROM channels').get()).toEqual({ supported_models: '["old"]' });
    expect(sqlite.prepare('SELECT count(*) AS n FROM models').get()).toEqual({ n: 0 });
  });
});
