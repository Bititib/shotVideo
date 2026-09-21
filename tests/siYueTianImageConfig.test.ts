import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../server/db/index.js';
import { initDatabase } from '../server/db/seed.js';
import { channels, modelPricing, models } from '../server/db/schema.js';
import {
  SI_YUE_TIAN_IMAGE_MODELS,
  SI_YUE_TIAN_IMAGE_PRICE,
} from '../server/services/siYueTianImageAdapter.js';

beforeAll(async () => {
  await initDatabase();
});

describe('四月天图片模型配置', () => {
  it('将六个模型作为可选图片模型写入数据库', () => {
    for (const modelId of SI_YUE_TIAN_IMAGE_MODELS) {
      const model = db.select().from(models).where(eq(models.modelId, modelId)).get();
      expect(model).toMatchObject({ provider: 'siyuetian', isActive: 1 });
      expect(JSON.parse(model!.capabilities)).toContain('image');
    }
  });

  it('绑定到四月天渠道并统一按次计费', () => {
    const channel = db.select().from(channels).where(eq(channels.baseUrl, 'https://llm.chre3.com')).get();
    expect(channel).toBeTruthy();
    expect(JSON.parse(channel!.supportedModels)).toEqual(expect.arrayContaining([...SI_YUE_TIAN_IMAGE_MODELS]));
    for (const modelPattern of SI_YUE_TIAN_IMAGE_MODELS) {
      expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern, modelPattern)).get()).toMatchObject({
        billingType: 'per_call',
        inputPrice: SI_YUE_TIAN_IMAGE_PRICE,
      });
    }
  });
});
