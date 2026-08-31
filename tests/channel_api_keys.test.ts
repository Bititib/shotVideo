import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../server/db/index.js';
import { initDatabase } from '../server/db/seed.js';
import { channelApiKeys, channels } from '../server/db/schema.js';
import { ChannelService } from '../server/services/channelService.js';

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const channelName = `HM multi-key test ${suffix}`;
const firstKey = `hm-test-a-${suffix}`;
const secondKey = `hm-test-b-${suffix}`;
const thirdKey = `hm-test-c-${suffix}`;
let channelId = 0;

beforeAll(async () => {
  await initDatabase();
});

afterAll(() => {
  if (!channelId) return;
  db.delete(channelApiKeys).where(eq(channelApiKeys.channelId, channelId)).run();
  db.delete(channels).where(eq(channels.id, channelId)).run();
  ChannelService.getActiveChannels();
});

describe('HM Studio channel API keys', () => {
  it('stores multiple independently limited keys under one channel', () => {
    channelId = ChannelService.createChannel({
      name: channelName,
      type: 'hmstudio',
      baseUrl: 'https://hm.example.test',
      supportedModels: [`model-${suffix}`],
      modelMapping: {},
      priority: -100,
      apiKeys: [
        { apiKey: firstKey, concurrencyLimit: 3, status: 1 },
        { apiKey: secondKey, concurrencyLimit: 7, status: 1 },
      ],
    });

    const storedKeys = db.select().from(channelApiKeys)
      .where(eq(channelApiKeys.channelId, channelId))
      .all();
    expect(storedKeys).toHaveLength(2);
    expect(storedKeys.map(key => key.concurrencyLimit).sort((a, b) => a - b)).toEqual([3, 7]);

    const adminChannel = ChannelService.getChannels().find(channel => channel.id === channelId);
    expect(adminChannel).toMatchObject({ apiKeyCount: 2, concurrencyLimit: 10 });
    expect(adminChannel.apiKeys).toHaveLength(2);
    expect(adminChannel.apiKeys.every((key: any) => key.maskedKey.startsWith('****'))).toBe(true);

    const executionCandidates = ChannelService.getActiveChannels().filter(channel => channel.id === channelId);
    expect(executionCandidates).toHaveLength(2);
    expect(new Set(executionCandidates.map(channel => channel.apiKey))).toEqual(new Set([firstKey, secondKey]));
    expect(new Set(executionCandidates.map(channel => channel.apiKeyId)).size).toBe(2);
  });

  it('updates, adds and removes keys without creating another channel', () => {
    const current = db.select().from(channelApiKeys)
      .where(eq(channelApiKeys.channelId, channelId))
      .all();
    const keep = current.find(key => key.apiKey === firstKey)!;

    ChannelService.updateChannel(channelId, {
      apiKeys: [
        { id: keep.id, concurrencyLimit: 5, status: 1 },
        { apiKey: thirdKey, concurrencyLimit: 11, status: 1 },
      ],
    });

    const updated = db.select().from(channelApiKeys)
      .where(eq(channelApiKeys.channelId, channelId))
      .all();
    expect(updated).toHaveLength(2);
    expect(updated.find(key => key.apiKey === firstKey)?.concurrencyLimit).toBe(5);
    expect(updated.find(key => key.apiKey === secondKey)).toBeUndefined();
    expect(updated.find(key => key.apiKey === thirdKey)?.concurrencyLimit).toBe(11);
    expect(db.select().from(channels).where(eq(channels.name, channelName)).all()).toHaveLength(1);
  });

  it('rejects a duplicate key instead of counting it as extra capacity', () => {
    expect(() => ChannelService.updateChannel(channelId, {
      apiKeys: [
        ...db.select().from(channelApiKeys).where(eq(channelApiKeys.channelId, channelId)).all()
          .map(key => ({ id: key.id, concurrencyLimit: key.concurrencyLimit, status: key.status })),
        { apiKey: thirdKey, concurrencyLimit: 20, status: 1 },
      ],
    })).toThrow();
  });

  it('auto-disables only the failed HM key and allows an admin to start it again', () => {
    const target = ChannelService.getActiveChannels().find(channel => channel.id === channelId)!;
    expect(target.apiKeyId).toBeTruthy();

    ChannelService.disableExecutionTarget(target, '当前分组上游负载已饱和，请稍后再试');
    const stopped = db.select().from(channelApiKeys).where(eq(channelApiKeys.id, target.apiKeyId!)).get();
    const parent = db.select().from(channels).where(eq(channels.id, channelId)).get();
    expect(stopped?.status).toBe(0);
    expect(parent?.status).toBe(1);
    expect(parent?.lastTestResult).toContain('auto_disabled:');

    ChannelService.setHmStudioKeyStatus(channelId, target.apiKeyId!, 1);
    const restarted = db.select().from(channelApiKeys).where(eq(channelApiKeys.id, target.apiKeyId!)).get();
    expect(restarted?.status).toBe(1);
  });
});
