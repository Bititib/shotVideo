import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/config/env.js', () => ({
  env: {
    NODE_ENV: 'test', GEMINI_API_KEY: '', GEMINI_API_BASE_URL: 'https://google.invalid',
    HM_STUDIO_API_KEY: '', WX_HAIDIYUE_API_KEY: '', MINGFEI_API_KEY: '',
    NEWTOKEN_BASE_URL: 'https://newtoken.club', NEWTOKEN_API_KEY: '',
    SNUMOM_BASE_URL: 'https://snumom.com', SNUMOM_API_KEY: '',
    ADMIN_EMAIL: 'catalog-startup@test.invalid', ADMIN_PASSWORD: 'test-only-password',
  },
  getApiKeys: () => [],
}));

import { eq } from 'drizzle-orm';
import { db, sqlite } from '../server/db/index.js';
import { channels, modelPricing, models, settings, users } from '../server/db/schema.js';
import { initDatabase } from '../server/db/seed.js';
import { ChannelService } from '../server/services/channelService.js';
import { getModelSpecification } from '../server/services/modelRoutingService.js';
import { SiYueTianCatalogConflictError } from '../server/services/siYueTianMinimaxCatalog.js';
import { defaultRoutingLimits } from '../shared/modelRouting.js';
import { SI_YUE_TIAN_MINIMAX_MODEL as MINIMAX } from '../shared/siYueTianMinimax.js';
import { SI_YUE_TIAN_SEEDANCE_C4_MODEL as C4 } from '../shared/siYueTianManagedVideo.js';

const network = vi.fn(async () => { throw Error('External network disabled in catalog startup test'); });
const product = (modelId: string) => db.select().from(models).where(eq(models.modelId, modelId)).get();
const price = (modelId: string) => db.select().from(modelPricing).where(eq(modelPricing.modelPattern, modelId)).get();

beforeEach(() => {
  sqlite.exec('SAVEPOINT catalog_startup_case');
  network.mockClear();
  vi.stubGlobal('fetch', network);
  for (const key of ['SI_YUE_TIAN_API_KEY', 'PIDOI_IMAGE_API_KEY', 'MJNEWAPI_API_KEY', 'JULUN_API_KEY']) vi.stubEnv(key, '');
});
afterEach(() => {
  sqlite.exec('ROLLBACK TO catalog_startup_case; RELEASE catalog_startup_case');
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});
afterAll(() => sqlite.close());

