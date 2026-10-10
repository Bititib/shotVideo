import fs from 'node:fs/promises';
import path from 'node:path';
import { zonghengBaseUrl, zonghengError } from './zonghengAdapter.js';
export type ZonghengMediaKind = 'image' | 'video' | 'audio';
export interface ZonghengMediaOptions { baseUrl: string; apiKey: string; publicBaseUrl: string; uploadsRoot?: string; timeout?: number }
const MAX_BYTES = 25 * 1024 * 1024;
const types: Record<string, string> = { '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif', '.mp4':'video/mp4','.webm':'video/webm', '.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.flac':'audio/flac' };
function publicUrl(source: string) {
  const url = new URL(source), host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || host === 'localhost' || host.endsWith('.local') || host.startsWith('[')
    || /^(0|10|127|169\.254|192\.168)\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) throw new Error('纵横科技素材必须是公网 HTTPS 文件直链');
  return source;
}
async function readMedia(source: string, kind: ZonghengMediaKind, options: ZonghengMediaOptions) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('素材地址不能为空');
  let mime: string, bytes: Buffer, filename: string;
  if (source.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(source);
    if (!match || match[2].length > MAX_BYTES * 1.4) throw new Error('素材格式无效或超过 25MB');
    mime = match[1].toLowerCase().replace('audio/x-wav','audio/wav').replace('audio/mp3','audio/mpeg');
    const ext = Object.entries(types).find(([, value]) => value === mime)?.[0];
    if (!ext) throw new Error('纵横科技不支持此素材格式');
    bytes = Buffer.from(match[2], 'base64'); filename = kind + ext;
  } else {
    let local = source;
    if (!local.startsWith('/uploads/') && !local.startsWith('/api/uploads/')) {
      const url = new URL(source);
      if (options.publicBaseUrl && url.origin === new URL(options.publicBaseUrl).origin && /^\/(?:api\/)?uploads\//.test(url.pathname)) local = url.pathname;
      else return { url: publicUrl(source) };
    }
    const root = await fs.realpath(options.uploadsRoot || path.resolve('data/uploads'));
    const candidate = path.resolve(root, decodeURIComponent(local.split('?')[0].replace(/^\/(?:api\/)?uploads\//,'')));
    if (!candidate.startsWith(root + path.sep)) throw new Error('素材路径不安全');
    const real = await fs.realpath(candidate);
    if (!real.startsWith(root + path.sep)) throw new Error('素材路径不安全');
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('素材不是文件或超过 25MB');
    mime = types[path.extname(real).toLowerCase()] || ''; filename = path.basename(real); bytes = await fs.readFile(real);
  }
  if (!mime.startsWith(kind + '/') || !bytes.length || bytes.length > MAX_BYTES) throw new Error('素材类型不匹配、内容为空或超过 25MB');
  return { bytes, mime, filename };
}
export async function validateZonghengMedia(sources: string[], kind: ZonghengMediaKind, options: ZonghengMediaOptions) {
  for (const source of sources) await readMedia(source, kind, options);
}
/** Upload at submission time; do not cache provider URLs, which expire after three days. */
export async function prepareZonghengMedia(sources: string[], kind: ZonghengMediaKind, options: ZonghengMediaOptions): Promise<string[]> {
  const urls: string[] = [];
  for (const source of sources) {
    const media = await readMedia(source, kind, options);
    if (media.url) { urls.push(media.url); continue; }
    const form = new FormData(); form.append('file', new Blob([new Uint8Array(media.bytes!)], { type: media.mime }), media.filename);
    const response = await fetch(zonghengBaseUrl(options.baseUrl) + '/v1/media', { method: 'POST', headers: { Authorization: 'Bearer ' + options.apiKey }, body: form,
      signal: AbortSignal.timeout(options.timeout || 120_000), redirect: 'error' });
    const payload = await response.json() as any;
    if (!response.ok || payload.success === false || !payload.data?.[0]?.url) throw new Error('纵横科技素材上传失败：' + zonghengError(payload));
    urls.push(publicUrl(payload.data[0].url));
  }
  return urls;
}
