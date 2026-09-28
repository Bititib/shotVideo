import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const sqlite = new Database(':memory:');
  return { db: drizzle(sqlite), sqlite };
});
vi.mock('../server/config/env.js', async importOriginal => {
  const original = await importOriginal<typeof import('../server/config/env.js')>();
  return {
    ...original,
    env: {
      ...Object.fromEntries(Object.entries(original.env).map(([key, value]) =>
        [key, /API_KEY/.test(key) ? '' : value])),
      NODE_ENV: 'test', ADMIN_EMAIL: 'catalog@test.com', ADMIN_PASSWORD: 'test-only-password',
    },
    getApiKeys: () => [],
  };
});
vi.mock('../server/services/channelService.js', () => ({
  ChannelService: { getActiveChannels: vi.fn(() => [{ supportedModels: ['*'] }]) },
}));
vi.mock('../server/services/hmStudioOverflowChannelService.js', () => ({
  hasHmStudioOverflowChannel: vi.fn(() => false),
  findHmStudioOverflowPlan: vi.fn(),
}));

import { db, sqlite } from '../server/db/index.js';
import { models, settings } from '../server/db/schema.js';
import { eq } from 'drizzle-orm';
import { initDatabase } from '../server/db/seed.js';
import { getEnabledPublicModels } from '../server/services/modelCatalogService.js';
import v1Router, { getAccessibleModels, getAccessibleModelIds } from '../server/routes/v1.js';
import { ChannelService } from '../server/services/channelService.js';
import { TokenService } from '../server/services/tokenService.js';
import { hasHmStudioOverflowChannel } from '../server/services/hmStudioOverflowChannelService.js';

let server: Server;
let baseUrl: string;
beforeAll(async () => {
  // Run the real startup twice, against memory only, without external calls.
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External calls disabled in test'));
  await initDatabase();
  const ids = ['seedance-2.0', 'seedance_v2.5', 'gpt-image-2'];
  for (const id of ids) {
    db.update(models).set({ displayName: `自定义 ${id}`, description: '后台填写的说明', isActive: 0 })
      .where(eq(models.modelId, id)).run();
  }
  // Exercise the old one-time Seedance migration as well as routine startup sync.
  db.delete(settings).where(eq(settings.key, 'migration_siyuetian_seedance_20_standardize_v1')).run();
  await initDatabase();
  expect(network).not.toHaveBeenCalled();
  network.mockRestore();
  const app = express();
  app.use('/v1', v1Router);
  server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  vi.restoreAllMocks();
  sqlite.close();
});

describe('admin-owned model catalog', () => {
  it('preserves edited names, descriptions and disabled state across restart and legacy migration', () => {
    for (const id of ['seedance-2.0', 'seedance_v2.5', 'gpt-image-2']) {
      expect(db.select().from(models).where(eq(models.modelId, id)).get()).toMatchObject({
        displayName: `自定义 ${id}`, description: '后台填写的说明', isActive: 0,
      });
    }
    expect(db.select().from(models).where(eq(models.modelId, 'nano-banana-2')).get()?.displayName)
      .toBe('nano-banana-2');
  });

  it('lists exactly the enabled public registry on wildcard routes, without old defaults or channel-only IDs', () => {
    const websiteIds = getEnabledPublicModels().map(model => model.modelId);
    expect(getAccessibleModelIds({ allowedModels: [] })).toEqual(websiteIds);
    expect(websiteIds).not.toContain('seedance-2.0');
    expect(websiteIds).not.toContain('sora-v4-fast');
    vi.mocked(ChannelService.getActiveChannels).mockReturnValueOnce([
      { supportedModels: ['channel-only-model'] },
    ] as any);
    expect(getAccessibleModelIds({ allowedModels: [] })).toEqual([]);
  });

  it('respects token whitelist and current channel availability', () => {
    const id = 'nano-banana-2';
    expect(getAccessibleModelIds({ allowedModels: [id, 'channel-only-model'] })).toEqual([id]);
    vi.mocked(ChannelService.getActiveChannels).mockReturnValueOnce([]);
    expect(getAccessibleModelIds({ allowedModels: [id] })).toEqual([]);
    expect(getAccessibleModels({ allowedModels: [id] })[0].displayName).toBe(id);
  });

  it('does not resurrect disabled HM models even when overflow is available', () => {
    vi.mocked(hasHmStudioOverflowChannel).mockReturnValueOnce(true);
    expect(getAccessibleModelIds({ allowedModels: [] })).not.toContain('seedance_v2.5');
  });

  it('returns the admin name with the unchanged ID, without exposing private model fields', async () => {
    const validate = vi.spyOn(TokenService, 'validateToken').mockReturnValue({
      valid: true, token: { allowedModels: ['nano-banana-2'] },
    } as any);
    db.update(models).set({ displayName: '我的图片模型', apiKey: 'private-model-key' })
      .where(eq(models.modelId, 'nano-banana-2')).run();
    const response = await fetch(`${baseUrl}/v1/models`, { headers: { Authorization: 'Bearer test' } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual([{
      id: 'nano-banana-2', name: '我的图片模型', object: 'model', created: expect.any(Number), owned_by: 'system',
    }]);
    expect(JSON.stringify(body)).not.toContain('private-model-key');
    validate.mockRestore();
  });

  it('keeps a completely disabled category empty rather than reviving preset models', () => {
    for (const model of getEnabledPublicModels('image')) {
      db.update(models).set({ isActive: 0 }).where(eq(models.id, model.id)).run();
    }
    expect(getEnabledPublicModels('image')).toEqual([]);
  });
});
