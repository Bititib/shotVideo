import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Request, Response } from 'express';
import { sqlite } from '../db/index.js';
import { createApiVideoRequestStore, type ApiVideoRequestRecord } from './apiVideoRequestStore.js';
import { publicGenerationError } from '../../shared/generationMessages.js';

const context = Symbol('apiVideoRequest');
type VideoRequest = Request & { [context]?: string };
const store = () => createApiVideoRequestStore(sqlite);
export const isApiVideoRequestId = (id: string) => id.startsWith('task_req_');
export const getApiVideoRequest = (id: string) => /^task_req_[a-f0-9]{32}$/.test(id) ? store().get(id) : undefined;

function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}

/** Hash file bytes, never multer's random disk paths, multipart boundaries, or credentials. */
export async function apiVideoFingerprint(req: Request): Promise<string> {
  const files: Record<string, Array<{ type: string; sha256: string }>> = Object.create(null);
  for (const file of Array.isArray(req.files) ? req.files : []) {
    const hash = createHash('sha256');
    if (file.buffer) hash.update(file.buffer);
    else for await (const chunk of createReadStream(file.path)) hash.update(chunk);
    (files[file.fieldname] ??= []).push({ type: file.mimetype, sha256: hash.digest('hex') });
  }
  return createHash('sha256').update(canonical({ body: req.body || {}, files })).digest('hex');
}

export async function claimApiVideoRequest(req: Request, token: { id: number; userId?: number | null }) {
  const key = req.get('Idempotency-Key');
  if (key !== undefined && !/^[\x21-\x7e]{1,200}$/.test(key))
    throw Object.assign(new Error('Idempotency-Key 必须为1–200个可见 ASCII 字符'), { status: 400 });
  const fingerprint = await apiVideoFingerprint(req);
  const keyHash = createHash('sha256').update(key === undefined ? 'body:' + fingerprint : 'header:' + key).digest('hex');
  const claim = store().claim(Number(token.id), Number(token.userId) || 0, keyHash, fingerprint);
  if (claim.mismatch) throw Object.assign(new Error('同一个 Idempotency-Key 已用于不同参数或素材，请为新任务使用新的键'), { status: 409, code: 'idempotency_conflict' });
  if (claim.fresh) (req as VideoRequest)[context] = claim.record.id;
  return claim;
}

/** Call inside the same transaction that creates the content, before any charge or dispatch. */
export function linkApiVideoRequest(req: Request, contentId: number) {
  const id = (req as VideoRequest)[context];
  if (id) store().link(id, contentId);
}

export function apiVideoRequestUrl(req: Request, id: string) {
  return req.protocol + '://' + req.get('host') + '/v1/videos/' + id;
}

export function respondPendingApiVideoRequest(req: Request, res: Response, record: ApiVideoRequestRecord) {
  res.setHeader('Cache-Control', 'no-store');
  if (record.responseStatus !== null && record.responseBody !== null) return res.status(record.responseStatus).json(JSON.parse(record.responseBody));
  res.setHeader('Retry-After', '2');
  return res.status(202).json({ id: record.id, task_id: record.id, object: 'video', status: 'queued', progress: 0,
    status_url: apiVideoRequestUrl(req, record.id), retry_after: 2, message: '原请求正在准备或等待恢复，请查询原请求，不会重新生成或扣费' });
}

/** Keep a stable client task ID even when the client missed the first response. */
export function captureApiVideoResponse(req: Request, res: Response, id: string) {
  const json = res.json;
  res.setHeader('Cache-Control', 'no-store');
  res.json = function (body: any) {
    const record = store().get(id);
    if (record?.contentId) {
      const row = sqlite.prepare('SELECT status FROM contents WHERE id=?').get(record.contentId) as any;
      body = { ...body, id, task_id: id, object: 'video', status_url: apiVideoRequestUrl(req, id) };
      if (!body.status) body.status = row?.status === 'failed' ? 'failed' : row?.status === 'completed' ? 'completed' : 'queued';
      if (typeof body.url === 'string' && body.url.includes('/v1/videos/task_')) body.url = apiVideoRequestUrl(req, id) + '/content';
      if (typeof body.result_url === 'string' && body.result_url.includes('/v1/videos/task_')) body.result_url = apiVideoRequestUrl(req, id) + '/content';
    } else if (record && res.statusCode >= 400) {
      // Only retain a small public validation error, never arbitrary provider responses or input.
      const original = body?.error;
      const error: Record<string, string> = { message: publicGenerationError(original || body?.message || '请求未完成') };
      for (const field of ['code', 'type']) if (typeof original?.[field] === 'string' && /^[\w.-]{1,100}$/.test(original[field])) error[field] = original[field];
      body = { error, request_id: id };
      store().finishWithoutContent(id, res.statusCode, JSON.stringify(body));
    }
    return json.call(this, body);
  };
}
