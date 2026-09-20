import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../server/db/index.js';
import { initDatabase } from '../server/db/seed.js';
import { channels, modelPricing, models } from '../server/db/schema.js';
import { ChannelService } from '../server/services/channelService.js';
import { PricingService } from '../server/services/pricingService.js';
import {
  MIAOWU_DEFAULT_VIDEO_MODELS,
  MIAOWU_SEEDANCE_25_DEAL_MODEL,
  MIAOWU_SEEDANCE_25_PRO_MODEL,
} from '../server/services/miaowuVideoAdapter.js';

let channelId = 0;

beforeAll(async () => {
  await initDatabase();
});

afterAll(() => {
  if (channelId) db.delete(channels).where(eq(channels.id, channelId)).run();
});

describe('Miaowu Seedance 2.5 Deal channel configuration', () => {
  it('seeds an active per-call video model', () => {
    expect(db.select().from(models).where(eq(models.modelId, MIAOWU_SEEDANCE_25_DEAL_MODEL)).get()).toMatchObject({
      provider: 'miaowu',
      displayName: 'Seedance 2.5 Deal',
      isActive: 1,
    });
    expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern, MIAOWU_SEEDANCE_25_DEAL_MODEL)).get()).toMatchObject({
      billingType: 'per_call',
      inputPrice: 1.8,
    });
    expect(PricingService.quote(MIAOWU_SEEDANCE_25_DEAL_MODEL, { seconds: 30, resolution: '720p' }, false)).toMatchObject({
      billingType: 'per_call',
      rate: 1.8,
      cost: 1.8,
    });
  });

  it('seeds Seedance 2.5 Pro with per-second pricing', () => {
    expect(db.select().from(models).where(eq(models.modelId, MIAOWU_SEEDANCE_25_PRO_MODEL)).get()).toMatchObject({
      provider: 'miaowu',
      displayName: 'Seedance 2.5 Pro',
      isActive: 1,
    });
    expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern, MIAOWU_SEEDANCE_25_PRO_MODEL)).get()).toMatchObject({
      billingType: 'per_second',
      inputPrice: 0.2,
    });
    expect(PricingService.quote(MIAOWU_SEEDANCE_25_PRO_MODEL, { seconds: 30, resolution: '720p' }, false)).toMatchObject({
      billingType: 'per_second',
      rate: 0.2,
      cost: 6,
    });
  });

  it('binds the model automatically when a Miaowu channel is created', () => {
    channelId = ChannelService.createChannel({
      name: 'temporary Miaowu channel',
      type: 'miaowu',
      baseUrl: 'https://api.miaowuai.store',
      apiKey: 'test-key',
    });

    expect(ChannelService.getChannels().find(channel => channel.id === channelId)).toMatchObject({
      supportedModels: [...MIAOWU_DEFAULT_VIDEO_MODELS],
      modelMapping: {
        [MIAOWU_SEEDANCE_25_DEAL_MODEL]: MIAOWU_SEEDANCE_25_DEAL_MODEL,
        [MIAOWU_SEEDANCE_25_PRO_MODEL]: MIAOWU_SEEDANCE_25_PRO_MODEL,
      },
    });
    expect(ChannelService.findChannelForModel(MIAOWU_SEEDANCE_25_DEAL_MODEL)?.id).toBe(channelId);
  });
});
