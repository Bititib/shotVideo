import { upstreamDiagnostic, transportDiagnostic } from './upstreamDiagnostic.js';
import { createHash } from 'node:crypto';

export type MinikeyKind = 'videos' | 'images' | 'music';
export type MinikeyChannel = { baseUrl: string; apiKey: string; timeout?: number | null; type?: string };
export const isMinikeyChannel = (channel: { type?: string } | null | undefined) => channel?.type === 'minikey';
export const minikeyCredential = (c:MinikeyChannel) => createHash('sha256').update(JSON.stringify([c.baseUrl,c.apiKey])).digest('hex');
export function minikeyBase(base: string) {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('miniKey 服务地址无效');
  return url.origin + '/openapi/v1';
}
export class MinikeyError extends Error {
  constructor(message: string, public phase: 'submit' | 'query', public httpStatus = 0, public confirmedFailure = false) { super(message); }
  get uncertain() { return this.phase === 'submit' && !this.confirmedFailure; }
}
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{32}$/i.test(id);
function diagnostic(c: MinikeyChannel, phase: string, raw: any, status?: number) {
  return upstreamDiagnostic('miniKey', phase, raw, c.apiKey, status);
}
async function request(c: MinikeyChannel, path: string, phase: 'submit' | 'query', init: RequestInit, transport: typeof fetch) {
  try { return await transport(minikeyBase(c.baseUrl) + path, { ...init, headers: { Authorization: 'Bearer ' + c.apiKey, ...init.headers }, redirect: 'error', signal: AbortSignal.timeout(c.timeout || 120000) }); }
  catch (error) { throw new MinikeyError(transportDiagnostic('miniKey', phase+' 连接异常；保留原请求，不自动重新生成',error,c.apiKey), phase); }
}
export async function submitMinikey(c: MinikeyChannel, kind: MinikeyKind, payload: FormData | Record<string, unknown>,
  beforeSend: () => void, persistId: (id: string) => void, transport: typeof fetch = fetch) {
  beforeSend();
  const response = await request(c, '/' + kind, 'submit', { method: 'POST',
    ...(payload instanceof FormData ? { body: payload } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) }, transport);
  let raw: any;
  try { raw = await response.json(); } catch { throw new MinikeyError('miniKey 提交响应不是完整 JSON，受理结果待核实', 'submit', response.status); }
  const id = kind === 'images' ? raw?.task_id : raw?.id;
  if (validId(id)) { persistId(id); return { id, raw }; }
  const rejection = typeof raw?.detail === 'string' && !raw?.status && !id &&
    ([400, 401, 402, 413].includes(response.status) || kind === 'images' && response.status === 502);
  throw new MinikeyError(diagnostic(c, '提交', raw, response.status), 'submit', response.status, rejection);
}
export function normalizeMinikeyTask(c: MinikeyChannel, kind: MinikeyKind, id: string, raw: any) {
  const received = kind === 'images' ? raw?.task_id : raw?.id;
  if (!validId(received) || received !== id) throw new MinikeyError('miniKey 查询返回任务编号不一致', 'query');
  const state = kind === 'images' ? raw.state : raw.status;
  const allowed = kind === 'videos' ? ['queued', 'pending', 'running', 'processing', 'success', 'failed', 'cancelled']
    : kind === 'images' ? ['pending', 'running', 'success', 'failed'] : ['queued', 'running', 'processing', 'success', 'failed'];
  if (!allowed.includes(state) || kind === 'images' && (typeof raw.is_final !== 'boolean' || raw.is_final !== ['success', 'failed'].includes(state)))
    throw new MinikeyError('miniKey 查询状态未知或终态标记冲突', 'query');
  const resultUrl = state === 'success' ? (kind === 'images' ? raw.result_url : kind === 'videos' ? raw.videoUrl : raw.musicUrl) : '';
  if (state === 'success' && (typeof resultUrl !== 'string' || !/^https?:\/\//i.test(resultUrl))) throw new MinikeyError('miniKey 成功回执缺少有效结果地址', 'query');
  return { status: state === 'success' ? 'completed' : state === 'cancelled' ? 'failed' : state,
    resultUrl: resultUrl || '', imageUrl: kind === 'images' ? resultUrl || '' : '', progress: Math.max(0, Math.min(100, Number(raw.progress) || 0)),
    error: ['failed', 'cancelled'].includes(state) ? diagnostic(c, '任务 ' + id, raw, 200) : '' };
}
export async function pollMinikey(c: MinikeyChannel, kind: MinikeyKind, id: string, transport: typeof fetch = fetch) {
  if (!validId(id)) throw new MinikeyError('miniKey 原任务编号无效', 'query');
  const response = await request(c, '/' + kind + '/' + id, 'query', {}, transport);
  let raw: any;
  try { raw = await response.json(); } catch { throw new MinikeyError('miniKey 查询响应不是完整 JSON', 'query', response.status); }
  if (!response.ok) throw new MinikeyError(diagnostic(c, '查询 ' + id, raw, response.status), 'query', response.status);
  return normalizeMinikeyTask(c, kind, id, raw);
}
/** Credentials are confined to the original task file endpoint, including redirects. */
export async function fetchMinikeyFile(c: MinikeyChannel, kind: 'videos' | 'music', id: string, transport: typeof fetch = fetch) {
  if (!validId(id)) throw new MinikeyError('miniKey 原任务编号无效', 'query');
  const response = await transport(minikeyBase(c.baseUrl) + '/' + kind + '/' + id + '/file', { headers: { Authorization: 'Bearer ' + c.apiKey }, redirect: 'manual', signal: AbortSignal.timeout(300000) });
  if (response.status >= 300 && response.status < 400) {
    const destination = response.headers.get('location');
    if (!destination) throw new MinikeyError('miniKey 文件重定向缺少地址', 'query', response.status);
    const url = new URL(destination, minikeyBase(c.baseUrl));
    if (url.protocol !== 'https:' || url.username || url.password) throw new MinikeyError('miniKey 文件重定向地址无效', 'query');
    return transport(url, { redirect: 'error', signal: AbortSignal.timeout(300000) });
  }
  return response;
}
export function buildMinikeyMusic(input: { model: string; prompt: string; lyrics?: string; mode?: string; vocal?: string; tags?: string[]; chan?: number }) {
  if (typeof input.model!=='string' || typeof input.prompt!=='string' || !input.model || !input.prompt.trim() || [...input.prompt].length > 1000) throw new Error('miniKey 音乐需要模型与 1–1000 字提示词');
  if (input.lyrics!==undefined && typeof input.lyrics!=='string' || input.tags!==undefined && (!Array.isArray(input.tags)||input.tags.some(t=>typeof t!=='string'||!t.trim()))) throw new Error('歌词必须是文本，标签必须是非空文本数组');
  if ([...(input.lyrics || '')].length > 3000) throw new Error('miniKey 歌词不能超过 3000 字');
  if (!['song', 'instrumental'].includes(input.mode || 'song') || !['auto', 'm', 'f'].includes(input.vocal || 'auto')) throw new Error('miniKey 音乐模式或人声参数无效');
  if ((input.tags || []).length > 6 || (input.tags || []).some(t => [...t].length > 12)) throw new Error('miniKey 最多 6 个标签，每个不超过 12 字');
  if (input.mode === 'instrumental' && (input.lyrics || input.vocal && input.vocal !== 'auto')) throw new Error('纯音乐不能携带歌词或指定人声');
  return { ...input };
}
