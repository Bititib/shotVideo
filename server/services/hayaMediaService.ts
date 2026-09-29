import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { hayaApiBaseUrl } from './hayaVideoAdapter.js';

export type HayaMediaKind = 'image' | 'video' | 'audio';
export const HAYA_MAX_FILE_BYTES = 20 * 1024 * 1024;
const mimeByExtension: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
};
export interface HayaMediaOptions { baseUrl: string; apiKey: string; publicBaseUrl: string; uploadsRoot?: string }

function publicMediaUrl(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || host === 'localhost' || host.endsWith('.local')
    || host.startsWith('[') || /^(0|10|127|169\.254|192\.168)\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error('素材必须是公网 HTTPS 文件直链');
  }
  return value; // Preserve signed query parameters exactly.
}

/** Resolve only this application's uploads, never arbitrary local paths or remote URLs. */
async function readMedia(source: string, kind: HayaMediaKind, options: HayaMediaOptions) {
  let mime = '';
  let bytes: Buffer;
  let filename = '';
  if (source.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,([a-zA-Z0-9+/=\s]+)$/.exec(source);
    if (!match) throw new Error('素材 Base64 格式不正确');
    mime = match[1].toLowerCase();
    if (match[2].length > HAYA_MAX_FILE_BYTES * 1.4) throw new Error('素材超过 20 MB');
    bytes = Buffer.from(match[2], 'base64');
    const extension = Object.entries(mimeByExtension).find(([, type]) => type === mime)?.[0];
    if (!extension) throw new Error(`不支持的素材类型 ${mime}`);
    filename = `${kind}${extension}`;
  } else {
    let pathname = source.split('?')[0];
    if (!source.startsWith('/uploads/')) {
      const url = new URL(source);
      if (options.publicBaseUrl && url.origin === new URL(options.publicBaseUrl).origin && url.pathname.startsWith('/uploads/')) pathname = url.pathname;
      else return { url: publicMediaUrl(source) };
    }
    const root = fs.realpathSync(options.uploadsRoot || path.join(process.cwd(), 'data/uploads'));
    const candidate = path.resolve(root, decodeURIComponent(pathname.slice('/uploads/'.length)));
    if (!candidate.startsWith(`${root}${path.sep}`)) throw new Error('素材路径不安全');
    const real = fs.realpathSync(candidate);
    if (!real.startsWith(`${root}${path.sep}`)) throw new Error('素材路径不安全');
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > HAYA_MAX_FILE_BYTES) throw new Error('素材不是文件或超过 20 MB');
    mime = mimeByExtension[path.extname(real).toLowerCase()] || '';
    filename = path.basename(real);
    bytes = await fs.promises.readFile(real);
  }
  if (!mime.startsWith(`${kind}/`)) throw new Error(`素材类型必须是 ${kind}`);
  if (!bytes.length || bytes.length > HAYA_MAX_FILE_BYTES) throw new Error('素材为空或超过 20 MB');
  if (kind === 'image') {
    const info = await sharp(bytes, { limitInputPixels: 36_000_000 }).metadata();
    if (!info.width || !info.height || info.width < 300 || info.height < 300 || info.width > 6000 || info.height > 6000) {
      throw new Error('Haya 图片宽高必须分别在 300–6000 像素之间');
    }
  }
  return { bytes, mime, filename };
}

export async function validateHayaMedia(sources: string[], kind: HayaMediaKind, options: HayaMediaOptions) {
  for (const source of sources) await readMedia(source, kind, options);
}

export async function prepareHayaMedia(sources: string[], kind: HayaMediaKind, options: HayaMediaOptions): Promise<string[]> {
  const urls: string[] = [];
  for (const source of sources) {
    const media = await readMedia(source, kind, options);
    if (media.url) { urls.push(media.url); continue; }
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(media.bytes!)], { type: media.mime }), media.filename);
    const response = await fetch(`${hayaApiBaseUrl(options.baseUrl)}/v1/files`, {
      method: 'POST', headers: { Authorization: `Bearer ${options.apiKey}` }, body: form,
      signal: AbortSignal.timeout(120_000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Haya 素材上传失败 (${response.status}): ${(await response.text()).slice(0, 500)}`);
    const file = await response.json() as any;
    if (file.media_type !== kind || typeof file.url !== 'string') throw new Error('Haya 上传响应的素材类型或 URL 不正确');
    urls.push(publicMediaUrl(file.url));
  }
  return urls;
}
