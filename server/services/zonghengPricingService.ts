import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { models, modelPricing } from '../db/schema.js';

/** Price discovered models only. Later administrator edits remain authoritative. */
export function ensureZonghengVideoPricing() {
  const modelId = 'ZH-MMseadanco2.5-PRO';
  if (!db.select().from(models).where(eq(models.modelId, modelId)).get()) return;
  if (db.select().from(modelPricing).where(eq(modelPricing.modelPattern, modelId)).get()) return;
  db.insert(modelPricing).values({
    modelPattern: modelId,
    billingType: 'per_call',
    inputPrice: 4,
    outputPrice: 0,
    extraParams: JSON.stringify({ category: 'video', '720p': 4 }),
  }).run();
}
