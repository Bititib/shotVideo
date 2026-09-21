import fs from 'fs';
import path from 'path';

export type MiaowuMediaKind = 'image' | 'video' | 'audio';

export interface MiaowuMediaOptions {
  publicBaseUrl: string;
  uploadsRoot?: string;
}

const MAX_BYTES: Record<MiaowuMediaKind, number> = {
  image: 20 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  audio: 20 * 1024 * 1024,
};

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
};

export class InvalidMiaowuMediaError extends Error {
  constructor(
    readonly kind: MiaowuMediaKind,
    readonly index: number,
    reason: string,
  ) {
    const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频';
    super(`${label}素材 ${index + 1} 无法提交：${reason}`);
    this.name = 'InvalidMiaowuMediaError';
  }
}

function normalizePublicBaseUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new Error('BACKEND_URL 不是有效的公网 URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('BACKEND_URL 必须使用 http:// 或 https://');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '::1' || hostname.startsWith('127.')) {
    throw new Error('BACKEND_URL 不能使用 localhost 或回环地址');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed;
}

function localUploadPath(pathname: string, uploadsRoot: string): string {
  if (!pathname.startsWith('/uploads/')) throw new Error('不是本站上传文件地址');
  const relativePath = decodeURIComponent(pathname.slice('/uploads/'.length)).replace(/^[/\\]+/, '');
  const root = path.resolve(uploadsRoot);
  const resolved = path.resolve(root, relativePath);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) throw new Error('素材路径不安全');
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error('服务器中的素材文件不存在');
  if (fs.statSync(resolved).size === 0) throw new Error('服务器中的素材文件为空');
  return resolved;
}

function dataUrlParts(source: string, kind: MiaowuMediaKind): { mimeType: string; buffer: Buffer } {
  const match = source.match(/^data:([^;,]+)(?:;[^,]*)?;base64,([a-zA-Z0-9+/=\s]+)$/i);
  if (!match) throw new Error('Base64 数据格式不正确');
  const mimeType = match[1].toLowerCase();
  if (!mimeType.startsWith(`${kind}/`)) throw new Error(`素材类型 ${mimeType} 与 ${kind} 不匹配`);
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (buffer.length === 0) throw new Error('素材内容为空');
  if (buffer.length > MAX_BYTES[kind]) {
    throw new Error(`素材超过 ${Math.round(MAX_BYTES[kind] / 1024 / 1024)}MB 上限`);
  }
  return { mimeType, buffer };
}

function saveDataUrl(source: string, kind: MiaowuMediaKind, uploadsRoot: string): string {
  const { mimeType, buffer } = dataUrlParts(source, kind);
  const extension = MIME_EXTENSIONS[mimeType];
  if (!extension) throw new Error(`不支持的素材格式 ${mimeType}`);
  const directory = path.join(uploadsRoot, 'miaowu-media');
  fs.mkdirSync(directory, { recursive: true });
  const filename = `${kind}_${Date.now()}_${crypto.randomUUID()}.${extension}`;
  const finalPath = path.join(directory, filename);
  const temporaryPath = `${finalPath}.part`;
  try {
    fs.writeFileSync(temporaryPath, buffer, { flag: 'wx' });
    fs.renameSync(temporaryPath, finalPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
  return `/uploads/miaowu-media/${filename}`;
}

function publicUrlForPath(baseUrl: URL, pathname: string): string {
  return new URL(pathname, `${baseUrl.origin}/`).toString();
}

export function prepareMiaowuPublicMediaUrls(
  sources: unknown[],
  kind: MiaowuMediaKind,
  options: MiaowuMediaOptions,
): string[] {
  const publicBaseUrl = normalizePublicBaseUrl(options.publicBaseUrl);
  const uploadsRoot = path.resolve(options.uploadsRoot || path.join(process.cwd(), 'data', 'uploads'));

  return sources.map((rawSource, index) => {
    try {
      if (typeof rawSource !== 'string' || !rawSource.trim()) throw new Error('素材地址为空');
      const source = rawSource.trim();

      if (source.startsWith('data:')) {
        return publicUrlForPath(publicBaseUrl, saveDataUrl(source, kind, uploadsRoot));
      }
      if (source.startsWith('/uploads/')) {
        localUploadPath(source, uploadsRoot);
        return publicUrlForPath(publicBaseUrl, source);
      }
      if (!/^https?:\/\//i.test(source)) {
        throw new Error('仅支持 Base64、本站上传地址或公网 http(s) URL');
      }

      const parsed = new URL(source);
      if (parsed.origin === publicBaseUrl.origin && parsed.pathname.startsWith('/uploads/')) {
        localUploadPath(parsed.pathname, uploadsRoot);
        return publicUrlForPath(publicBaseUrl, `${parsed.pathname}${parsed.search}`);
      }
      return parsed.toString();
    } catch (error: any) {
      if (error instanceof InvalidMiaowuMediaError) throw error;
      throw new InvalidMiaowuMediaError(kind, index, error?.message || '素材地址无效');
    }
  });
}
