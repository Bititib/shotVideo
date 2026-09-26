import type Database from 'better-sqlite3';
import type { VideoBatchInput } from '../../shared/videoBatch.js';

type Receipt = { source: 'user' | 'org'; orgId?: number };
export interface BatchLedger {
  deduct(userId: number, amount: number): Receipt | null;
  refund(userId: number, amount: number, receipt: Receipt): void;
  onReleased?(item: any, error: string): void;
}
export const BATCH_ACTIVE = ['dispatching', 'running', 'review'];
const permanentFailure = /提示词|5000|审核|违规|敏感|不支持|不允许|参数|格式|鉴权|余额不足|未配置|\((?:400|401|403|404|413|415|422)\)|素材.*(无效|错误)|invalid|moderation|policy|unsupported|permission|unauthorized/i;
export function canRetryBatchFailure(message: string, confirmedFailure: boolean) {
  return confirmedFailure && !permanentFailure.test(message);
}
export function isBatchQueryUncertain(payload: any, normalizedStatus: unknown) {
  const values = [payload, payload?.data, payload?.error].filter(v => v && typeof v === 'object');
  if (values.some(v => [v.status_code, v.statusCode, v.http_status, v.httpStatus, v.code].some(code => Number(code) >= 400 && Number(code) <= 599))) return true;
  return !['failed', 'failure', 'error', 'errored', 'rejected', 'cancelled', 'canceled', 'expired', 'terminated'].includes(String(normalizedStatus).toLowerCase());
}
export function guardBatchSubmissionResponse(batch: boolean, response: { status: number }) {
  if (batch && (response.status >= 500 || response.status === 408 || response.status === 425)) {
    throw new Error(`上游提交结果不确定 (${response.status})，暂不切换线路或重复生成，请核实原任务`);
  }
}

