import { createHash } from 'node:crypto';
import { upstreamDiagnostic, transportDiagnostic } from './upstreamDiagnostic.js';
export type Image2proChannel = { type?: string; baseUrl: string; apiKey: string; timeout?: number | null };
export const image2proCredential = (c: Image2proChannel) => createHash('sha256').update(JSON.stringify([c.baseUrl,c.apiKey])).digest('hex');
export type Image2proKind = 'image' | 'video';
export const isImage2proChannel = (c: { type?: string } | null | undefined) => c?.type === 'image2pro';
export const image2proBase = (base: string) => base.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1';
const endpoint = (kind: Image2proKind) => kind === 'image' ? '/images/tasks' : '/videos';
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{16,80}$/i.test(id);
export class Image2proError extends Error {
  retryAfterMs = 10000;
  constructor(message: string, public phase: 'submit' | 'query', public status = 0, public confirmedFailure = false) { super(message); }
  get uncertain() { return !this.confirmedFailure; }
}
function detail(c: Image2proChannel, phase: string, raw: any, status: number) {
  return upstreamDiagnostic('Image2Pro', phase, { error: raw?.error || '上游未提供具体原因', status: raw?.status, accounting_status: raw?.accounting_status }, c.apiKey, status);
}
export async function image2proModels(c: Image2proChannel) {
  const response = await fetch(image2proBase(c.baseUrl) + '/models', { headers: { Authorization: 'Bearer ' + c.apiKey }, redirect: 'error', signal: AbortSignal.timeout(30000) });
  const raw = await response.json() as any;
  if (!response.ok || !Array.isArray(raw?.data)) throw new Error(detail(c, '模型查询', raw, response.status));
  return raw.data.filter((m: any) => typeof m?.id === 'string' && ['text', 'image', 'video'].includes(m.metadata?.type));
}
export async function submitImage2pro(c: Image2proChannel, kind: Image2proKind, payload: Record<string, unknown>, key: string,
  beforeSend: () => void, persistId: (id: string) => void, transport: typeof fetch = fetch, mediaContract = false) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{5,99}$/.test(key)) throw new Image2proError('Image2Pro 逻辑请求编号无效', 'submit', 0, true);
  const body = JSON.stringify(payload);
  beforeSend();
  let response: Response;
  try { response = await transport(image2proBase(c.baseUrl) + endpoint(kind), { method: 'POST', headers: {
    Authorization: 'Bearer ' + c.apiKey, 'Content-Type': 'application/json', 'Idempotency-Key': key,
    ...(mediaContract ? { 'X-Xiaojuzi-Media-Contract': '1' } : {}) }, body, redirect: 'error', signal: AbortSignal.timeout(c.timeout || 120000) }); }
  catch (e) { throw new Image2proError(transportDiagnostic('Image2Pro', '提交结果未知；保留原编号', e, c.apiKey), 'submit'); }
  let raw: any;
  try { raw = await response.json(); } catch { throw new Image2proError('Image2Pro 提交响应不完整；HTTP ' + response.status, 'submit', response.status); }
  if (validId(raw?.id)) { persistId(raw.id); return { id: raw.id, raw }; }
  // Only documented structured request rejections. Conflict/5xx/unknown bodies never authorize a new generation.
  const rejected = !raw?.id && !raw?.status && typeof raw?.error?.message === 'string' &&
    [400,401,402,403,404,405,413,415,429].includes(response.status);
  throw new Image2proError(detail(c, '提交', raw, response.status), 'submit', response.status, rejected);
}
export function normalizeImage2pro(c: Image2proChannel, kind: Image2proKind, id: string, raw: any) {
  if (!validId(id) || raw?.id !== id) throw new Image2proError('Image2Pro 查询任务编号不一致', 'query');
  const allowed = kind === 'image' ? ['queued','processing','completed','failed'] : ['queued','in_progress','processing','completed','failed'];
  if (!allowed.includes(raw.status)) throw new Image2proError(upstreamDiagnostic('Image2Pro','原任务状态未知',{message:String(raw.status).slice(0,80)},c.apiKey), 'query');
  const urls: string[] = kind === 'image' ? (Array.isArray(raw.data) ? raw.data.map((v: any) => v?.url) : []) : [raw.url || raw.metadata?.url || raw.output?.[0]?.url].filter(Boolean);
  if (raw.status === 'completed' && (!urls.length || urls.some(url => typeof url !== 'string' || !/^https?:\/\//.test(url)))) throw new Image2proError('Image2Pro 完成回执缺少有效结果地址，继续查询原任务', 'query');
  if(kind==='image' && raw.status==='completed' && urls.length!==1)throw new Image2proError('Image2Pro 单图请求返回多图，需核对原任务全部结果', 'query');
  return { status: kind === 'image' && raw.status === 'failed' && raw.accounting_status === 'refund_pending' ? 'processing' : raw.status,
    resultUrl: urls[0] || '', imageUrl: urls[0] || '', imageUrls: urls, progress: Number(raw.progress) || 0,
    pollAfterMs: Math.max(10000,Number(raw.poll_after_ms)||0,Number(raw.poll_interval_ms)||0), accountingStatus: raw.accounting_status, error: raw.status === 'failed' ? detail(c, '任务 ' + id, raw, 200) : '' };
}
export async function pollImage2pro(c: Image2proChannel, kind: Image2proKind, id: string, transport: typeof fetch = fetch) {
  if (!validId(id)) throw new Image2proError('Image2Pro 原任务编号无效', 'query');
  let response: Response;
  try { response = await transport(image2proBase(c.baseUrl) + endpoint(kind) + '/' + id, { headers: { Authorization: 'Bearer ' + c.apiKey }, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
  catch(e) { throw new Image2proError(transportDiagnostic('Image2Pro', '查询 ' + id, e, c.apiKey), 'query'); }
  let raw: any; try { raw = await response.json(); } catch { throw new Image2proError('Image2Pro 查询响应不完整；任务 ' + id, 'query', response.status); }
  if (!response.ok) {const error=new Image2proError(detail(c, '查询 ' + id, raw, response.status), 'query', response.status);const retry=response.headers.get('retry-after');error.retryAfterMs=Math.max(10000,retry ? (/^\d+$/.test(retry)?Number(retry)*1000:Date.parse(retry)-Date.now())||0:0);throw error;}
  return normalizeImage2pro(c, kind, id, raw);
}
