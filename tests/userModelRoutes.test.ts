import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
import { db, sqlite } from '../server/db/index.js';
import { users, models, tiers, modelPricing, apiTokens, settings } from '../server/db/schema.js';
import { ensureUserModelTables } from '../server/db/userModelMigration.js';
import { env } from '../server/config/env.js';
import { ChannelService } from '../server/services/channelService.js';
import { TokenService } from '../server/services/tokenService.js';
import adminRouter from '../server/routes/admin.js';
import apiRouter from '../server/routes/v1.js';
import { UserModelSettingsService } from '../server/services/userModelSettingsService.js';

let server: Server, base: string;
let keys: string[];
const payload = { accessMode: 'allow', pricingMode: 'custom', customPrice: { billingType: 'per_call', inputPrice: .2, outputPrice: 0, extraParams: { '4K': .3 } } };
const session = (id: number) => ({ Authorization: `Bearer ${jwt.sign({ userId: id }, env.JWT_SECRET)}`, 'Content-Type': 'application/json' });
const nativeFetch = globalThis.fetch;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/api/admin', adminRouter); app.use('/v1', apiRouter);
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status || 500).json({ error: error.message }));
  server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
beforeEach(() => {
  vi.unstubAllGlobals();
  ensureUserModelTables(sqlite); vi.restoreAllMocks();
  sqlite.exec('DELETE FROM user_model_access; DELETE FROM user_model_pricing; DELETE FROM user_model_audit;');
  for (const table of [users, models, tiers, modelPricing, apiTokens, settings]) db.delete(table).run();
  db.insert(tiers).values({ id: 1, name: 'free', displayName: '免费', allowedFeatures: '["generate_image"]' }).run();
  for (const id of [1, 2, 3]) db.insert(users).values({ id, email: `${id}@test.invalid`, username: `${id}`, passwordHash: 'test', tierId: 1, balance: 100, role: id === 3 ? 'super_admin' : 'user' }).run();
  db.insert(models).values({ id: 20, modelId: 'gpt-image-2', displayName: 'GPT Image', capabilities: '["image"]' }).run();
  db.insert(modelPricing).values({ modelPattern: 'gpt-image-2', billingType: 'per_call', inputPrice: .5, extraParams: '{"4K":0.8}' }).run();
  keys = [1, 2, undefined].map(userId => TokenService.createToken({ userId, balance: 100 }).tokenKey);
  vi.spyOn(ChannelService, 'getActiveChannels').mockReturnValue([{ id: 1, type: 'openai', apiKey: 'test-only', supportedModels: ['*'], modelMapping: {}, priority: 0 }] as any);
});
afterAll(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); sqlite.close(); });