describe('actual database startup with Siyuetian catalog conflicts', () => {
  it('continues repeated startup without taking over an occupied C4 product or changing its pricing, routes and balance', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    db.insert(models).values({ modelId: C4, provider: 'operator-provider', displayName: '管理员产品',
      description: '保留原产品说明', capabilities: '["text"]', isActive: 1 }).run();
    db.insert(modelPricing).values({ modelPattern: C4, billingType: 'per_second', inputPrice: 0.37,
      outputPrice: 0.19, extraParams: '{"operator":"original"}' }).run();
    const owner = db.insert(channels).values({ name: '原产品渠道', type: 'operator-provider', baseUrl: 'https://owner.invalid',
      apiKey: 'test-only-key', supportedModels: JSON.stringify([C4]), modelMapping: JSON.stringify({ [C4]: 'original-upstream' }) }).returning().get();
    const originalSpec = { modelId: C4, kind: 'video', enabled: false, aliases: [], limits: defaultRoutingLimits(),
      routes: [{ id: 'operator-route', channelId: owner.id, executionModel: C4, upstreamModel: 'original-upstream', enabled: false,
        limits: defaultRoutingLimits(), cost: 0.11, costUnit: 'per_second', resolutionCosts: {}, priority: 7 }] };
    db.insert(settings).values({ key: 'model_specification_routes_v1', value: JSON.stringify([originalSpec]) }).run();
    const account = db.insert(users).values({ email: 'wallet@test.invalid', username: 'wallet', passwordHash: 'test-only-hash', balance: 83.25 }).returning().get();
    const originalProduct = product(C4), originalPrice = price(C4);

    for (let boot = 0; boot < 2; boot++) {
      await expect(initDatabase()).resolves.toBeUndefined();
      expect(product(C4)).toEqual(originalProduct);
      expect(price(C4)).toEqual(originalPrice);
      expect(getModelSpecification(C4)).toEqual(originalSpec);
      expect(db.select().from(channels).where(eq(channels.id, owner.id)).get()).toEqual(owner);
      expect(db.select().from(users).where(eq(users.id, account.id)).get()?.balance).toBe(83.25);
      expect(sqlite.prepare("SELECT key FROM settings WHERE key LIKE 'catalog_siyuetian_seedance_c4_%'").all()).toEqual([]);
      for (const channel of db.select().from(channels).all().filter(row => row.id !== owner.id)) {
        expect(JSON.parse(channel.supportedModels)).not.toContain(C4);
      }
      expect(product(MINIMAX)).toMatchObject({ provider: 'siyuetian', isActive: 0, capabilities: '["video"]' });
      expect(price(MINIMAX)).toMatchObject({ billingType: 'per_call', inputPrice: 2 });
    }
    expect(warn.mock.calls.some(call => String(call[0]).includes(C4) && String(call[0]).includes('已被其他产品占用'))).toBe(true);

    // Exercise the real HTTP app after the same initialization failure reported
    // in production. App-owned filesystem paths are isolated from workspace data.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-startup-http-'));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(directory);
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const { createApp } = await import('../server/app.js');
      const app = await createApp();
      const server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        const health = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
          const request = get(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, body }));
          });
          request.on('error', reject);
          request.setTimeout(5_000, () => request.destroy(new Error('Health check timed out')));
        });
        expect(health.status).toBe(200);
        expect(JSON.parse(health.body)).toEqual({ status: 'ok' });
      } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    } finally {
      cwd.mockRestore();
      if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('catalog-startup-http-')) {
        throw new Error('Unexpected temporary directory; refusing cleanup');
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
    expect(network).not.toHaveBeenCalled();
  });

  it('still registers healthy C4 when the earlier MiniMax association conflicts', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    db.insert(models).values({ modelId: MINIMAX, provider: 'operator-provider', displayName: '原 MiniMax', isActive: 1 }).run();
    const original = product(MINIMAX);

    await expect(initDatabase()).resolves.toBeUndefined();

    expect(product(MINIMAX)).toEqual(original);
    expect(product(C4)).toMatchObject({ provider: 'siyuetian', isActive: 0, capabilities: '["video"]' });
    expect(price(C4)).toMatchObject({ billingType: 'per_call', inputPrice: 6 });
    expect(getModelSpecification(C4)?.routes).toHaveLength(1);
    expect(network).not.toHaveBeenCalled();
  });

  it('keeps explicit channel sync strict and rolls back the earlier healthy model on a C4 collision', async () => {
    db.insert(models).values({ modelId: C4, provider: 'operator-provider', displayName: '原 C4', isActive: 1 }).run();
    db.insert(modelPricing).values({ modelPattern: C4, billingType: 'per_call', inputPrice: 9.5 }).run();
    const channel = db.insert(channels).values({ name: '四月天同步', type: 'openai', baseUrl: 'https://llm.chre3.com',
      apiKey: 'test-only-key', supportedModels: '[]', modelMapping: '{}' }).returning().get();
    const snapshot = () => JSON.stringify(['models', 'model_pricing', 'channels', 'settings'].map(table => sqlite.prepare(`SELECT * FROM ${table}`).all()));
    const before = snapshot();
    const catalog = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ data: [{ id: MINIMAX }, { id: C4 }] }));
    vi.stubGlobal('fetch', catalog);

    await expect(ChannelService.syncModels(channel.id)).rejects.toBeInstanceOf(SiYueTianCatalogConflictError);

    expect(snapshot()).toBe(before);
    expect(product(MINIMAX)).toBeUndefined();
    expect(catalog).toHaveBeenCalledOnce();
    expect(catalog.mock.calls[0][1]?.method).not.toBe('POST');
  });
});
