import { sqlite } from '../db/index.js';
import { V6kVideoContentError } from './v6kVideoContent.js';

/** Delivery loss is NOT generation failure. Never change balances, costs or reservation state here. */
export function recordV6kDeliveryUnavailable(contentId: number, error: unknown): boolean {
  if (!(error instanceof V6kVideoContentError) || error.status !== 410) return false;
  return sqlite.transaction(() => {
    const row = sqlite.prepare('SELECT type,status,metadata FROM contents WHERE id=?').get(contentId) as any;
    if (!row || row.type !== 'video' || !['processing','queued','review'].includes(row.status)) return true;
    const meta = JSON.parse(row.metadata || '{}');
    if (String(meta.videoId || meta.upstreamTaskId || '') !== error.taskId) throw new Error('成品错误与原任务编号不一致，停止更新');
    const message = error.message + '；成品获取失败，已暂停自动下载，请恢复原任务查询；未重新生成或扣退款';
    Object.assign(meta, { videoDeliveryUnavailable: true, upstreamStatus: 'completed', upstreamGenerated: true, upstreamDeliveryPending: false,
      requiresReview: true, reviewKind: 'local', error: message, resultSaveError: message, progressText: message,
      v6kDeliveryDiagnostics: { httpStatus: 410, code: error.upstreamCode, taskId: error.taskId, stage: 'download', recordedAt: new Date().toISOString() } });
    sqlite.prepare("UPDATE contents SET status='review',metadata=? WHERE id=?").run(JSON.stringify(meta), contentId);
    return true;
  }).immediate();
}

/** Called only after the original result has actually been saved. */
export function clearV6kDeliveryUnavailable(contentId: number) {
  const row = sqlite.prepare('SELECT metadata FROM contents WHERE id=?').get(contentId) as any;
  if (!row) return;
  const meta = JSON.parse(row.metadata || '{}');
  if (!meta.videoDeliveryUnavailable) return;
  delete meta.videoDeliveryUnavailable; delete meta.v6kDeliveryDiagnostics;
  delete meta.resultSaveError; delete meta.error; delete meta.progressText;
  if (meta.reviewKind === 'local') { delete meta.reviewKind; delete meta.requiresReview; }
  sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?').run(JSON.stringify(meta), contentId);
}
