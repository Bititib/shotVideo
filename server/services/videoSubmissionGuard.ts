import { randomUUID } from 'node:crypto';
import { sqlite } from '../db/index.js';
import { persistVideoSubmissionReceipt, findVideoSubmissionReceipt } from './videoSubmissionReceiptService.js';

const submitting = new Set<number>();
export class VideoSubmissionConflictError extends Error {
  readonly code = 'VIDEO_SUBMISSION_CONFLICT';
}
export function videoSubmissionPreparation() {
  return { videoSubmissionState: 'preparing', videoSubmissionDeadline: Date.now() + 5 * 60_000 };
}
export function videoSubmissionPending(id: number, meta: Record<string, any>): boolean {
  return ['preparing', 'submitting'].includes(meta.videoSubmissionState)
    && (submitting.has(id) || Number(meta.videoSubmissionDeadline) > Date.now());
}

/** Claim before the first await that can send a paid generation request. */
export function claimVideoSubmission(id: number, timeoutMs = 120_000): void {
  sqlite.transaction(() => {
    const row = sqlite.prepare('SELECT status,metadata FROM contents WHERE id=?').get(id) as any;
    if (!row || ['completed', 'failed'].includes(row.status)) throw new Error('任务已结束，禁止重复提交');
    const meta = JSON.parse(row.metadata || '{}');
    if (['videoId', 'upstreamTaskId', 'taskId', 'task_id'].some(key => meta[key]) || findVideoSubmissionReceipt(id)
      || meta.videoSubmissionState && !['preparing', 'rejected'].includes(meta.videoSubmissionState)) {
      throw new VideoSubmissionConflictError('任务已提交或提交结果待核实，禁止重复提交');
    }
    Object.assign(meta, { videoSubmissionState: 'submitting', videoSubmissionAttempt: randomUUID(),
      videoSubmissionStartedAt: new Date().toISOString(), videoSubmissionDeadline: Date.now() + Math.max(120_000, timeoutMs) + 30_000 });
    sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?').run(JSON.stringify(meta), id);
  }).immediate();
  submitting.add(id);
}

export function releaseVideoSubmission(id: number): void { submitting.delete(id); }

/** Only a confirmed rejection permits a different route to submit this content. */
export function endVideoSubmission(id: number, state: 'unknown' | 'rejected'): void {
  sqlite.transaction(() => {
    const row = sqlite.prepare('SELECT metadata FROM contents WHERE id=?').get(id) as any;
    if (!row) return;
    const meta = JSON.parse(row.metadata || '{}');
    if (!['preparing', 'submitting'].includes(meta.videoSubmissionState)) return;
    meta.videoSubmissionState = state;
    sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?').run(JSON.stringify(meta), id);
  })();
  submitting.delete(id);
}

/** Receipt, canonical ID and generation state become visible in one commit. */
export function acceptVideoSubmission(id: number, taskId: string, context: {
  provider: string; channelId: number | null; channelApiKeyId?: number | null;
}): void {
  sqlite.transaction(() => {
    const row = sqlite.prepare('SELECT status,metadata FROM contents WHERE id=?').get(id) as any;
    if (!row || ['failed', 'completed'].includes(row.status)) throw new Error('任务已结束，停止自动恢复和结算');
    const meta = JSON.parse(row.metadata || '{}');
    const saved = meta.videoId || meta.upstreamTaskId;
    if (saved && String(saved) !== taskId) throw new Error('上游任务编号冲突，请人工核实');
    persistVideoSubmissionReceipt({ contentId: id, upstreamTaskId: taskId, channelId: context.channelId,
      channelApiKeyId: context.channelApiKeyId ?? null, provider: context.provider });
    Object.assign(meta, { videoId: taskId, upstreamTaskId: taskId, videoSubmissionState: 'accepted',
      channelId: context.channelId, channelApiKeyId: context.channelApiKeyId ?? null,
      missingTaskIdReview: false, requiresReview: false, reviewKind: null, upstreamQueryError: null });
    sqlite.prepare("UPDATE contents SET status='processing',metadata=? WHERE id=?").run(JSON.stringify(meta), id);
  }).immediate();
  submitting.delete(id);
}
