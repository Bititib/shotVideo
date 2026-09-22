import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../server/db/index.js';
import { initDatabase } from '../server/db/seed.js';
import { channels, modelPricing, models, settings } from '../server/db/schema.js';
import {
  MINGFEI_CHANNEL_TYPE,
  MINGFEI_DEFAULT_BASE_URL,
  MINGFEI_IMAGE_MODEL,
  MINGFEI_IMAGE_PRICE,
} from '../server/services/mingFeiImageAdapter.js';
import { PricingService } from '../server/services/pricingService.js';

beforeAll(async () => {
  await initDatabase();
});

describe('MingFei channel configuration', () => {
  it('registers an independent image model and channel', () => {
    expect(db.select().from(models).where(eq(models.modelId, MINGFEI_IMAGE_MODEL)).get()).toMatchObject({
      provider: 'mingfei',
      isActive: 1,
    });
    const channel = db.select().from(channels).where(eq(channels.baseUrl, MINGFEI_DEFAULT_BASE_URL)).get();
    expect(channel).toMatchObject({ type: MINGFEI_CHANNEL_TYPE });
    expect(JSON.parse(channel!.supportedModels)).toEqual([MINGFEI_IMAGE_MODEL]);
    expect(JSON.parse(channel!.modelMapping)[MINGFEI_IMAGE_MODEL]).toBe('gpt-image-2');
    expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern, MINGFEI_IMAGE_MODEL)).get())
      .toMatchObject({ billingType: 'per_call', inputPrice: MINGFEI_IMAGE_PRICE });
    const pricing = db.select().from(modelPricing).where(eq(modelPricing.modelPattern, MINGFEI_IMAGE_MODEL)).get()!;
    expect(JSON.parse(pricing.extraParams || '{}')).toMatchObject({
      category: 'image',
      '1K': MINGFEI_IMAGE_PRICE,
      '2K': MINGFEI_IMAGE_PRICE,
      '4K': MINGFEI_IMAGE_PRICE,
    });
  });

  it('quotes each configured resolution independently', () => {
    const pricing = db.select().from(modelPricing).where(eq(modelPricing.modelPattern, MINGFEI_IMAGE_MODEL)).get()!;
    db.update(modelPricing).set({
      extraParams: JSON.stringify({ category: 'image', '1K': 0.05, '2K': 0.08, '4K': 0.12 }),
    }).where(eq(modelPricing.id, pricing.id)).run();

    expect(PricingService.quote(MINGFEI_IMAGE_MODEL, { resolution: '1K' }, false).cost).toBe(0.05);
    expect(PricingService.quote(MINGFEI_IMAGE_MODEL, { resolution: '2K' }, false).cost).toBe(0.08);
    expect(PricingService.quote(MINGFEI_IMAGE_MODEL, { resolution: '4K', count: 2 }, false).cost).toBe(0.24);

    db.update(modelPricing).set({
      extraParams: JSON.stringify({ category: 'image', '1K': MINGFEI_IMAGE_PRICE, '2K': MINGFEI_IMAGE_PRICE, '4K': MINGFEI_IMAGE_PRICE }),
    }).where(eq(modelPricing.id, pricing.id)).run();
  });

  it('never overwrites an administrator price during a later migration', async () => {
    const customPrice = 0.37;
    db.update(modelPricing).set({ inputPrice: customPrice })
      .where(eq(modelPricing.modelPattern, MINGFEI_IMAGE_MODEL)).run();
    db.delete(settings).where(eq(settings.key, 'migration_mingfei_gpt_image_2_price_v1')).run();

    await initDatabase();

    expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern, MINGFEI_IMAGE_MODEL)).get()?.inputPrice)
      .toBe(customPrice);
    db.update(modelPricing).set({ inputPrice: MINGFEI_IMAGE_PRICE })
      .where(eq(modelPricing.modelPattern, MINGFEI_IMAGE_MODEL)).run();
  });
});