/** All monetary transitions use the SAME SQLite transaction as item state changes. */
export class VideoBatchStore {
  constructor(public sql: Database.Database, private ledger: BatchLedger) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS video_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, request_key TEXT NOT NULL,
        name TEXT NOT NULL, model TEXT NOT NULL, payload TEXT NOT NULL, public_origin TEXT NOT NULL,
        total INTEGER NOT NULL, auto_retry INTEGER NOT NULL, max_retries INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(user_id, request_key)
      );
      CREATE TABLE IF NOT EXISTS video_batch_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
        creative_index INTEGER NOT NULL, ordinal INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0,
        unit_cost REAL NOT NULL, charged REAL NOT NULL DEFAULT 0, billing_state TEXT NOT NULL DEFAULT 'reserved',
        receipt TEXT NOT NULL, content_id INTEGER, result_url TEXT, error TEXT, next_run INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT, finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS video_batch_items_schedule ON video_batch_items(status,next_run);
      CREATE INDEX IF NOT EXISTS video_batch_items_batch ON video_batch_items(batch_id);
      CREATE INDEX IF NOT EXISTS video_batches_user ON video_batches(user_id,id);
      CREATE TABLE IF NOT EXISTS video_batch_attempts (
        item_id INTEGER NOT NULL, attempt INTEGER NOT NULL, content_id INTEGER UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(item_id,attempt)
      );
      CREATE TABLE IF NOT EXISTS video_batch_commands (
        user_id INTEGER NOT NULL, request_key TEXT NOT NULL, batch_id INTEGER NOT NULL, amount REAL NOT NULL,
        PRIMARY KEY(user_id,request_key)
      );
    `);
  }
  item(id: number): any { return this.sql.prepare('SELECT * FROM video_batch_items WHERE id=?').get(id); }
  batch(id: number, userId: number): any {
    const row = this.sql.prepare('SELECT * FROM video_batches WHERE id=? AND user_id=?').get(id, userId);
    if (!row) throw new Error('批次不存在或无权访问');
    return row;
  }
  existing(userId: number, key: string): any {
    return this.sql.prepare('SELECT id FROM video_batches WHERE user_id=? AND request_key=?').get(userId, key);
  }
  create(userId: number, key: string, input: VideoBatchInput, unitCost: number, origin: string) {
    return this.sql.transaction(() => {
      const old = this.existing(userId, key);
      if (old) return old.id as number;
      const total = input.creatives.reduce((n, c) => n + c.count, 0);
      const amount = Math.round(unitCost * total * 1e6) / 1e6;
      const receipt = this.ledger.deduct(userId, amount);
      if (!receipt) throw new Error('余额不足，无法预扣整个批次的费用');
      const id = Number(this.sql.prepare(`INSERT INTO video_batches
        (user_id,request_key,name,model,payload,public_origin,total,auto_retry,max_retries) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(userId, key, input.name, input.model, JSON.stringify(input), origin, total, +input.autoRetry, input.maxRetries).lastInsertRowid);
      const insert = this.sql.prepare(`INSERT INTO video_batch_items
        (batch_id,user_id,creative_index,ordinal,unit_cost,receipt) VALUES (?,?,?,?,?,?)`);
      input.creatives.forEach((c, index) => {
        for (let ordinal = 1; ordinal <= c.count; ordinal++) insert.run(id, userId, index, ordinal, unitCost, JSON.stringify(receipt));
      });
      return id;
    }).immediate();
  }
  detail(id: number, userId: number) {
    const b = this.batch(id, userId);
    const items = this.sql.prepare(`SELECT id,creative_index,ordinal,status,attempts,retry_count,unit_cost,charged,
      billing_state,content_id,result_url,error,created_at,started_at,finished_at FROM video_batch_items WHERE batch_id=? ORDER BY id`).all(id) as any[];
    const sum = (state: string) => Math.round(items.filter(i => i.billing_state === state).reduce((n, i) => n + i.unit_cost, 0) * 1e6) / 1e6;
    return { id: b.id, name: b.name, model: b.model, total: b.total, auto_retry: b.auto_retry, max_retries: b.max_retries,
      created_at: b.created_at, reserved: sum('reserved'), spent: sum('charged'), refunded: sum('refunded'), items };
  }
  claim(id: number): any {
    return this.sql.transaction(() => {
      const updated = this.sql.prepare(`UPDATE video_batch_items SET status='dispatching',attempts=attempts+1,
        content_id=NULL,error=NULL,started_at=COALESCE(started_at,datetime('now'))
        WHERE id=? AND status IN ('queued','retry_wait') AND next_run<=? AND billing_state='reserved'`).run(id, Date.now());
      if (!updated.changes) return null;
      const item = this.item(id);
      this.sql.prepare('INSERT INTO video_batch_attempts(item_id,attempt) VALUES (?,?)').run(id, item.attempts);
      return item;
    }).immediate();
  }
  defer(id: number) {
    this.sql.prepare(`UPDATE video_batch_items SET status='queued',next_run=?,error='渠道正在忙，等待空闲容量'
      WHERE id=? AND status='dispatching' AND content_id IS NULL AND billing_state='reserved'`).run(Date.now() + 15000, id);
  }
  context(id: number, attempt: number, userId: number): any {
    const i = this.item(id);
    if (!i || i.user_id !== userId || i.attempts !== attempt || i.status !== 'dispatching' || i.content_id || i.billing_state !== 'reserved') {
      throw new Error('批量任务已处理或不可提交');
    }
    const b = this.batch(i.batch_id, userId);
    const payload: VideoBatchInput = JSON.parse(b.payload);
    const { creatives, name, autoRetry, maxRetries, ...settings } = payload;
    const { count, ...creative } = creatives[i.creative_index];
    return { item: i, batch: b, body: { ...settings, ...creative } };
  }
  attach(id: number, attempt: number, userId: number, save: () => number): number {
    return this.sql.transaction(() => {
      this.context(id, attempt, userId);
      const contentId = save();
      this.sql.prepare("UPDATE video_batch_items SET content_id=?,status='running' WHERE id=?").run(contentId, id);
      this.sql.prepare('UPDATE video_batch_attempts SET content_id=? WHERE item_id=? AND attempt=?').run(contentId, id, attempt);
      return contentId;
    }).immediate();
  }
  private release(i: any, status: 'failed' | 'cancelled', error: string) {
    if (i.billing_state !== 'reserved') return;
    this.ledger.refund(i.user_id, i.unit_cost, JSON.parse(i.receipt));
    this.sql.prepare(`UPDATE video_batch_items SET status=?,billing_state='refunded',error=?,finished_at=datetime('now') WHERE id=?`)
      .run(status, error, i.id);
    this.ledger.onReleased?.(i, error);
  }
  fail(id: number, error: string, confirmedFailure = false, safeRejection = false) {
    this.sql.transaction(() => {
      const i = this.item(id);
      if (!i || !BATCH_ACTIVE.includes(i.status) || i.billing_state !== 'reserved') return;
      if (!confirmedFailure && !safeRejection) {
        this.sql.prepare("UPDATE video_batch_items SET status='review',error=? WHERE id=?")
          .run(`结果待核实，不会重复提交；预扣费用仍保留。${error}`, id);
        return;
      }
      const b = this.batch(i.batch_id, i.user_id);
      if (b.auto_retry && i.retry_count < b.max_retries && canRetryBatchFailure(error, confirmedFailure)) {
        this.sql.prepare(`UPDATE video_batch_items SET status='retry_wait',retry_count=retry_count+1,next_run=?,error=? WHERE id=?`)
          .run(Date.now() + Math.min(120000, 30000 * 2 ** i.retry_count), error, id);
      } else this.release(i, 'failed', error);
    }).immediate();
  }
  complete(id: number, contentId: number, resultUrl: string, updateContent: () => void) {
    this.sql.transaction(() => {
      const i = this.item(id);
      if (!i || !BATCH_ACTIVE.includes(i.status) || i.content_id !== contentId || i.billing_state !== 'reserved' || !resultUrl) return;
      updateContent();
      this.sql.prepare(`UPDATE video_batch_items SET status='completed',billing_state='charged',charged=unit_cost,
        result_url=?,error=NULL,finished_at=datetime('now') WHERE id=?`).run(resultUrl, id);
    }).immediate();
  }
  cancelPending(batchId: number, userId: number) {
    this.sql.transaction(() => {
      this.batch(batchId, userId);
      const pending = this.sql.prepare("SELECT * FROM video_batch_items WHERE batch_id=? AND status IN ('queued','retry_wait')").all(batchId) as any[];
      pending.forEach(i => this.release(i, 'cancelled', '用户取消未开始任务'));
      this.sql.prepare('UPDATE video_batches SET auto_retry=0 WHERE id=?').run(batchId);
    }).immediate();
  }
  stopRetries(batchId: number, userId: number) {
    this.sql.transaction(() => {
      this.batch(batchId, userId);
      this.sql.prepare('UPDATE video_batches SET auto_retry=0 WHERE id=?').run(batchId);
      const waiting = this.sql.prepare("SELECT * FROM video_batch_items WHERE batch_id=? AND status='retry_wait'").all(batchId) as any[];
      waiting.forEach(i => this.release(i, 'failed', '已关闭自动重试'));
    }).immediate();
  }
  retryFailed(batchId: number, userId: number, requestKey: string) {
    return this.sql.transaction(() => {
      this.batch(batchId, userId);
      const previous = this.sql.prepare('SELECT * FROM video_batch_commands WHERE user_id=? AND request_key=?').get(userId, requestKey) as any;
      if (previous) {
        if (previous.batch_id !== batchId) throw new Error('操作标识已用于其他批次');
        return previous.amount;
      }
      const failed = this.sql.prepare("SELECT * FROM video_batch_items WHERE batch_id=? AND status='failed' AND billing_state='refunded'").all(batchId) as any[];
      if (!failed.length) return 0;
      const amount = Math.round(failed.reduce((n, i) => n + i.unit_cost, 0) * 1e6) / 1e6;
      const receipt = this.ledger.deduct(userId, amount);
      if (!receipt) throw new Error('余额不足，无法重新预扣失败任务费用');
      const reset = this.sql.prepare(`UPDATE video_batch_items SET status='queued',billing_state='reserved',receipt=?,
        retry_count=0,content_id=NULL,error=NULL,next_run=0,started_at=NULL,finished_at=NULL WHERE id=?`);
      failed.forEach(i => reset.run(JSON.stringify(receipt), i.id));
      this.sql.prepare('INSERT INTO video_batch_commands(user_id,request_key,batch_id,amount) VALUES (?,?,?,?)').run(userId, requestKey, batchId, amount);
      return amount;
    }).immediate();
  }
}
