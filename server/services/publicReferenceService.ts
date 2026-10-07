import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { detectedMediaMime } from './privateMediaStore.js';

const extensions: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'audio/mp4': 'm4a', 'audio/webm': 'webm',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/aac': 'aac',
};
const published = new Map<string, string>();
export const publicReferenceRoot = () => path.resolve(process.env.PUBLIC_REFERENCE_DIR || 'data/public-reference-assets');

function publicOrigin(base = process.env.BACKEND_URL || ''): string {
  let url: URL;
  try { url = new URL(base); } catch { throw new Error('请配置 BACKEND_URL 公网 HTTPS 地址后提交参考素材'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')) throw new Error('参考素材需要公网 HTTPS 地址');
  return url.origin;
}

/** Publish bytes only after the caller has authorized the upload/reference.
 * Random immutable names do not expose owner IDs, source paths or credentials. */
export function publishReferenceBytes(bytes: Buffer, declaredMime: string, base?: string): string {
  const origin = publicOrigin(base);
  let mime = detectedMediaMime(bytes, declaredMime);
  if (mime === 'video/mp4' && bytes.subarray(8,12).toString() === 'qt  ') mime = 'video/quicktime';
  if (declaredMime === 'audio/aac' && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) mime = 'audio/aac';
  if (!mime || !extensions[mime] || !bytes.length || bytes.length > (mime.startsWith('image/') ? 20 : 100) * 1024 * 1024) {
    throw new Error('参考素材内容无效或过大（图片最多 20 MB，视频/音频最多 100 MB）');
  }
  const root = publicReferenceRoot();
  const key = `${root}:${mime}:${createHash('sha256').update(bytes).digest('hex')}`;
  const cached = published.get(key);
  if (cached && fs.existsSync(path.join(root, cached))) return `${origin}/reference-assets/${cached}`;
  fs.mkdirSync(root, { recursive: true });
  const filename = `${randomUUID()}.${extensions[mime]}`;
  const file = path.join(root, filename), temp = `${file}.part`;
  try { fs.writeFileSync(temp, bytes, { flag: 'wx' }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
  if (published.size >= 1000) published.delete(published.keys().next().value!);
  published.set(key, filename);
  return `${origin}/reference-assets/${filename}`;
}

/** Keep external URLs intact; publish inline and authorized local uploads as
 * stable unauthenticated URLs. Never accepts arbitrary filesystem paths. */
export function publishReferenceUrl(source: string, base = process.env.BACKEND_URL || '', uploadsRoot = path.resolve('data/uploads')): string {
  const inline = /^data:([^;,]+);base64,([a-zA-Z0-9+/=\s]+)$/i.exec(source);
  if (inline) return publishReferenceBytes(Buffer.from(inline[2], 'base64'), inline[1], base);
  let pathname = source.split(/[?#]/)[0];
  if (/^https?:\/\//i.test(source)) {
    const url = new URL(source);
    if (url.username || url.password) throw new Error('参考链接不能包含账号密码');
    if (!base || url.origin !== new URL(base).origin) return source;
    pathname = url.pathname;
    // Public asset/media links already have random names and need no copy.
    if (!/^\/(?:api\/)?uploads\//.test(pathname)) return source;
  }
  if (pathname.startsWith('/reference-assets/')) return `${publicOrigin(base)}${pathname}`;
  pathname = decodeURIComponent(pathname).replace(/^\/api\/uploads\//, '/uploads/');
  if (!pathname.startsWith('/uploads/') || pathname.includes('\\') || pathname.includes('\0')
    || pathname.split('/').some(part => part === '..' || part === '.')) throw new Error('参考素材路径不安全');
  const root = fs.realpathSync(uploadsRoot);
  const candidate = path.resolve(root, pathname.slice('/uploads/'.length));
  if (!fs.existsSync(candidate)) throw new Error('本地参考素材不存在');
  const file = fs.realpathSync(candidate);
  if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile()) throw new Error('参考素材路径不安全');
  if (fs.statSync(file).size > 100 * 1024 * 1024) throw new Error('参考素材超过 100 MB');
  const extension = path.extname(file).toLowerCase().slice(1);
  const declaredMime = Object.entries(extensions).find(([, ext]) => ext === extension)?.[0] || '';
  return publishReferenceBytes(fs.readFileSync(file), declaredMime, base);
}
