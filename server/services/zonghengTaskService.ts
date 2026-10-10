import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { contents } from '../db/schema.js';
import { recordBatchFailure } from './videoBatchService.js';
export function patchZonghengTask(id: number, patch: Record<string, unknown>) {
  const row = db.select().from(contents).where(eq(contents.id, id)).get();
  if (!row) throw new Error('纵横科技本地任务不存在，停止提交');
  db.update(contents).set({ metadata: JSON.stringify({ ...JSON.parse(row.metadata || '{}'), ...patch }) }).where(eq(contents.id, id)).run();
}
export function zonghengOrder(id: number): string {
  const row = db.select().from(contents).where(eq(contents.id,id)).get();
  if (!row) throw new Error('本地任务不存在');
  const key = JSON.parse(row.metadata || '{}').zonghengOrderId || randomUUID();
  patchZonghengTask(id, { zonghengOrderId: key }); return key;
}
export function reviewZonghengTask(id: number, message: string) {
  if (recordBatchFailure(id, message, false)) return;
  const row = db.select().from(contents).where(eq(contents.id,id)).get();
  if (!row || row.status === 'completed') return;
  db.update(contents).set({ status: 'review', metadata: JSON.stringify({ ...JSON.parse(row.metadata || '{}'), requiresReview: true, progressText: message }) }).where(eq(contents.id,id)).run();
}
