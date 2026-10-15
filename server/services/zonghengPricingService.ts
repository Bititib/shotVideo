import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { models, modelPricing } from '../db/schema.js';

/** Price discovered models only. Later administrator edits remain authoritative. */
export function ensureZonghengVideoPricing() {
  const defaults = [
    { modelId: 'ZH-MMseadanco2.5-PRO', price: 4 },
    { modelId: 'ZH-sedanco2.0-300秒必出', price: 2.5 },
  ];
  for (const { modelId, price } of defaults) {
    if (!db.select().from(models).where(eq(models.modelId, modelId)).get()) continue;
    if (db.select().from(modelPricing).where(eq(modelPricing.modelPattern, modelId)).get()) continue;
    db.insert(modelPricing).values({
      modelPattern: modelId,
      billingType: 'per_call',
      inputPrice: price,
      outputPrice: 0,
      extraParams: JSON.stringify({ category: 'video', '720p': price }),
    }).run();
  }
}
