import { db } from '../db/index.js';
import { contents } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export function protectsVideoPolling(channel: { baseUrl?: string | null } | null, metadata: Record<string, any> = {}) {
  if (metadata.batchItemId || metadata.managedSpecification) return false;
  if (metadata.recoveryPollingProtected) return true;
  if (metadata.videoId || metadata.upstreamTaskId) return true;
  try { return ['llm.chre3.com', 'llm.domie.studio'].includes(new URL(channel?.baseUrl || '').hostname.toLowerCase()); }
  catch { return false; }
}

export function clearVideoQueryProblem(contentId: number) {
  const record = db.select().from(contents).where(eq(contents.id, contentId)).get();
  if (!record || record.status !== 'processing') return;
  const metadata = JSON.parse(record.metadata || '{}');
  if (!metadata.upstreamQueryError) return;
  metadata.upstreamQueryError = null;
  if (metadata.reviewKind === 'query' && !metadata.requiresReview) metadata.reviewKind = null;
  db.update(contents).set({ metadata: JSON.stringify(metadata) }).where(eq(contents.id, contentId)).run();
}

/** Never refunds an accepted task because its GET or download is unavailable. */
export function noteVideoQueryProblem(contentId: number, message: string, pause = false) {
  const record = db.select().from(contents).where(eq(contents.id, contentId)).get();
  if (!record || !['processing', 'review'].includes(record.status)) return;
  const metadata = JSON.parse(record.metadata || '{}');
  const now = new Date().toISOString();
  Object.assign(metadata, { recoveryPollingProtected: true, upstreamQueryError: message, upstreamQueryErrorAt: now,
    progressText: pause ? '原任务查询已暂停，请管理员恢复；未判定生成失败、未退款' : '上游查询暂不可用，继续查询原任务；不会重新生成或退款' });
  if (pause) Object.assign(metadata, { requiresReview: true, reviewKind: 'query', recoveryPollPausedAt: now });
  db.update(contents).set({ status: pause ? 'review' : record.status, metadata: JSON.stringify(metadata) }).where(eq(contents.id, contentId)).run();
}
