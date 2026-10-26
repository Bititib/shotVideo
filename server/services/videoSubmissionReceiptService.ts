import { sqlite } from '../db/index.js';
import { isTaskIdPlaceholder } from '../../shared/upstreamTaskId.js';

export type VideoSubmissionReceipt = {
  contentId: number;
  upstreamTaskId: string;
  channelId: number | null;
  channelApiKeyId: number | null;
  provider: string;
};

function ensureTable() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS video_submission_receipts (
      content_id INTEGER PRIMARY KEY,
      upstream_task_id TEXT NOT NULL,
      channel_id INTEGER,
      channel_api_key_id INTEGER,
      provider TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_video_submission_receipts_task
      ON video_submission_receipts(upstream_task_id);
  `);
}

/**
 * Durable receipt written immediately after an upstream create response.
 * It is intentionally independent from contents.metadata so a later metadata
 * write failure or process restart cannot discard an already accepted task ID.
 */
export function persistVideoSubmissionReceipt(receipt: VideoSubmissionReceipt): void {
  if (!Number.isSafeInteger(receipt.contentId) || receipt.contentId <= 0) throw new Error('本地内容 ID 无效');
  if (!receipt.upstreamTaskId || isTaskIdPlaceholder(receipt.upstreamTaskId) || receipt.upstreamTaskId.length > 512 || /[\s\x00-\x1f]/.test(receipt.upstreamTaskId)
    || receipt.provider === 'snumom' && !/^task_[A-Za-z0-9_-]+$/.test(receipt.upstreamTaskId)) throw new Error('上游任务 ID 无效');
  ensureTable();
  const existing = sqlite.prepare('SELECT upstream_task_id FROM video_submission_receipts WHERE content_id=?').get(receipt.contentId) as any;
  if (existing && existing.upstream_task_id !== receipt.upstreamTaskId) throw new Error('上游任务编号冲突，请人工核实');
  sqlite.prepare(`
    INSERT INTO video_submission_receipts
      (content_id, upstream_task_id, channel_id, channel_api_key_id, provider)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(content_id) DO UPDATE SET
      upstream_task_id=excluded.upstream_task_id,
      channel_id=excluded.channel_id,
      channel_api_key_id=excluded.channel_api_key_id,
      provider=excluded.provider,
      updated_at=datetime('now')
  `).run(receipt.contentId, receipt.upstreamTaskId, receipt.channelId, receipt.channelApiKeyId, receipt.provider);
}

export function findVideoSubmissionReceipt(contentId: number): VideoSubmissionReceipt | null {
  if (!Number.isSafeInteger(contentId) || contentId <= 0) return null;
  ensureTable();
  const row = sqlite.prepare(`
    SELECT content_id, upstream_task_id, channel_id, channel_api_key_id, provider
    FROM video_submission_receipts WHERE content_id=?
  `).get(contentId) as any;
  return row && !isTaskIdPlaceholder(row.upstream_task_id) ? {
    contentId: Number(row.content_id),
    upstreamTaskId: String(row.upstream_task_id),
    channelId: row.channel_id === null ? null : Number(row.channel_id),
    channelApiKeyId: row.channel_api_key_id === null ? null : Number(row.channel_api_key_id),
    provider: String(row.provider || ''),
  } : null;
}
