import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { contents } from '../db/schema.js';
import { findVideoSubmissionReceipt } from './videoSubmissionReceiptService.js';
import { finalizeLegacyVideo } from './legacyVideoBilling.js';
import { videoSubmissionPending } from './videoSubmissionGuard.js';
import { isTaskIdPlaceholder } from '../../shared/upstreamTaskId.js';

/** Metadata task IDs only: a request/trace ID is not necessarily a polling ID. */
export function savedVideoTaskId(metadata: Record<string, any>): string {
  for (const key of ['videoId', 'upstreamTaskId', 'taskId', 'task_id']) {
    const value = metadata[key];
    if ((typeof value === 'string' || typeof value === 'number') && String(value).trim() && !isTaskIdPlaceholder(value)) {
      return String(value).trim();
    }
  }
  return '';
}

/** Never make a recovery decision using a caller's potentially stale snapshot. */
export function readVideoRecoveryState(contentId: number) {
  return sqlite.transaction(() => {
    const record = db.select().from(contents).where(eq(contents.id, contentId)).get();
    if (!record) return undefined;
    if (!['processing', 'queued', 'review'].includes(record.status || '')) return record;
    let metadata: Record<string, any>;
    try { metadata = JSON.parse(record.metadata || '{}'); if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined; }
    catch { console.error('[video-recover] Invalid metadata, skipping task', contentId); return undefined; }
    if (metadata.managedSpecification) return record;
    let taskId = savedVideoTaskId(metadata);
    const receipt = !taskId ? findVideoSubmissionReceipt(contentId) : null;
    taskId ||= receipt?.upstreamTaskId || '';
    if (!taskId) return record;
    const resumeMissingIdReview = record.status === 'review'
      && metadata.missingTaskIdReview === true && !metadata.billingShortfall;
    const status = resumeMissingIdReview ? 'processing' : record.status;
    const updated = {
      ...metadata,
      videoId: taskId,
      upstreamTaskId: taskId,
      ...(receipt ? {
        channelId: metadata.channelId || receipt.channelId || undefined,
        channelApiKeyId: metadata.channelApiKeyId || receipt.channelApiKeyId || undefined,
        submissionReceiptRecovered: true,
      } : {}),
      ...(resumeMissingIdReview ? {
        missingTaskIdReview: false, requiresReview: false, queueStatus: 'running',
        progressText: '已恢复任务编号，正在查询原任务', error: undefined,
      } : {}),
    };
    const serialized = JSON.stringify(updated);
    if (serialized !== record.metadata || status !== record.status) {
      db.update(contents).set({ metadata: serialized, status }).where(eq(contents.id, contentId)).run();
    }
    return { ...record, status, metadata: serialized };
  })();
}

/** Missing local evidence is not an upstream failure and must never refund. */
export function reviewMissingVideoTaskId(contentId: number): void {
  sqlite.transaction(() => {
    const record = readVideoRecoveryState(contentId);
    if (!record || !['processing', 'review'].includes(record.status || '')) return;
    const metadata = JSON.parse(record.metadata || '{}');
    if (savedVideoTaskId(metadata) || videoSubmissionPending(contentId, metadata)) return;
    const message = metadata.error || '上游任务编号待核实，请勿重复提交';
    const patch = {
      missingTaskIdReview: true, requiresReview: true, reviewKind: 'submission', queueStatus: 'review',
      progressText: message, error: message,
    };
    if (finalizeLegacyVideo(contentId, 'review', patch)) return;
    db.update(contents).set({
      status: 'review', metadata: JSON.stringify({ ...metadata, ...patch }),
    }).where(eq(contents.id, contentId)).run();
  })();
}

/** Query/transport errors must not settle a task whose upstream outcome is unknown. */
export function reviewUncertainVideoTask(contentId: number, message: string, kind: 'submission' | 'query' | 'settlement' | 'local' = 'submission', knownTaskId?: string): void {
  sqlite.transaction(() => {
    const record = db.select().from(contents).where(eq(contents.id, contentId)).get();
    if (!record || ['completed', 'failed'].includes(record.status || '')) return;
    const metadata = JSON.parse(record.metadata || '{}');
    const patch = { requiresReview: true, reviewKind: kind, progressText: message, error: message,
      ...(knownTaskId ? { videoId: knownTaskId, upstreamTaskId: knownTaskId } : {}) };
    if (finalizeLegacyVideo(contentId, 'review', patch)) return;
    db.update(contents).set({ status: 'review', metadata: JSON.stringify({ ...metadata, ...patch }) })
      .where(eq(contents.id, contentId)).run();
  })();
}
