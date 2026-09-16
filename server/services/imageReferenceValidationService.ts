import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;

export class InvalidImageReferenceError extends Error {
  readonly index: number;

  constructor(index: number, reason: string) {
    super(`参考图 ${index + 1} 无法读取：${reason}`);
    this.name = 'InvalidImageReferenceError';
    this.index = index;
  }
}

function decodeDataUrl(source: string): Buffer {
  const match = source.match(/^data:image\/[^;,]+(?:;[^,]*)?;base64,([a-zA-Z0-9+/=\s]+)$/i);
  if (!match) throw new Error('图片数据格式不正确');
  const encoded = match[1].replace(/\s/g, '');
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length === 0) throw new Error('图片内容为空');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('图片超过 20MB 上限');
  return buffer;
}

function resolveLocalUpload(source: string, trustedOrigins: Set<string>): string | null {
  let pathname = source;
  if (/^https?:\/\//i.test(source)) {
    const parsed = new URL(source);
    if (!trustedOrigins.has(parsed.origin)) return null;
    pathname = parsed.pathname;
  }
  if (!pathname.startsWith('/uploads/')) return null;

  const uploadsRoot = path.resolve(process.cwd(), 'data', 'uploads');
  const relativePath = decodeURIComponent(pathname.slice('/uploads/'.length)).replace(/^[/\\]+/, '');
  const candidatePath = path.resolve(uploadsRoot, relativePath);
  if (candidatePath === uploadsRoot || !candidatePath.startsWith(`${uploadsRoot}${path.sep}`)) {
    throw new Error('图片路径不安全');
  }
  return candidatePath;
}

async function normalizeBuffer(buffer: Buffer): Promise<string> {
  const image = sharp(buffer, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height || !metadata.format) throw new Error('不是有效图片');

  const normalized = await image
    .rotate()
    .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
  return `data:image/jpeg;base64,${normalized.toString('base64')}`;
}

async function readLimitedResponse(response: Response): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_IMAGE_BYTES) throw new Error('图片超过 20MB 上限');
  if (!response.body) throw new Error('远程图片内容为空');

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new Error('图片超过 20MB 上限');
    }
    chunks.push(Buffer.from(value));
  }
  if (total === 0) throw new Error('远程图片内容为空');
  return Buffer.concat(chunks, total);
}

async function downloadTrustedRemoteImage(source: string, allowedOrigins: Set<string>): Promise<Buffer> {
  let current = new URL(source);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!allowedOrigins.has(current.origin)) throw new Error('远程图片跳转到了未授权地址');
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      headers: { Accept: 'image/*' },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`临时图片下载失败（HTTP ${response.status}）`);
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      throw new Error(`临时图片下载失败（HTTP ${response.status}），文件可能已过期，请重新上传`);
    }
    return readLimitedResponse(response);
  }
  throw new Error('远程图片跳转次数过多');
}

export async function validateAndNormalizeImageReferences(
  sources: unknown[],
  options: { trustedOrigins?: string[]; trustedRemoteOrigins?: string[] } = {},
): Promise<string[]> {
  const trustedOrigins = new Set(
    (options.trustedOrigins || []).flatMap(value => {
      try { return [new URL(value).origin]; } catch { return []; }
    }),
  );
  const trustedRemoteOrigins = new Set(
    (options.trustedRemoteOrigins || []).flatMap(value => {
      try { return [new URL(value).origin]; } catch { return []; }
    }),
  );
  const normalized: string[] = [];

  // Process sequentially to keep memory bounded for models that accept 30 images.
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    if (typeof source !== 'string' || !source.trim()) {
      throw new InvalidImageReferenceError(index, '图片地址为空');
    }

    try {
      if (source.startsWith('data:')) {
        normalized.push(await normalizeBuffer(decodeDataUrl(source)));
        continue;
      }

      const localPath = resolveLocalUpload(source, trustedOrigins);
      if (localPath) {
        if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) throw new Error('服务器中的图片文件不存在');
        const stat = fs.statSync(localPath);
        if (stat.size === 0) throw new Error('服务器中的图片文件为空');
        if (stat.size > MAX_IMAGE_BYTES) throw new Error('图片超过 20MB 上限');
        normalized.push(await normalizeBuffer(fs.readFileSync(localPath)));
        continue;
      }

      if (/^https?:\/\//i.test(source)) {
        const remoteOrigin = new URL(source).origin;
        if (trustedRemoteOrigins.has(remoteOrigin)) {
          // Trusted temporary upload hosts are copied immediately. Video queues
          // may outlive their URLs, so deferring this download causes batches of
          // otherwise valid HM tasks to fail with HTTP 404.
          normalized.push(await normalizeBuffer(await downloadTrustedRemoteImage(source, trustedRemoteOrigins)));
          continue;
        }
        // Unknown external hosts remain URLs to avoid turning this endpoint
        // into a server-side request forgery primitive.
        normalized.push(source);
        continue;
      }
      throw new Error('仅支持图片数据、本站上传地址或 HTTPS 图片地址');
    } catch (error: any) {
      if (error instanceof InvalidImageReferenceError) throw error;
      throw new InvalidImageReferenceError(index, error?.message || '图片格式损坏');
    }
  }

  return normalized;
}
