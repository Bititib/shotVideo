import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface ApiVideoRequestRecord {
  id: string;
  tokenId: number;
  userId: number;
  fingerprint: string;
  contentId: number | null;
  responseStatus: number | null;
  responseBody: string | null;
  completedSeenAt: number | null;
}

export const AUTOMATIC_VIDEO_RETRY_WINDOW_MS = 10 * 60_000;

/** Never expire a paid request's identity or release it because a process/connection ended. */
export function createApiVideoRequestStore(database: Database.Database) {
  database.exec(`CREATE TABLE IF NOT EXISTS api_video_requests (
    id TEXT PRIMARY KEY, token_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    key_hash TEXT NOT NULL, fingerprint TEXT NOT NULL, content_id INTEGER,
    response_status INTEGER, response_body TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    request_mode TEXT NOT NULL DEFAULT 'legacy', completed_seen_at INTEGER,
    UNIQUE(token_id,user_id,key_hash), UNIQUE(content_id)
  )`);
  database.transaction(() => {
    const columns = database.prepare('PRAGMA table_info(api_video_requests)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'request_mode')) database.exec("ALTER TABLE api_video_requests ADD COLUMN request_mode TEXT NOT NULL DEFAULT 'legacy'");
    if (!columns.some(column => column.name === 'completed_seen_at')) database.exec('ALTER TABLE api_video_requests ADD COLUMN completed_seen_at INTEGER');
    database.exec('CREATE INDEX IF NOT EXISTS idx_api_video_requests_fingerprint ON api_video_requests(token_id,user_id,fingerprint,request_mode)');
  }).immediate();
  const projection = 'id,token_id AS tokenId,user_id AS userId,fingerprint,content_id AS contentId,response_status AS responseStatus,response_body AS responseBody,completed_seen_at AS completedSeenAt';
  const get = (id: string) => database.prepare(`SELECT ${projection} FROM api_video_requests WHERE id=?`).get(id) as ApiVideoRequestRecord | undefined;
  const claim = database.transaction((tokenId: number, userId: number, keyHash: string, fingerprint: string) => {
    const existing = database.prepare(`SELECT ${projection} FROM api_video_requests WHERE token_id=? AND user_id=? AND key_hash=?`)
      .get(tokenId, userId, keyHash) as ApiVideoRequestRecord | undefined;
    if (existing) return { fresh: false, mismatch: existing.fingerprint !== fingerprint, record: existing };
    const id = 'task_req_' + randomBytes(16).toString('hex');
    database.prepare("INSERT INTO api_video_requests(id,token_id,user_id,key_hash,fingerprint,request_mode) VALUES(?,?,?,?,?,'explicit')").run(id, tokenId, userId, keyHash, fingerprint);
    return { fresh: true, mismatch: false, record: get(id)! };
  });
  // Check only persisted local order/ledger state; provider errors are interpreted
  // by their adapters. Unknown acceptance never expires merely because time passed.
  function automaticProtection(record: ApiVideoRequestRecord, now: number): 'pending' | 'completed' | undefined {
    if (record.contentId === null) return record.responseStatus !== null && record.responseStatus >= 400 ? undefined : 'pending';
    const content = database.prepare('SELECT status,metadata FROM contents WHERE id=?').get(record.contentId) as any;
    if (!content) return 'pending'; // A deleted order is not proof it was never submitted.
    let metadata: any;
    try { metadata = JSON.parse(content.metadata); } catch { return 'pending'; }
    if (!metadata || typeof metadata !== 'object' || metadata.requiresReview || metadata.hayaNeedsReview
      || ['reserved', 'review'].includes(metadata.billingStatus)) return 'pending';
    if (metadata.billingReservationId) {
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='billing_reservations'").get()) return 'pending';
      const reservation = database.prepare('SELECT state FROM billing_reservations WHERE id=?').get(metadata.billingReservationId) as any;
      if (!reservation || !['settled', 'refunded'].includes(reservation.state)) return 'pending';
      if (content.status === 'failed') return reservation.state === 'refunded' ? undefined : 'pending';
    }
    if (content.status === 'failed') return metadata.billingStatus === 'refunded' || metadata.queueRefunded ? undefined : 'pending';
    if (content.status !== 'completed') return 'pending';
    const savedCompletion = Date.parse(metadata.completedAt);
    const completedAt = Number.isFinite(savedCompletion) ? savedCompletion : record.completedSeenAt ?? now;
    if (record.completedSeenAt === null) database.prepare('UPDATE api_video_requests SET completed_seen_at=? WHERE id=?').run(completedAt, record.id);
    return now - completedAt < AUTOMATIC_VIDEO_RETRY_WINDOW_MS ? 'completed' : undefined;
  }
  const claimAutomatic = database.transaction((tokenId: number, userId: number, fingerprint: string, now: number) => {
    const candidates = database.prepare(`SELECT ${projection} FROM api_video_requests WHERE token_id=? AND user_id=? AND fingerprint=? AND request_mode<>'explicit' ORDER BY rowid DESC`)
      .all(tokenId, userId, fingerprint) as ApiVideoRequestRecord[];
    let completed: ApiVideoRequestRecord | undefined;
    for (const record of candidates) {
      const protection = automaticProtection(record, now);
      if (protection === 'pending') return { fresh: false, mismatch: false, record };
      if (protection === 'completed' && !completed) completed = record;
    }
    if (completed) return { fresh: false, mismatch: false, record: completed };
    const id = 'task_req_' + randomBytes(16).toString('hex');
    database.prepare("INSERT INTO api_video_requests(id,token_id,user_id,key_hash,fingerprint,request_mode) VALUES(?,?,?,?,?,'automatic')")
      .run(id, tokenId, userId, randomBytes(32).toString('hex'), fingerprint);
    return { fresh: true, mismatch: false, record: get(id)! };
  });
  const link = database.transaction((requestId: string, contentId: number) => {
    const request = get(requestId);
    if (!request || request.contentId !== null && request.contentId !== contentId || request.responseStatus !== null)
      throw new Error('API 请求已处理或关联其他任务，禁止重复生成');
    const content = database.prepare('SELECT user_id,type,metadata FROM contents WHERE id=?').get(contentId) as any;
    let metadata: any = {};
    try { metadata = JSON.parse(content?.metadata || '{}'); } catch { /* invalid ownership fails below */ }
    if (!content || content.type !== 'video' || Number(metadata.tokenId) !== request.tokenId || request.userId > 0 && content.user_id !== request.userId)
      throw new Error('API 请求与视频任务归属不一致，停止提交');
    database.prepare('UPDATE api_video_requests SET content_id=? WHERE id=? AND (content_id IS NULL OR content_id=?)').run(contentId, requestId, contentId);
  });
  const finishWithoutContent = (id: string, status: number, body: string) => {
    database.prepare('UPDATE api_video_requests SET response_status=?,response_body=? WHERE id=? AND content_id IS NULL AND response_status IS NULL')
      .run(status, body, id);
  };
  return { get, claim: (...args: Parameters<typeof claim>) => claim.immediate(...args),
    claimAutomatic: (tokenId: number, userId: number, fingerprint: string, now = Date.now()) => claimAutomatic.immediate(tokenId, userId, fingerprint, now), link, finishWithoutContent };
}
