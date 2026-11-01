import { HUSS_MJ_MODEL, hussMjOptions } from '../../shared/hussMidjourney.js';
import { hussApiBase, type HussChannel } from './hussVideoAdapter.js';
import { upstreamDiagnostic, transportDiagnostic } from './upstreamDiagnostic.js';
export class HussImageError extends Error {
  constructor(message: string, public rejected = false) { super(message); }
}
export type HussImageTask = { id: string; status: string; urls: string[]; delay: number; error?: string };
export function normalizeHussImage(raw: any, expectedId?: string): HussImageTask {
  const id = raw?.task_id || expectedId;
  if (typeof id !== 'string' || !id.trim() || (expectedId && raw.task_id && raw.task_id !== expectedId)) throw new HussImageError('HUSS 图片回执缺少任务编号或编号不匹配');
  const status = raw.status || 'queued';
  if (!['queued','processing','completed','failed','cancelled','expired'].includes(status)) throw new HussImageError('HUSS 图片返回未识别状态：' + status);
  const urls = Array.isArray(raw.data) ? raw.data.map((item: any) => item?.url).filter((url: any) => typeof url === 'string' && url) : [];
  for (const value of urls) { const u = new URL(value); if (!['https:','http:'].includes(u.protocol) || u.username || u.password) throw new HussImageError('HUSS 图片结果地址无效'); }
  if (status === 'completed' && raw.storage_status !== 'pending' && !urls.length) throw new HussImageError('HUSS 图片已完成但未返回结果地址');
  return { id, status: raw.storage_status === 'pending' && status === 'completed' ? 'processing' : status, urls,
    delay: Number.isFinite(Number(raw.poll_after_ms)) ? Math.max(1000, Number(raw.poll_after_ms)) : 5000,
    error: ['failed','cancelled','expired'].includes(status) ? upstreamDiagnostic('HUSS Midjourney', '图片任务 ' + status, raw.error || raw) : undefined };
}
async function request(channel: HussChannel, endpoint: string, body?: Record<string, any>, onReceipt?: (id:string)=>void) {
  let response: Response;
  try { response = await fetch(hussApiBase(channel.baseUrl) + '/v1' + endpoint, {
    method: body ? 'POST' : 'GET', redirect: 'error', headers: { Authorization: 'Bearer ' + channel.apiKey, ...(body ? {'Content-Type':'application/json'} : {}) },
    ...(body ? {body:JSON.stringify(body)} : {}), signal: AbortSignal.timeout(60000) }); }
  catch (e) { throw new HussImageError(transportDiagnostic('HUSS Midjourney', body ? '图片提交' : '图片查询', e, channel.apiKey)); }
  let raw: any;
  try { raw = await response.json(); } catch { throw new HussImageError('HUSS 图片响应不是有效 JSON，HTTP ' + response.status); }
  if (body && typeof raw?.task_id === 'string' && raw.task_id.trim()) onReceipt?.(raw.task_id);
  if (!response.ok || raw.error && !raw.task_id && body) {
    const rejected = Boolean(body && !raw.task_id && [400,401,402,403,422,429].includes(response.status));
    throw new HussImageError(upstreamDiagnostic('HUSS Midjourney', body ? '图片提交' : '图片查询', raw, channel.apiKey, response.status), rejected);
  }
  return raw;
}
export async function submitHussImage(channel: HussChannel, body: Record<string, any>, images: string[], onReceipt: (id: string) => void) {
  if (images.length > 1) throw new HussImageError('Midjourney V8.2 最多一张普通参考图', true);
  for (const image of images) if (!/^data:image\/(png|jpeg|webp);base64,/.test(image) || Buffer.byteLength(image.split(',')[1] || '', 'base64') > 10*1024*1024) throw new HussImageError('普通参考图须为 PNG/JPEG/WebP，且不超过 10 MiB', true);
  const payload = { model:HUSS_MJ_MODEL, prompt:body.prompt, n:1, resolution:String(body.resolution).toLowerCase(), aspect_ratio:body.aspect_ratio,
    response_format:'url', ...hussMjOptions(body), ...(images.length ? {images:images.map(image_url => ({image_url}))} : {}) };
  const raw = await request(channel, images.length ? '/images/edits/async' : '/images/generations/async', payload, onReceipt);
  // Persist acceptance before any status or result parsing can fail.
  if (typeof raw.task_id === 'string' && raw.task_id.trim()) onReceipt(raw.task_id);
  return normalizeHussImage(raw);
}
export async function queryHussImage(channel: HussChannel, id: string) {
  return normalizeHussImage(await request(channel, '/images/tasks/' + encodeURIComponent(id)), id);
}

/** Download original output only; never send the channel key to a redirected CDN. */
export async function downloadHussImage(channel: HussChannel, source: string): Promise<string> {
  let url = new URL(source);
  const origin = new URL(channel.baseUrl).origin;
  const signal = AbortSignal.timeout(300000);
  for (let hop=0; hop<6; hop++) {
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new HussImageError('HUSS 图片下载地址无效');
    let response: Response;
    try { response = await fetch(url, {redirect:'manual',signal,headers:hop===0 && url.origin===origin ? {Authorization:'Bearer '+channel.apiKey} : {}}); }
    catch (error) { throw new HussImageError(transportDiagnostic('HUSS Midjourney','图片下载连接',error,channel.apiKey)); }
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) throw new HussImageError('HUSS 图片下载跳转缺少地址');
      url = new URL(location,url); continue;
    }
    if (!response.ok) {
      const text = await response.text(); let detail: any; try {detail=JSON.parse(text);} catch {detail=text;}
      throw new HussImageError(upstreamDiagnostic('HUSS Midjourney','原图片下载',detail,channel.apiKey,response.status));
    }
    let buffer: Buffer;
    try { buffer = Buffer.from(await response.arrayBuffer()); }
    catch (error) { throw new HussImageError(transportDiagnostic('HUSS Midjourney','图片文件传输',error,channel.apiKey)); }
    const {default:sharp} = await import('sharp');
    const info = await sharp(buffer).metadata();
    if (!info.width || !info.height || !['png','jpeg','webp'].includes(info.format || '')) throw new HussImageError('HUSS 返回的文件不是有效图片');
    return 'data:image/'+info.format+';base64,'+buffer.toString('base64');
  }
  throw new HussImageError('HUSS 图片下载跳转次数过多');
}
