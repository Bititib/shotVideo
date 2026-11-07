import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
import { sqlite } from '../server/db/index';
import { syncV6kVideoModels } from '../server/services/v6kCatalogService';
const channel = { id: 21, baseUrl: 'https://www.v6k.top', apiKey: 'private-key', timeout: 1000 };
beforeEach(() => {
  sqlite.exec(`DELETE FROM models; DELETE FROM model_pricing; DELETE FROM channels; DELETE FROM settings;
    INSERT INTO channels(id,name,type,base_url,api_key,supported_models,model_mapping)
      VALUES(21,'V6K','zongheng-v6k','https://www.v6k.top','private-key','["old"]','{"old":"retired"}');`);
});
afterEach(() => vi.unstubAllGlobals());
describe('V6K authenticated model synchronization', () => {
  it('keeps the new TTT ID unprefixed and mapped exactly without granting unauthorized models', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: any) => String(url).endsWith('/v1/models')
      ? Response.json({ data: ['TTTseadanco2.5/720'] }) : Response.json({ data: [] })));
    expect(await syncV6kVideoModels(channel)).toMatchObject({ models: ['TTTseadanco2.5/720'], added: 1 });
    expect(sqlite.prepare('SELECT model_id,is_active,description FROM models WHERE model_id=?').get('TTTseadanco2.5/720')).toEqual({ model_id: 'TTTseadanco2.5/720', is_active: 0, description: '30图10音10视/720P/5-30秒/全天稳定10分钟出片' });
    expect(JSON.parse((sqlite.prepare('SELECT model_mapping FROM channels').get() as any).model_mapping)).toEqual({ 'TTTseadanco2.5/720': 'TTTseadanco2.5/720' });
  });
  it('ignores unconfigured models regardless of public-square video metadata and performs only authenticated discovery', async () => {
    const fetcher = vi.fn(async (url: any, options: any) => {
      if (String(url).endsWith('/v1/models')) {
        expect(options.headers.Authorization).toBe('Bearer private-key');
        return Response.json({ data: [{ id: 'TTseadanco 2.0 Fast/480' }, { id: 'opaque-video' }, { id: 'gpt-text' }, { id: 'opaque-video' }] });
      }
      throw new Error('Unexpected public catalog call');
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await syncV6kVideoModels(channel)).toMatchObject({ count: 0, added: 0, models: [] });
    expect(sqlite.prepare('SELECT model_id,is_active,provider FROM models ORDER BY id').all()).toEqual([]);
    expect(sqlite.prepare('SELECT count(*) AS n FROM model_pricing').get()).toEqual({ n: 0 });
    expect(JSON.parse((sqlite.prepare('SELECT model_mapping FROM channels').get() as any).model_mapping)).toEqual({ old: 'retired' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('preserves existing new-site prices and activation when the public square is unavailable', async () => {
    sqlite.exec(`INSERT INTO models(provider,model_id,display_name,is_active,capabilities) VALUES('zongheng-v6k','ZH-TTseadanco2.5-480','我的模型',1,'["video"]');
      INSERT INTO model_pricing(id,model_pattern,input_price) VALUES(1,'ZH-TTseadanco2.5-480',7);`);
    vi.stubGlobal('fetch', vi.fn(async (url: any) => String(url).endsWith('/v1/models')
      ? Response.json({ data: ['TTseadanco2.5-480'] }) : new Response('', { status: 503 })));
    expect(await syncV6kVideoModels(channel)).toMatchObject({ count: 1, added: 0 });
    expect(sqlite.prepare('SELECT display_name,is_active FROM models WHERE model_id=?').get('ZH-TTseadanco2.5-480')).toEqual({ display_name: '我的模型', is_active: 1 });
    expect(sqlite.prepare('SELECT input_price FROM model_pricing WHERE model_pattern=?').get('ZH-TTseadanco2.5-480')).toEqual({ input_price: 7 });
  });
  it.each([Response.json({ error: 'bad key' }, { status: 401 }), Response.json({ success: true })])('keeps configuration intact on an invalid authenticated response', async response => {
    vi.stubGlobal('fetch', vi.fn(async () => response.clone()));
    await expect(syncV6kVideoModels(channel)).rejects.toBeDefined();
    expect(sqlite.prepare('SELECT supported_models FROM channels').get()).toEqual({ supported_models: '["old"]' });
    expect(sqlite.prepare('SELECT count(*) AS n FROM models').get()).toEqual({ n: 0 });
  });
});
