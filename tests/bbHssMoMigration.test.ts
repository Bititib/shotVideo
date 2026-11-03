import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
import { db, sqlite } from '../server/db/index.js';
import { channels, contents, models, modelPricing, users } from '../server/db/schema.js';
import { ensureBbHssMoMapping } from '../server/services/bbHssMoMigration.js';
import { ensureBbHssKkMapping } from '../server/services/bbHssKkMigration.js';
import { BB_HSS_KK_ENTRIES } from '../shared/bbHssKk.js';
import { HAYA_MO_MODEL, hayaMoLimits } from '../shared/hayaMoVideo.js';
import { matchesBbHssSource } from '../server/services/bbHssSourcePolicy.js';

beforeEach(() => sqlite.exec('SAVEPOINT mo_migrate'));
afterEach(() => sqlite.exec('ROLLBACK TO mo_migrate; RELEASE mo_migrate'));
afterAll(() => sqlite.close());
const specs = () => JSON.parse((sqlite.prepare('SELECT value FROM settings WHERE key=?').get('model_specification_routes_v1') as any).value);
it('replaces only new routes, preserves prices/identities/keys/accepted jobs, and does not invent Mo permission', () => {
  db.insert(users).values({ id: 1, email: 'mo@test', username: 'mo', passwordHash: 'test', balance: 88 }).run();
  db.insert(channels).values([{ id: 1, name: 'old', type: 'huss', apiKey: 'old-key', supportedModels: JSON.stringify([...BB_HSS_KK_ENTRIES,'mj-v8.2']) },
    { id: 2, name: 'Haya', type: 'haya', apiKey: 'mo-key', baseUrl: 'https://hayaai.cc', supportedModels: '[]' }]).run();
  for (const id of BB_HSS_KK_ENTRIES) {
    db.insert(models).values({ modelId: id, displayName: 'custom ' + id, provider: 'huss', capabilities: '["video"]', isActive: 1 }).run();
    db.insert(modelPricing).values({ modelPattern: id, billingType: 'per_call', inputPrice: 7.3, extraParams: '{"720p":7.3}' }).run();
  }
  db.insert(contents).values({ userId: 1, type: 'video', modelId: BB_HSS_KK_ENTRIES[0], status: 'processing', cost: 7.3,
    metadata: '{"videoId":"original","channelId":1,"upstreamModel":"old"}' }).run();
  const untouched = () => JSON.stringify([db.select().from(modelPricing).all(), db.select().from(contents).all(), db.select().from(users).all(),
    db.select().from(models).all().map(m => [m.id,m.modelId,m.displayName,m.isActive]), db.select().from(channels).all().map(c => [c.id,c.apiKey])]);
  const before = untouched();
  ensureBbHssMoMapping(sqlite); ensureBbHssKkMapping(sqlite, 1);
  expect(untouched()).toBe(before);
  expect(specs().every((s: any) => s.routes.length === 0)).toBe(true);
  ensureBbHssMoMapping(sqlite, 2);
  for (const spec of specs()) {
    expect(spec).toMatchObject({ enabled: true, limits: hayaMoLimits(), routes: [{ channelId: 2, executionModel: spec.modelId, upstreamModel: HAYA_MO_MODEL, cost: 5 }] });
    expect(matchesBbHssSource(sqlite,spec.modelId,spec.routes[0],'haya')).toBe(true);
    expect(matchesBbHssSource(sqlite,spec.modelId,{...spec.routes[0],upstreamModel:'kkseadanco2.5'},'zongheng-v6k')).toBe(false);
  }
  expect(untouched()).toBe(before);
  const changed = specs(); changed[0].enabled = false; changed[0].routes[0].enabled = false; changed[0].limits.maxImages = 8;
  sqlite.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(changed),'model_specification_routes_v1');
  ensureBbHssMoMapping(sqlite,2); ensureBbHssKkMapping(sqlite);
  expect(specs()).toEqual(changed); expect(untouched()).toBe(before);
  expect(JSON.parse(db.select().from(channels).all()[0].supportedModels)).toEqual(['mj-v8.2']);
});
