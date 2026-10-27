import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../server/db/index.js';
import { initDatabase } from '../server/db/seed.js';
import { channels, models } from '../server/db/schema.js';
import { ChannelService } from '../server/services/channelService.js';

const createdChannelIds: number[] = [];
const createdModelIds: string[] = [];

beforeAll(async () => { await initDatabase(); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => {
  for (const id of createdChannelIds) db.delete(channels).where(eq(channels.id, id)).run();
  for (const modelId of createdModelIds) db.delete(models).where(eq(models.modelId, modelId)).run();
});

describe('Pidoi 图片渠道模型同步', () => {
  it('部署重启时自动恢复已被覆盖的线上渠道绑定', async () => {
    const seeded = db.select().from(channels).all().find(channel => channel.name === 'Pidoi 图片渠道')!;
    expect(seeded).toBeTruthy();
    db.update(channels).set({
      supportedModels: JSON.stringify(['omni-flash-720p', 'sora-v3-933-pro']),
      modelMapping: JSON.stringify({ 'omni-flash-720p': 'omni-flash-720p' }),
    }).where(eq(channels.id, seeded.id)).run();

    await initDatabase();

    const repaired = db.select().from(channels).where(eq(channels.id, seeded.id)).get()!;
    expect(JSON.parse(repaired.supportedModels)).toEqual(['gpt-image-2']);
  });

  it('恢复被通用目录覆盖的 gpt-image-2，且不请求上游视频列表', async () => {
    const id = ChannelService.createChannel({
      name: `Pidoi 图片渠道-恢复测试-${Date.now()}`,
      type: 'openai',
      baseUrl: 'https://pidoi.com',
      apiKey: 'test-only-key',
      supportedModels: ['omni-flash-720p', 'sora-v3-933-pro'],
      modelMapping: { 'omni-flash-720p': 'omni-flash-720p' },
    });
    createdChannelIds.push(id);
    const upstream = vi.spyOn(globalThis, 'fetch');

    await expect(ChannelService.syncModels(id)).resolves.toMatchObject({
      count: 1,
      added: 0,
      models: ['gpt-image-2'],
      warnings: [expect.stringContaining('已保留 gpt-image-2')],
    });

    const saved = db.select().from(channels).where(eq(channels.id, id)).get()!;
    expect(JSON.parse(saved.supportedModels)).toEqual(['gpt-image-2']);
    expect(JSON.parse(saved.modelMapping)).toEqual({ 'gpt-image-2': 'gpt-image-2' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('同域名的 Pidoi 视频渠道仍按上游目录同步', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const modelId = `pidoi-video-${suffix}`;
    const id = ChannelService.createChannel({
      name: `Pidoi Sora V3 Pro 渠道-${suffix}`,
      type: 'openai',
      baseUrl: 'https://pidoi.com',
      apiKey: 'test-only-key',
      supportedModels: [],
    });
    createdChannelIds.push(id);
    createdModelIds.push(modelId);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [{ id: modelId, type: 'video' }] }));

    await expect(ChannelService.syncModels(id)).resolves.toMatchObject({ count: 1, added: 1, models: [modelId] });
    const saved = db.select().from(channels).where(eq(channels.id, id)).get()!;
    expect(JSON.parse(saved.supportedModels)).toEqual([modelId]);
  });
});
