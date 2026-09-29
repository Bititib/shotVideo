import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { contents } from '../db/schema.js';
import { recordBatchFailure } from './videoBatchService.js';

export function patchHayaTask(contentId: number, patch: Record<string, unknown>) {
  const record = db.select().from(contents).where(eq(contents.id, contentId)).get();
  if (!record) throw new Error('Haya 本地任务记录不存在，停止提交');
  const metadata = { ...JSON.parse(record.metadata || '{}'), ...patch };
  db.update(contents).set({ metadata: JSON.stringify(metadata) }).where(eq(contents.id, contentId)).run();
}

/** Keep the reservation and require reconciliation; a query/transport error is not a generation failure. */
export function reviewHayaTask(contentId: number, message: string) {
  if (recordBatchFailure(contentId, message)) return;
  const record = db.select().from(contents).where(eq(contents.id, contentId)).get();
  if (!record || record.status === 'completed') return;
  const metadata = { ...JSON.parse(record.metadata || '{}'), error: message, progressText: message, hayaNeedsReview: true };
  db.update(contents).set({ status: 'review', metadata: JSON.stringify(metadata) }).where(eq(contents.id, contentId)).run();
}
