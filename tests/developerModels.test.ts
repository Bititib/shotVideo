import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';

vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/services/hmStudioOverflowChannelService.js', () => ({ hasHmStudioOverflowChannel: () => false }));
import { db, sqlite } from '../server/db/index.js';
import { models, users, apiTokens, modelPricing, settings, contents } from '../server/db/schema.js';
import { ChannelService } from '../server/services/channelService.js';
import { TokenService } from '../server/services/tokenService.js';
import { env } from '../server/config/env.js';
import developerRouter from '../server/routes/developer.js';
import { getDeveloperModels } from '../server/services/developerModelService.js';
import { getAccessibleModelIds } from '../server/services/modelAccessService.js';
import { defaultRoutingLimits } from '../shared/modelRouting.js';
import { AdminService } from '../server/services/adminService.js';

let server: Server;
let baseUrl: string;
let keyId: number;
const session = jwt.sign({ userId: 1, role: 'user' }, env.JWT_SECRET);
const headers = { Authorization: `Bearer ${session}` };
beforeAll(async () => {
  const app = express();
  app.use('/api/developer', developerRouter);
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status || 500).json({ error: error.message }));
  server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});
beforeEach(() => {
  vi.restoreAllMocks();
  for (const table of [apiTokens, modelPricing, models, settings, contents, users]) db.delete(table).run();
  db.insert(users).values({ id: 1, email: 'developer@test.invalid', username: 'Developer', passwordHash: 'test-only' }).run();
  for (const [modelId, displayName, capabilities] of [
    ['gpt-image-2', "图片 '模型", '["image"]'], ['catalog-video', 'Video', '["video"]'],
    ['catalog-chat', 'Chat', '["text"]'], ['catalog-tts', 'Speech', '["tts"]'],
  ]) db.insert(models).values({ modelId, displayName, capabilities, description: '公开说明', apiKey: 'private-model-secret' }).run();
  db.insert(modelPricing).values({ modelPattern: 'gpt-image-2', billingType: 'per_call', inputPrice: .1, extraParams: '{"category":"image","4K":0.2}' }).run();
  keyId = TokenService.createToken({ userId: 1, name: 'My key' }).id;
  vi.spyOn(ChannelService, 'getActiveChannels').mockReturnValue([{ id: 1, type: 'openai', apiKey: 'private-channel-secret', priority: 0, supportedModels: ['*'] }] as any);
});
afterAll(async () => {
  vi.restoreAllMocks();
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  sqlite.close();
});

