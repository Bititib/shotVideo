import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../server/db/index.js';
import { initDatabase } from '../server/db/seed.js';
import { channels, modelPricing, models } from '../server/db/schema.js';
import { ChannelService } from '../server/services/channelService.js';
import { PricingService } from '../server/services/pricingService.js';
import {
  WX_HAIDIYUE_FACE_SPLIT_MODEL,
  WX_HAIDIYUE_FACE_SPLIT_MODEL_NAME,
  WX_HAIDIYUE_FACE_SPLIT_PRICE,
  WX_HAIDIYUE_UPSTREAM_MODEL,
} from '../server/services/wxHaidiYueAdapter.js';

let channelId = 0;

beforeAll(async () => {
  await initDatabase();
});

afterAll(() => {
  if (channelId) db.delete(channels).where(eq(channels.id, channelId)).run();
});

describe('wx-海底月 face_split channel setting', () => {
  it('seeds a dedicated selectable model with independent per-call pricing', () => {
    expect(db.select().from(models).where(eq(models.modelId, WX_HAIDIYUE_FACE_SPLIT_MODEL)).get()).toMatchObject({
      displayName: WX_HAIDIYUE_FACE_SPLIT_MODEL_NAME,
      description: '支持真人；固定30秒；最多9张参考图；固定按次计费 ¥2.00/次',
      provider: 'wx-haidiyue',
      isActive: 1,
    });
    expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern, WX_HAIDIYUE_FACE_SPLIT_MODEL)).get()).toMatchObject({
      billingType: 'per_call',
      inputPrice: WX_HAIDIYUE_FACE_SPLIT_PRICE,
    });
    expect(PricingService.quote(WX_HAIDIYUE_FACE_SPLIT_MODEL, { seconds: 30 }, false)).toMatchObject({
      billingType: 'per_call',
      rate: 2,
      cost: 2,
    });
  });

  it('defaults to enabled and persists administrator changes', () => {
    channelId = ChannelService.createChannel({
      name: 'temporary wx-海底月 channel',
      type: 'wx-haidiyue',
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
    });

    expect(db.select().from(channels).where(eq(channels.id, channelId)).get()?.faceSplitEnabled).toBe(1);
    expect(ChannelService.getChannels().find(channel => channel.id === channelId)?.faceSplitEnabled).toBe(1);
    expect(ChannelService.getChannels().find(channel => channel.id === channelId)).toMatchObject({
      supportedModels: [WX_HAIDIYUE_FACE_SPLIT_MODEL],
      modelMapping: { [WX_HAIDIYUE_FACE_SPLIT_MODEL]: WX_HAIDIYUE_UPSTREAM_MODEL },
    });
    expect(ChannelService.findChannelForModel(WX_HAIDIYUE_FACE_SPLIT_MODEL)?.id).toBe(channelId);

    ChannelService.updateChannel(channelId, { faceSplitEnabled: 0 });
    expect(db.select().from(channels).where(eq(channels.id, channelId)).get()?.faceSplitEnabled).toBe(0);

    ChannelService.updateChannel(channelId, { faceSplitEnabled: 1 });
    expect(db.select().from(channels).where(eq(channels.id, channelId)).get()?.faceSplitEnabled).toBe(1);
  });
});
