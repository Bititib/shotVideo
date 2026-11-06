import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryDatabase } from './helpers/memoryDatabase.js';
import { ensureSiYueTianMinimaxModel, ensureSiYueTianVideoModelsOnStartup, SiYueTianCatalogConflictError } from '../server/services/siYueTianMinimaxCatalog.js';
import { SI_YUE_TIAN_SEEDANCE_C4_MODEL as C4, SI_YUE_TIAN_SEEDANCE_C5_MODEL as C5 } from '../shared/siYueTianManagedVideo.js';

let database: ReturnType<typeof createMemoryDatabase>;
beforeEach(() => { database = createMemoryDatabase(); });
afterEach(() => { database.sqlite.close(); vi.restoreAllMocks(); });
const catalogSnapshot = () => Object.fromEntries(['models', 'model_pricing', 'channels', 'settings'].map(table =>
  [table, database.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

describe('Siyuetian optional startup catalog transactions', () => {
  it('rolls back every C4 write when a later channel has an operator mapping, and still completes startup registration', () => {
    const { sqlite } = database;
    const add = sqlite.prepare(`INSERT INTO channels(name,type,base_url,api_key,supported_models,model_mapping)
      VALUES(?,'openai',?,'test-only-key','[]',?)`);
    add.run('first', 'https://llm.chre3.com', '{}');
    add.run('second', 'https://llm.domie.studio', JSON.stringify({ [C4]: 'operator-upstream' }));
    ensureSiYueTianMinimaxModel(sqlite);
    ensureSiYueTianMinimaxModel(sqlite, undefined, C5);
    const before = catalogSnapshot();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => ensureSiYueTianVideoModelsOnStartup(sqlite)).not.toThrow();
    expect(catalogSnapshot()).toEqual(before);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(`${C4} 的现有映射不同`));
    expect(() => ensureSiYueTianMinimaxModel(sqlite, undefined, C4)).toThrow(SiYueTianCatalogConflictError);
    expect(catalogSnapshot()).toEqual(before);
  });

  it('does not hide malformed specification data as an ownership conflict', () => {
    const { sqlite } = database;
    sqlite.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('model_specification_routes_v1', '{broken');
    const before = catalogSnapshot();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => ensureSiYueTianVideoModelsOnStartup(sqlite)).toThrow(SyntaxError);
    expect(catalogSnapshot()).toEqual(before);
    expect(warning).not.toHaveBeenCalled();
  });

  it('does not suppress a database error even when its text resembles a product conflict', () => {
    const { sqlite } = database;
    sqlite.exec(`CREATE TRIGGER reject_catalog_insert BEFORE INSERT ON models
      BEGIN SELECT RAISE(ABORT, '已被其他产品占用，未修改原配置'); END`);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => ensureSiYueTianVideoModelsOnStartup(sqlite)).toThrow('已被其他产品占用');
    expect(warning).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM models').get()).toEqual({ count: 0 });
  });
});
