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
}

/** Never expire a paid request's identity or release it because a process/connection ended. */
export function createApiVideoRequestStore(database: Database.Database) {
  database.exec(`CREATE TABLE IF NOT EXISTS api_video_requests (
    id TEXT PRIMARY KEY, token_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    key_hash TEXT NOT NULL, fingerprint TEXT NOT NULL, content_id INTEGER,
    response_status INTEGER, response_body TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(token_id,user_id,key_hash), UNIQUE(content_id)
  )`);
  const projection = 'id,token_id AS tokenId,user_id AS userId,fingerprint,content_id AS contentId,response_status AS responseStatus,response_body AS responseBody';
  const get = (id: string) => database.prepare(`SELECT ${projection} FROM api_video_requests WHERE id=?`).get(id) as ApiVideoRequestRecord | undefined;
  const claim = database.transaction((tokenId: number, userId: number, keyHash: string, fingerprint: string) => {
    const existing = database.prepare(`SELECT ${projection} FROM api_video_requests WHERE token_id=? AND user_id=? AND key_hash=?`)
      .get(tokenId, userId, keyHash) as ApiVideoRequestRecord | undefined;
    if (existing) return { fresh: false, mismatch: existing.fingerprint !== fingerprint, record: existing };
    const id = 'task_req_' + randomBytes(16).toString('hex');
    database.prepare('INSERT INTO api_video_requests(id,token_id,user_id,key_hash,fingerprint) VALUES(?,?,?,?,?)').run(id, tokenId, userId, keyHash, fingerprint);
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
  return { get, claim: (...args: Parameters<typeof claim>) => claim.immediate(...args), link, finishWithoutContent };
}
