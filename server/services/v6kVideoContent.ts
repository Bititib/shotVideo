import { isIP } from 'node:net';
import { zonghengTaskUrl } from './zonghengAdapter.js';
import { fetchVideoTaskResponse } from './videoPollDeadline.js';
import { upstreamDiagnostic, transportDiagnostic } from './upstreamDiagnostic.js';

export class V6kVideoContentError extends Error {
  constructor(message: string, readonly status: number, readonly taskId: string, readonly upstreamCode?: string) { super(message); }
}
async function contentError(response: Response, taskId: string, key: string) {
  const text = await response.text(); let payload: any = text;
  try { payload = JSON.parse(text); } catch { /* Keep the sanitized concrete response reason. */ }
  const code = typeof payload?.error?.code === 'string' && /^[\w.-]{1,100}$/.test(payload.error.code) ? payload.error.code : undefined;
  return new V6kVideoContentError(upstreamDiagnostic('V6K', '成品获取失败 task_id=' + taskId, payload, key, response.status,
    response.headers.get('x-request-id') || undefined), response.status, taskId, code);
}
function publicResultUrl(value: string, base: string): URL {
  const url = new URL(value, base), host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || host === 'localhost' || host.endsWith('.local')
    || !host.includes('.') || isIP(host.replace(/^\[|\]$/g, ''))) throw new Error('任务返回的成品地址不是有效公网 HTTPS 地址');
  return url;
}
/** No authorization on a public result URL or any of its redirects. */
async function publicContent(value: string, base: string): Promise<Response> {
  let url = publicResultUrl(value, base);
  for (let hop = 0; hop <= 3; hop++) {
    const response = await fetch(url.href, { redirect: 'manual', signal: AbortSignal.timeout(300_000) });
    if (![301,302,303,307,308].includes(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location || hop === 3) throw new Error('成品地址重定向无效或次数过多');
    url = publicResultUrl(location, url.href);
  }
  throw new Error('成品地址重定向次数过多');
}
/** A 410 may be checked against ONE fresh original-task receipt, never a create POST. */
export async function fetchV6kVideoContent(channel: { baseUrl: string; apiKey: string }, taskId: string): Promise<Response> {
  const taskUrl = zonghengTaskUrl(channel.baseUrl, taskId), contentUrl = taskUrl + '/content';
  const headers = { Authorization: 'Bearer ' + channel.apiKey, 'Cache-Control': 'no-cache, no-store' };
  const response = await fetch(contentUrl, { headers, redirect: 'error', signal: AbortSignal.timeout(300_000) });
  if (response.ok) return response;
  const original = await contentError(response, taskId, channel.apiKey);
  if (original.status !== 410) throw original;
  try {
    const receipt = await fetchVideoTaskResponse(taskUrl, { headers, redirect: 'error', cache: 'no-store' });
    if (!receipt.ok) throw await contentError(receipt, taskId, channel.apiKey);
    const job = await receipt.json() as any;
    if (job?.id !== taskId || job?.status !== 'completed') throw new Error('原任务回执的编号或完成状态不一致');
    if (typeof job.url === 'string' && job.url.trim()) {
      const alternate = publicResultUrl(job.url, channel.baseUrl);
      if (alternate.href !== contentUrl) {
        const fallback = await publicContent(alternate.href, channel.baseUrl);
        if (fallback.ok) return fallback;
        throw await contentError(fallback, taskId, channel.apiKey);
      }
    }
  } catch (error) {
    original.message += '；' + transportDiagnostic('V6K', '核对原任务成品地址', error, channel.apiKey);
  }
  throw original;
}
