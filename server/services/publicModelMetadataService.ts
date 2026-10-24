import { publicApiModelId } from '../../shared/funAi.js';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { settings } from '../db/schema.js';

const REVIEW_KEY = 'public_synced_model_reviews_v1';
type PublicModel = { id: number; modelId: string; description: string | null };

/** Historic channel imports had no separate provenance field. Match only their exact generated note. */
export function isChannelSyncDescription(value: string | null | undefined): boolean {
  return /^由\s+.+?\s*同步(?:[；;].*)?$/.test((value || '').trim());
}

export function reviewedPublicModelIds(database = db): Set<number> {
  const row = database.select().from(settings).where(eq(settings.key, REVIEW_KEY)).get();
  try { const value = JSON.parse(row?.value || '[]'); return new Set(Array.isArray(value) ? value.filter(Number.isSafeInteger) : []); }
  catch { return new Set(); }
}

export function recordPublicModelReview(id: number, enabled: boolean, database = db): void {
  const ids = reviewedPublicModelIds(database);
  if (enabled) ids.add(id); else ids.delete(id);
  database.insert(settings).values({ key: REVIEW_KEY, value: JSON.stringify([...ids]), label: '管理员确认的同步模型' })
    .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify([...ids]) } }).run();
}

export function isReviewedPublicModel(model: PublicModel, reviewedIds: Set<number>): boolean {
  return !isChannelSyncDescription(model.description) || reviewedIds.has(model.id);
}

/** API identifiers never depend on editable names, and generated provenance is never public copy. */
export function publicApiModelMetadata(model: Pick<PublicModel, 'modelId' | 'description'> & { provider?: string }, channelNames: string[] = []) {
  let description = isChannelSyncDescription(model.description) ? '' : model.description || '';
  const provider = model.provider && !['google', 'openai', 'anthropic', 'seedance', 'routing', 'test'].includes(model.provider) ? model.provider : '';
  for (const label of new Set([...channelNames, provider].filter(value => value?.trim()))) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    description = description.replace(new RegExp(escaped, 'gi'), '');
  }
  description = description.replace(/^[\s·；;,，:：-]+|[\s·；;,，:：-]+$/g, '').replace(/ {2,}/g, ' ');
  return { id: publicApiModelId(model.modelId), name: publicApiModelId(model.modelId), description };
}
