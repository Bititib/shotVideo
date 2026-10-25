import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { detectedMediaMime } from './privateMediaStore.js';
import { publicReferenceRoot, publishReferenceBytes } from './publicReferenceService.js';
import { downloadPublicReferenceImage } from './publicImageDownload.js';

const MAX_BYTES = 20 * 1024 * 1024;
const error = (reason: string) => Object.assign(new Error(reason), { status: 400 });

function localFile(source: string, origins: Set<string>): { file: string; publicName?: string } | undefined {
  let pathname = source.split(/[?#]/)[0];
  if (/^https?:\/\//i.test(source)) {
    const url = new URL(source);
    if (url.username || url.password) throw error('图片 URL 不能包含账号密码');
    if (!origins.has(url.origin)) return;
    pathname = url.pathname;
  }
  pathname = decodeURIComponent(pathname).replace(/^\/api\/uploads\//, '/uploads/');
  const isPublic = pathname.startsWith('/reference-assets/');
  if (!isPublic && !pathname.startsWith('/uploads/')) return;
  const relative = pathname.slice(isPublic ? '/reference-assets/'.length : '/uploads/'.length);
  if (!relative || relative.includes('\\') || relative.includes('\0') || relative.split('/').some(v => v === '..' || v === '.')) throw error('图片路径不安全');
  if (isPublic && !/^[a-f0-9-]{36}\.(jpg|png|webp|gif|avif)$/i.test(relative)) throw error('公共图片路径无效');
  const root = fs.realpathSync(isPublic ? publicReferenceRoot() : path.resolve('data/uploads'));
  const file = fs.realpathSync(path.resolve(root, relative));
  if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile()) throw error('图片路径不安全');
  if (fs.statSync(file).size > MAX_BYTES) throw error('图片超过 20 MB 上限');
  return { file, ...(isPublic ? { publicName: relative } : {}) };
}

/** Pre-charge HM image preparation. Persist the returned URLs in order/batch
 * metadata; queue/recovery must reuse them instead of fetching external URLs. */
export async function prepareHmReferenceImages(sources: string[], base: string, trustedOrigins: string[] = []): Promise<string[]> {
  if (!sources.length) return [];
  let origin: string;
  try {
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')) throw new Error();
    origin = url.origin;
  } catch { throw error('请配置本站公网 HTTPS 地址后提交 HM 参考图片，本次未提交、未扣费'); }
  const origins = new Set([origin, ...trustedOrigins.flatMap(value => { try { return [new URL(value).origin]; } catch { return []; } })]);
  const results: string[] = [];
  const reused = new Map<string, string>();
  const deadline = Date.now() + 90_000;
  for (const [index, source] of sources.entries()) {
    try {
      if (typeof source !== 'string' || !source.trim()) throw error('图片地址为空');
      if (reused.has(source)) { results.push(reused.get(source)!); continue; }
      if (Date.now() >= deadline) throw error('图片准备超时');
      let bytes: Buffer;
      let publicName: string | undefined;
      if (source.startsWith('data:')) {
        const match = /^data:image\/[^;,]+;base64,([a-zA-Z0-9+/=\s]+)$/.exec(source);
        if (!match) throw error('图片数据格式无效');
        if (match[1].length > Math.ceil(MAX_BYTES / 3) * 4 + 1024) throw error('图片超过 20 MB 上限');
        bytes = Buffer.from(match[1], 'base64');
      } else {
        const local = localFile(source, origins);
        if (local) { bytes = fs.readFileSync(local.file); publicName = local.publicName; }
        else bytes = await downloadPublicReferenceImage(source, AbortSignal.timeout(Math.min(30_000, Math.max(1, deadline - Date.now()))));
      }
      if (!bytes.length) throw error('图片内容为空');
      if (bytes.length > MAX_BYTES) throw error('图片超过 20 MB 上限');
      const mime = detectedMediaMime(bytes, '');
      if (!mime?.startsWith('image/')) throw error('返回内容不是有效图片（可能是 HTML 错误页）');
      try {
        // Decode the complete image, not just its magic header. Do not resize,
        // transcode or alter the user's reference bytes.
        await sharp(bytes, { failOn: 'warning', limitInputPixels: 40_000_000 }).stats();
      } catch { throw error('图片损坏、无法完整解码或像素数量超过 4000 万'); }
      const url = publicName ? `${origin}/reference-assets/${publicName}` : publishReferenceBytes(bytes, mime, origin);
      reused.set(source, url);
      results.push(url);
    } catch (e: any) {
      const reason = e?.code === 'ENOENT' ? '本站图片文件不存在'
        : e?.code ? '本站图片读取或保存失败' : e?.message || '图片准备失败';
      throw error(`参考图 ${index + 1}：${reason}；本次未提交上游`);
    }
  }
  return results;
}