describe('developer model catalog authorization and public data', () => {
  it('requires website login and rejects disabled accounts', async () => {
    expect((await fetch(`${baseUrl}/api/developer/models?tokenId=${keyId}`)).status).toBe(401);
    db.update(users).set({ isActive: 0 }).where(eq(users.id, 1)).run();
    expect((await fetch(`${baseUrl}/api/developer/models?tokenId=${keyId}`, { headers })).status).toBe(401);
  });
  it.each(['', '0', '-1', '1.2', '1x', '9007199254740992', '1&tokenId=2'])('rejects malformed token ID %s', async value => {
    expect((await fetch(`${baseUrl}/api/developer/models?tokenId=${value}`, { headers })).status).toBe(400);
  });
  it('never lets a user inspect another user’s key', async () => {
    const foreign = TokenService.createToken({ userId: 2 }).id;
    const response = await fetch(`${baseUrl}/api/developer/models?tokenId=${foreign}`, { headers });
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain('sk-');
  });
  it.each([{ status: 0 }, { expiresAt: '2000-01-01T00:00:00Z' }, { balance: 0 }])('rejects unusable API keys without returning a login-expiry response: %j', async update => {
    TokenService.updateToken(keyId, update);
    const response = await fetch(`${baseUrl}/api/developer/models?tokenId=${keyId}`, { headers });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBeTruthy();
  });
  it('matches discovery permissions, joins prices by canonical ID and omits secrets', async () => {
    TokenService.updateToken(keyId, { allowedModels: ['gpt-image-2', 'catalog-video'] });
    const response = await fetch(`${baseUrl}/api/developer/models?tokenId=${keyId}`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const catalog = await response.json();
    expect(catalog.items.map((model: any) => model.canonicalId)).toEqual(getAccessibleModelIds({ allowedModels: ['gpt-image-2', 'catalog-video'] }));
    expect(catalog.items[0]).toMatchObject({ id: 'gpt-image-2', name: 'gpt-image-2', canonicalId: 'gpt-image-2', pricing: { unit_price: .1, resolution_prices: { '4K': .2 } }, available: true });
    expect(catalog.items[1]).toMatchObject({ pricing: null, endpoints: ['/v1/videos'], health: { state: 'unknown' } });
    const serialized = JSON.stringify(catalog);
    for (const secret of ['private-model-secret', 'private-channel-secret', TokenService.getTokenKeyForUser(keyId, 1).tokenKey]) expect(serialized).not.toContain(secret);
    expect(catalog.token).toEqual({ id: keyId, name: 'My key', maskedKey: expect.stringContaining('****') });
  });
  it('omits disabled and unroutable models and exposes no fabricated speech API', () => {
    db.update(models).set({ isActive: 0 }).where(eq(models.modelId, 'gpt-image-2')).run();
    const catalog = getDeveloperModels(1, keyId);
    expect(catalog.items.some(model => model.canonicalId === 'gpt-image-2')).toBe(false);
    expect(catalog.items.some(model => model.canonicalId === 'catalog-tts')).toBe(false);
    vi.mocked(ChannelService.getActiveChannels).mockReturnValue([]);
    expect(getDeveloperModels(1, keyId).items).toEqual([]);
  });
  it('omits specifications whose routes are all disabled from both discovery and the developer page', () => {
    const limits = defaultRoutingLimits();
    db.insert(settings).values({ key: 'model_specification_routes_v1', value: JSON.stringify([{
      modelId: 'catalog-video', kind: 'video', enabled: true, aliases: [], limits,
      routes: [{ id: 'private-route', channelId: 1, executionModel: 'catalog-video', upstreamModel: 'private-upstream', enabled: false, limits, cost: .001, costUnit: 'per_second', resolutionCosts: {}, priority: 0 }],
    }]) }).run();
    TokenService.updateToken(keyId, { allowedModels: ['catalog-video'] });
    const catalog = getDeveloperModels(1, keyId);
    expect(catalog.items).toEqual([]);
    expect(getAccessibleModelIds({ allowedModels: ['catalog-video'] })).toEqual([]);
    for (const value of ['private-route', 'private-upstream', 'channelId', 'resolutionCosts', 'costUnit']) expect(JSON.stringify(catalog)).not.toContain(value);
  });
  it('does not mark an empty upstream key as an available channel', () => {
    vi.mocked(ChannelService.getActiveChannels).mockReturnValue([{ id: 1, type: 'openai', apiKey: '', supportedModels: ['*'] }] as any);
    expect(getDeveloperModels(1, keyId).items.every(model => !model.available)).toBe(true);
  });
  it('keeps historical auto-enabled imports private until the administrator explicitly confirms them', () => {
    const model = db.insert(models).values({ modelId: 'oauth2', displayName: '未确认模型', description: '由 4月天渠道 同步', capabilities: '["text"]', isActive: 1 }).returning().get();
    expect(getDeveloperModels(1, keyId).items.some(item => item.id === 'oauth2')).toBe(false);
    AdminService.updateModel(model.id, { isActive: 1 });
    expect(getDeveloperModels(1, keyId).items.find(item => item.id === 'oauth2')).toMatchObject({ name: 'oauth2', description: '' });
    AdminService.updateModel(model.id, { isActive: 0 });
    expect(getDeveloperModels(1, keyId).items.some(item => item.id === 'oauth2')).toBe(false);
  });
  it('keeps administrator descriptions while removing internal provider names and Chinese display IDs', () => {
    db.update(models).set({ provider: 'pidoi', displayName: 'gpt-image-2 · Pidoi 原生 4K', description: 'Pidoi 原生 4K 文生图/图生图' }).where(eq(models.modelId, 'gpt-image-2')).run();
    const model = getDeveloperModels(1, keyId).items.find(item => item.id === 'gpt-image-2')!;
    expect(model).toMatchObject({ name: 'gpt-image-2', description: '原生 4K 文生图/图生图' });
    expect(JSON.stringify(model)).not.toContain('Pidoi');
  });
  it('does not auto-enable newly synchronized models and preserves administrator switches on resync', async () => {
    const channelId = ChannelService.createChannel({ name: '同步测试渠道', type: 'openai', baseUrl: 'https://sync.test.invalid', apiKey: 'test-only' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [{ id: 'new-import' }] }));
    await ChannelService.syncModels(channelId);
    const imported = db.select().from(models).where(eq(models.modelId, 'new-import')).get()!;
    expect(imported.isActive).toBe(0);
    AdminService.updateModel(imported.id, { isActive: 1 });
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ data: [{ id: 'new-import' }] }));
    await ChannelService.syncModels(channelId);
    expect(db.select().from(models).where(eq(models.id, imported.id)).get()?.isActive).toBe(1);
    expect(getDeveloperModels(1, keyId).items.find(item => item.id === 'new-import')).toMatchObject({ description: '' });
  });
});
