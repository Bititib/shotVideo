import { randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';
import { sqlite } from '../db/index.js';
import { env } from '../config/env.js';
import { BalanceService } from './balanceService.js';
import { VideoBatchStore } from './videoBatchStore.js';
import type { TierRequest } from '../middleware/tier.js';

export const batchStore = new VideoBatchStore(sqlite, {
  deduct: (userId, amount) => BalanceService.deductWithSource(userId, amount, 'video_batch_prededuct'),
  refund: (userId, amount, receipt) => { BalanceService.refundToSource(userId, amount, receipt.source, receipt.orgId, 'video_batch_refund'); },
  onReleased: (item, error) => {
    if (!item.content_id) return;
    const row = sqlite.prepare('SELECT metadata,status FROM contents WHERE id=?').get(item.content_id) as any;
    if (!row || row.status === 'completed') return;
    const meta = JSON.parse(row.metadata || '{}');
    const receipt = JSON.parse(item.receipt);
    Object.assign(meta, { billingStatus: 'refunded', queueRefunded: true, refundAmount: item.unit_cost,
      refundTarget: receipt.source === 'org' ? 'organization_balance' : 'user_balance', refundedAt: new Date().toISOString(),
      error: meta.error || error, failedAt: meta.failedAt || new Date().toISOString() });
    sqlite.prepare("UPDATE contents SET status='failed',cost=0,metadata=? WHERE id=?").run(JSON.stringify(meta), item.content_id);
  },
});
const internalSecret = randomBytes(32).toString('hex');
const liveDispatches = new Set<number>();
let started = false;
let ticking = false;
const concurrency = (value: string | undefined, fallback: number) => Math.max(1, Math.min(20, Number.parseInt(value || '', 10) || fallback));
const maxActive = concurrency(process.env.VIDEO_BATCH_MAX_ACTIVE, 6);
const maxPerUser = concurrency(process.env.VIDEO_BATCH_USER_ACTIVE, 3);

/** A browser body can never enable prepaid mode. Only this process's worker can. */
export function batchContextForRequest(req: TierRequest) {
  if (!req.headers['x-video-batch-key']) return null;
  if (req.headers['x-video-batch-key'] !== internalSecret) throw new Error('无效的批量任务凭证');
  return batchStore.context(Number(req.headers['x-video-batch-item']), Number(req.headers['x-video-batch-attempt']), req.userId!);
}

/** Returns true when this is a batch failure and the batch ledger owns settlement. */
export function recordBatchFailure(contentId: number, message: string, confirmed = false): boolean {
  const row = sqlite.prepare('SELECT metadata,status FROM contents WHERE id=?').get(contentId) as any;
  const meta = JSON.parse(row?.metadata || '{}');
  if (!meta.batchItemId) return false;
  const item = batchStore.item(meta.batchItemId);
  if (row.status === 'completed' || item?.content_id !== contentId || item?.billing_state !== 'reserved') return true;
  // Explicit submission rejection is safe; 408/5xx/network exceptions remain unknown.
  const rejected = /(?:提交失败|创建视频任务失败).*\((?:400|401|403|404|413|415|422|429)\)/i.test(message);
  confirmed = confirmed || rejected;
  meta.error = message;
  meta.batchConfirmedFailure = confirmed;
  meta.billingStatus = 'batch_reserved';
  if (confirmed) meta.failedAt = new Date().toISOString();
  else meta.progressText = '上游结果待核实，不会重复生成，请联系管理员核实';
  sqlite.prepare('UPDATE contents SET status=?,cost=0,metadata=? WHERE id=?')
    .run(confirmed ? 'failed' : 'review', JSON.stringify(meta), contentId);
  // Reconciliation owns refund/retry; no balance change here.
  return true;
}

export function isBatchChannelAtCapacity(channel: any) {
  if (!channel?.id || channel.type === 'hmstudio') return false; // HM has its own persistent-task queue.
  const records = sqlite.prepare("SELECT metadata FROM contents WHERE type='video' AND status IN ('processing','queued','review')").all() as any[];
  const load = records.filter(r => {
    try { const m = JSON.parse(r.metadata || '{}'); return Number(m.channelId) === Number(channel.id); } catch { return false; }
  }).length;
  return load >= Math.max(1, Number(channel.concurrencyLimit) || 1);
}

/** A durable marker must precede any upstream POST to prevent resubmission after a crash. */
export function markBatchSubmitting(contentId: number | null): boolean {
  if (!contentId) return true;
  const row = sqlite.prepare('SELECT metadata FROM contents WHERE id=?').get(contentId) as any;
  const meta = JSON.parse(row?.metadata || '{}');
  if (!meta.batchItemId) return true;
  if (meta.batchSubmissionStarted) return false;
  meta.batchSubmissionStarted = new Date().toISOString();
  sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?').run(JSON.stringify(meta), contentId);
  return true;
}

export function noteBatchQueryProblem(contentId: number, message: string) {
  const row = sqlite.prepare('SELECT metadata FROM contents WHERE id=?').get(contentId) as any;
  const meta = JSON.parse(row?.metadata || '{}');
  if (!meta.batchItemId) return;
  meta.progressText = message;
  sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?').run(JSON.stringify(meta), contentId);
}

async function dispatch(item: any) {
  liveDispatches.add(item.id);
  try {
    const context = batchStore.context(item.id, item.attempts, item.user_id);
    const user = sqlite.prepare('SELECT id,role,org_id,is_active FROM users WHERE id=?').get(item.user_id) as any;
    if (!user?.is_active) { batchStore.fail(item.id, '账号已停用', false, true); return; }
    const token = jwt.sign({ userId: user.id, role: user.role, orgId: user.org_id }, env.JWT_SECRET, { expiresIn: '10m' });
    const origin = new URL(context.batch.public_origin);
    const response = await fetch(`http://127.0.0.1:${env.PORT}/api/video/generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        Host: origin.host, 'X-Forwarded-Proto': origin.protocol.slice(0, -1),
        'X-Video-Batch-Key': internalSecret, 'X-Video-Batch-Item': String(item.id), 'X-Video-Batch-Attempt': String(item.attempts) },
      body: JSON.stringify(context.body),
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) {
      const body: any = await response.json().catch(() => ({}));
      if (body.code === 'BATCH_CAPACITY' && !batchStore.item(item.id)?.content_id) { batchStore.defer(item.id); return; }
      if (!batchStore.item(item.id)?.content_id) batchStore.fail(item.id, body.error || `提交校验失败 (${response.status})`, false, true);
      return;
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('提交未返回任务流');
    const decoder = new TextDecoder(); let buffer = ''; let message = '提交未创建任务';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
          let event: any; try { event = JSON.parse(line.slice(6)); } catch { continue; }
          if (event.type === 'error') message = event.message || message;
          if (event.contentId) return; // Content/queue state is durable; don't hold a connection for the whole generation.
        }
      }
      if (!batchStore.item(item.id)?.content_id) batchStore.fail(item.id, message, false, true);
    } finally { await reader.cancel().catch(() => {}); }
  } catch (error: any) {
    // No content means no upstream POST was possible. Invalidating this claim also
    // prevents a late internal HTTP handler from attaching a record after refund.
    if (!batchStore.item(item.id)?.content_id) batchStore.fail(item.id, error.message || '提交中断', false, true);
  } finally { liveDispatches.delete(item.id); }
}

function reconcile() {
  const active = sqlite.prepare("SELECT * FROM video_batch_items WHERE status IN ('dispatching','running','review')").all() as any[];
  for (const i of active) {
    if (!i.content_id) {
      if (!liveDispatches.has(i.id)) batchStore.fail(i.id, '提交中断，未向上游创建任务', false, true);
      continue;
    }
    const c = sqlite.prepare('SELECT * FROM contents WHERE id=?').get(i.content_id) as any;
    if (!c) { batchStore.fail(i.id, '生成记录不存在，请联系管理员核实'); continue; }
    const meta = JSON.parse(c.metadata || '{}');
    if (c.status === 'completed' && c.result_url) {
      batchStore.complete(i.id, c.id, c.result_url, () => {
        const receipt = JSON.parse(i.receipt);
        Object.assign(meta, { billingStatus: 'charged', billingBalanceSource: receipt.source, billingOrgId: receipt.orgId, batchSettled: true });
        sqlite.prepare('UPDATE contents SET cost=?,metadata=? WHERE id=?').run(i.unit_cost, JSON.stringify(meta), c.id);
      });
    } else if (c.status === 'failed') {
      batchStore.fail(i.id, meta.error || '上游生成失败', meta.batchConfirmedFailure === true);
      const settled = batchStore.item(i.id);
      const refunded = settled.billing_state === 'refunded';
      if (!refunded) {
        Object.assign(meta, { billingStatus: 'batch_reserved', queueRefunded: false, refundAmount: 0 });
        sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?').run(JSON.stringify(meta), c.id);
      }
    } else if (c.status === 'review') {
      batchStore.fail(i.id, meta.error || '上游响应不确定');
    }
  }
}

/** Existing admin recovery may retrieve a reserved batch result, but must not
 * charge it again or revive a previous attempt after a replacement was started. */
export function settleRecoveredBatch(contentId: number, resultUrl: string): boolean {
  const c = sqlite.prepare('SELECT metadata FROM contents WHERE id=?').get(contentId) as any;
  const meta = JSON.parse(c?.metadata || '{}');
  if (!meta.batchItemId) return false;
  const item = batchStore.item(meta.batchItemId);
  if (!item || item.content_id !== contentId || !['running', 'review'].includes(item.status) || item.billing_state !== 'reserved') {
    throw new Error('该批量任务已结算或已替换，禁止从历史尝试再次补扣费用');
  }
  batchStore.complete(item.id, contentId, resultUrl, () => {
    const receipt = JSON.parse(item.receipt);
    Object.assign(meta, { billingStatus: 'charged', batchSettled: true, progress: 100, completedAt: new Date().toISOString(),
      billingBalanceSource: receipt.source, billingOrgId: receipt.orgId });
    sqlite.prepare("UPDATE contents SET status='completed',result_url=?,cost=?,metadata=? WHERE id=?")
      .run(resultUrl, item.unit_cost, JSON.stringify(meta), contentId);
  });
  return true;
}

export function tickVideoBatches() {
  if (ticking) return;
  ticking = true;
  try {
    reconcile();
    // Bounded parallelism; the generation route also checks non-HM channel
    // capacity, while the existing HM queue enforces key/pool/user limits.
    const running = sqlite.prepare(`SELECT i.user_id,b.model FROM video_batch_items i JOIN video_batches b ON b.id=i.batch_id
      WHERE i.status IN ('dispatching','running','review')`).all() as any[];
    const pending = sqlite.prepare(`SELECT i.id,i.user_id,b.model FROM video_batch_items i JOIN video_batches b ON b.id=i.batch_id
      WHERE i.status IN ('queued','retry_wait') AND i.next_run<=? ORDER BY i.next_run,i.id`).all(Date.now()) as any[];
    for (const p of pending) {
      if (running.length >= maxActive) break;
      if (running.filter(r => r.user_id === p.user_id).length >= maxPerUser) continue;
      const claimed = batchStore.claim(p.id);
      if (claimed) { running.push(p); void dispatch(claimed); }
    }
  } catch (error) { console.error('[video-batch] scheduler:', error); }
  finally { ticking = false; }
}

export function startVideoBatchWorker() {
  if (started) return;
  started = true;
  const interrupted = sqlite.prepare(`SELECT c.id,c.metadata,c.status FROM contents c JOIN video_batch_items i ON i.content_id=c.id
    WHERE i.billing_state='reserved' AND c.status IN ('processing','queued')`).all() as any[];
  for (const c of interrupted) {
    const meta = JSON.parse(c.metadata || '{}');
    if (meta.batchSubmissionStarted && !meta.videoId) recordBatchFailure(c.id, '服务器重启前的提交未能保存上游任务 ID，请联系管理员核实');
    else if (!meta.batchSubmissionStarted && !meta.videoId && c.status !== 'queued') {
      batchStore.fail(meta.batchItemId, '服务器重启，任务尚未提交上游，已退款', false, true);
      sqlite.prepare("UPDATE contents SET status='failed',cost=0 WHERE id=?").run(c.id);
    }
  }
  tickVideoBatches();
  setInterval(tickVideoBatches, 5000).unref();
}
