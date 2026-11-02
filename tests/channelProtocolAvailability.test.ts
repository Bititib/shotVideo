import { afterAll, afterEach, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
import { db, sqlite } from '../server/db/index.js';
import { channels } from '../server/db/schema.js';
import { ChannelService } from '../server/services/channelService.js';
import { selectModelRoutes } from '../server/services/modelRoutingService.js';
import { defaultRoutingLimits } from '../shared/modelRouting.js';

afterAll(() => sqlite.close());
afterEach(() => vi.unstubAllGlobals());
it('excludes uninstalled protocols from routing and recovery without deleting stored channels', async () => {
  const id = Number(db.insert(channels).values({ name: 'old channel', type: 'removed-provider',
    baseUrl: 'https://old.invalid', apiKey: 'original-key', supportedModels: '["old-model"]', status: 1 }).run().lastInsertRowid);
  const before = db.select().from(channels).all();
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  expect(ChannelService.getActiveChannels()).toEqual([]);
  expect(ChannelService.getChannelRaw(id, 123)).toBeUndefined();
  const limits = defaultRoutingLimits();
  expect(selectModelRoutes({ modelId: 'old-model', kind: 'video', enabled: true, aliases: [], limits,
    routes: [{ id: 'old', channelId: id, executionModel: 'old-model', upstreamModel: 'upstream',
      enabled: true, limits, priority: 0, cost: 0, costUnit: 'per_call', resolutionCosts: {} }] },
    { images: 0, videos: 0, audios: 0, outputs: 1, seconds: 5, resolution: '720p', ratio: '16:9', firstFrame: false, lastFrame: false })).toEqual([]);
  await expect(ChannelService.syncModels(id)).rejects.toMatchObject({ status: 404 });
  await expect(ChannelService.testChannel(id)).rejects.toMatchObject({ status: 404 });
  expect(fetcher).not.toHaveBeenCalled();
  expect(db.select().from(channels).all()).toEqual(before);
});
it('keeps installed generic channel execution available', () => {
  const id = ChannelService.createChannel({ name: 'supported', type: 'openai', baseUrl: 'https://supported.invalid',
    apiKey: 'supported-key', supportedModels: ['supported-model'] });
  expect(ChannelService.getActiveChannels().some(c => c.id === id)).toBe(true);
  expect(ChannelService.getChannelRaw(id)?.apiKey).toBe('supported-key');
});
