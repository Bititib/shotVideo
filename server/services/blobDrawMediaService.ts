import fs from 'node:fs/promises';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { detectedMediaMime } from './privateMediaStore.js';
import { publicReferenceRoot } from './publicReferenceService.js';
import { blobDrawRequest, type BlobDrawChannel } from './blobDrawAdapter.js';

type Kind = 'image' | 'video' | 'audio';
type Options = BlobDrawChannel & { publicBaseUrl: string; uploadsRoot?: string };
const extensions: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg',
};
function blockedAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
      || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19].includes(b) || a >= 224;
  }
  const ip = address.toLowerCase();
  return ip === '::' || ip === '::1' || ip.startsWith('::ffff:') || /^(fc|fd|fe[89ab]|ff)/.test(ip);
}
async function download(source: string, max: number) {
  let url = new URL(source);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:' || url.username || url.password || host === 'localhost' || /\.(local|localhost)$/i.test(host)) throw new Error('BlobDraw 外部素材须为公网 HTTPS 文件地址');
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(a => blockedAddress(a.address))) throw new Error('BlobDraw 不允许读取内网素材地址');
    // No upstream credential is ever sent to the material host.
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('BlobDraw 素材重定向无效');
      url = new URL(location, url); continue;
    }
    if (!response.ok || !response.body) throw new Error('BlobDraw 素材下载失败');
    if (Number(response.headers.get('content-length') || 0) > max) throw new Error('BlobDraw 素材超过文件大小限制');
    const reader = response.body.getReader(), chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > max) throw new Error('BlobDraw 素材超过文件大小限制');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return { bytes: Buffer.concat(chunks), mime: (response.headers.get('content-type') || '').split(';')[0].toLowerCase() };
  }
  throw new Error('BlobDraw 素材重定向次数过多');
}
export async function readBlobDrawMedia(source: string, kind: Kind, options: Options) {
  const max = (kind === 'image' ? 20 : 50) * 1024 * 1024;
  let bytes: Buffer, mime = '';
  if (source.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(source);
    if (!match || match[2].replace(/\s/g, '').length > Math.ceil(max / 3) * 4) throw new Error('BlobDraw 素材格式无效或超过大小限制');
    mime = match[1].toLowerCase().replace('audio/x-wav', 'audio/wav').replace('audio/mp3', 'audio/mpeg');
    bytes = Buffer.from(match[2], 'base64');
  } else {
    let pathname = source.split(/[?#]/)[0], local = source.startsWith('/');
    if (/^https?:\/\//i.test(source)) {
      const url = new URL(source);
      local = Boolean(options.publicBaseUrl && url.origin === new URL(options.publicBaseUrl).origin);
      pathname = url.pathname;
    }
    if (local) {
      const uploads = /^\/(?:api\/)?uploads\//.test(pathname);
      const published = pathname.startsWith('/reference-assets/');
      if (!uploads && !published) throw new Error('BlobDraw 仅能读取本站上传的素材');
      const root = await fs.realpath(uploads ? options.uploadsRoot || path.resolve('data/uploads') : publicReferenceRoot());
      const relative = decodeURIComponent(pathname.replace(uploads ? /^\/(?:api\/)?uploads\// : /^\/reference-assets\//, ''));
      if (relative.includes('\\') || relative.includes('\0') || relative.split('/').some(p => p === '..' || p === '.')) throw new Error('BlobDraw 素材路径不安全');
      const candidate = path.resolve(root, relative);
      if (!candidate.startsWith(root + path.sep)) throw new Error('BlobDraw 素材路径不安全');
      const file = await fs.realpath(candidate), stat = await fs.stat(file);
      if (!file.startsWith(root + path.sep) || !stat.isFile() || stat.size > max) throw new Error('BlobDraw 素材路径或大小无效');
      mime = Object.entries(extensions).find(([, ext]) => ext === path.extname(file).toLowerCase())?.[0] || '';
      bytes = await fs.readFile(file);
    } else ({ bytes, mime } = await download(source, max));
  }
  if (!bytes.length || bytes.length > max) throw new Error('BlobDraw 素材为空或超过大小限制');
  let detected = detectedMediaMime(bytes, mime);
  if (detected === 'video/mp4' && bytes.subarray(8, 12).toString() === 'qt  ') detected = 'video/quicktime';
  if (!detected || !extensions[detected] || !detected.startsWith(kind + '/')) throw new Error('BlobDraw 素材实际格式不受支持或类型不匹配');
  return { bytes, mime: detected, filename: kind + extensions[detected] };
}
export async function uploadBlobDrawMedia(sources: string[], kind: Kind, options: Options): Promise<number[]> {
  const ids: number[] = [], digests = new Set<string>();
  for (const source of sources) {
    const media = await readBlobDrawMedia(source, kind, options);
    const digest = createHash('sha256').update(media.bytes).digest('hex');
    if (digests.has(digest)) throw new Error('BlobDraw 同一类参考素材不能重复');
    digests.add(digest);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(media.bytes)], { type: media.mime }), media.filename);
    const data = await blobDrawRequest(options, '/assets', form);
    const id = Number(data?.id);
    if (!Number.isSafeInteger(id) || id <= 0 || ids.includes(id)) throw new Error('BlobDraw 上传未返回有效且唯一的素材 ID');
    ids.push(id);
  }
  return ids;
}
