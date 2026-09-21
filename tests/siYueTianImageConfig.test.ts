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

  it('将 Pidoi 原生 4K 与四月天 GPT Image 2 拆成独立模型', () => {
    const pidoiModel = db.select().from(models).where(eq(models.modelId, 'gpt-image-2')).get();
    const siyueModel = db.select().from(models).where(eq(models.modelId, 'gpt-image-2-siyuetian')).get();
    expect(pidoiModel).toMatchObject({ provider: 'pidoi', isActive: 1 });
    expect(siyueModel).toMatchObject({ provider: 'siyuetian', isActive: 1 });

    const pidoiChannel = db.select().from(channels).all().find(channel => channel.baseUrl.includes('pidoi.com') && channel.name.includes('图片'));
    const siyueChannel = db.select().from(channels).where(eq(channels.baseUrl, 'https://llm.chre3.com')).get();
    expect(JSON.parse(pidoiChannel!.supportedModels)).toContain('gpt-image-2');
    expect(JSON.parse(pidoiChannel!.supportedModels)).not.toContain('gpt-image-2-siyuetian');
    expect(JSON.parse(siyueChannel!.supportedModels)).toContain('gpt-image-2-siyuetian');
    expect(JSON.parse(siyueChannel!.supportedModels)).not.toContain('gpt-image-2');
    expect(JSON.parse(siyueChannel!.modelMapping)['gpt-image-2-siyuetian']).toBe('gpt-image-2');
    expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern, 'gpt-image-2')).get())
      .toMatchObject({ billingType: 'per_call', inputPrice: 0.10 });
    expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern, 'gpt-image-2-siyuetian')).get())
      .toMatchObject({ billingType: 'per_call', inputPrice: SI_YUE_TIAN_IMAGE_PRICE });
  });

  it('服务重启初始化时不会覆盖管理员保存的 Pidoi Key', async () => {
    const pidoiChannel = db.select().from(channels).all().find(channel => channel.baseUrl.includes('pidoi.com') && channel.name.includes('图片'))!;
    const adminKey = 'sk-admin-configured-pidoi-key';
    db.update(channels).set({ apiKey: adminKey, status: 1 }).where(eq(channels.id, pidoiChannel.id)).run();

    await initDatabase();

    expect(db.select().from(channels).where(eq(channels.id, pidoiChannel.id)).get())
      .toMatchObject({ apiKey: adminKey, status: 1 });
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