describe('user model administration and API ownership', () => {
  it('requires administrator authorization for both reads and writes', async () => {
    const url = `${base}/api/admin/users/1/models`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: session(1) })).status).toBe(403);
    expect((await fetch(url + '/20', { method: 'PUT', headers: session(1), body: JSON.stringify(payload) })).status).toBe(403);
    expect((await fetch(url, { method: 'PUT', headers: session(1), body: JSON.stringify({ changes: [{ ...payload, modelId: 20 }] }) })).status).toBe(403);
    expect((await fetch(url, { headers: session(3) })).status).toBe(200);
    expect(sqlite.prepare('SELECT * FROM user_model_pricing').all()).toHaveLength(0);
  });
  it('saves table edits through the administrator batch endpoint', async () => {
    const response = await fetch(`${base}/api/admin/users/1/models`, { method: 'PUT', headers: session(3), body: JSON.stringify({ changes: [{ ...payload, modelId: 20, userId: 2, actorId: 1 }] }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject([{ id: 20, effectivePrice: { inputPrice: .2 } }]);
    expect(sqlite.prepare('SELECT user_id,actor_id FROM user_model_audit').get()).toEqual({ user_id: 1, actor_id: 3 });
  });
  it('saves the target user and logs the authenticated administrator', async () => {
    const response = await fetch(`${base}/api/admin/users/1/models/20`, { method: 'PUT', headers: session(3), body: JSON.stringify({ ...payload, userId: 2, actorId: 1 }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ effectivePrice: { inputPrice: .2 }, accessMode: 'allow' });
    expect(sqlite.prepare('SELECT user_id,actor_id FROM user_model_audit').get()).toEqual({ user_id: 1, actor_id: 3 });
  });
  it('returns prices for the Key owner and keeps system Keys on global prices', async () => {
    UserModelSettingsService.save(1, 20, 3, payload);
    for (const [index, expected] of [[0, .2], [1, .5], [2, .5]]) {
      const response = await fetch(`${base}/v1/pricing/gpt-image-2`, { headers: { Authorization: `Bearer ${keys[index]}` } });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toMatchObject({ unit_price: expected });
    }
  });
  it('applies user denials to discovery and direct generation even with an unrestricted Key', async () => {
    UserModelSettingsService.save(1, 20, 3, { accessMode: 'deny', pricingMode: 'inherit' });
    const headers = { Authorization: `Bearer ${keys[0]}`, 'Content-Type': 'application/json' };
    expect((await fetch(`${base}/v1/pricing/gpt-image-2`, { headers })).status).toBe(404);
    const list = await fetch(`${base}/v1/models`, { headers }); expect((await list.json()).data).toEqual([]);
    const result = await fetch(`${base}/v1/images/generations`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-image-2', prompt: 'test' }) });
    expect(result.status).toBe(403);
  });
  it('keeps a restricted Key narrower than a user allow override', async () => {
    UserModelSettingsService.save(1, 20, 3, payload);
    const token = TokenService.findByKey(keys[0])!;
    TokenService.updateToken(token.id, { allowedModels: ['another-model'] });
    const response = await fetch(`${base}/v1/pricing/gpt-image-2`, { headers: { Authorization: `Bearer ${keys[0]}` } });
    expect(response.status).toBe(404);
  });
  it.each([.3, .0003, 0])('charges and refunds partial image results at the owner’s exact price (%s)', async unitPrice => {
    UserModelSettingsService.save(1, 20, 3, { ...payload, customPrice: { ...payload.customPrice, inputPrice: unitPrice, extraParams: { '4K': unitPrice } } });
    const channel = { id: 1, type: 'openai', apiKey: 'test-only', baseUrl: 'https://user-price.invalid', supportedModels: ['*'], modelMapping: {}, timeout: 1000 };
    vi.spyOn(ChannelService, 'findChannelForModel').mockReturnValue(channel as any);
    vi.spyOn(ChannelService, 'findChannelsForModel').mockReturnValue([channel] as any);
    vi.stubGlobal('fetch', vi.fn(async (url: any, options: any) => String(url).startsWith('https://user-price.invalid')
      ? Response.json({ data: [{ url: 'https://images.invalid/test.png' }] }) : nativeFetch(url, options)));
    const response = await fetch(`${base}/v1/images/generations`, { method: 'POST', headers: { Authorization: `Bearer ${keys[0]}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'test', n: 2, resolution: '4K' }) });
    expect(response.status).toBe(200);
    expect(TokenService.findByKey(keys[0])!.balance).toBeCloseTo(100 - unitPrice, 6);
    const reservation = sqlite.prepare('SELECT amount,actual FROM billing_reservations ORDER BY rowid DESC LIMIT 1').get();
    expect(reservation).toEqual({ amount: unitPrice * 2, actual: unitPrice });
    const asset = sqlite.prepare("SELECT cost,metadata FROM contents WHERE model_id='gpt-image-2' ORDER BY id DESC LIMIT 1").get() as any;
    expect(asset.cost).toBe(unitPrice);
    expect(JSON.parse(asset.metadata).pricingSnapshot).toMatchObject({ source: 'user', usage: { resolution: '4K' } });
  });
});
