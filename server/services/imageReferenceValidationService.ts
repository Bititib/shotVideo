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

export async function validateAndNormalizeImageReferences(
  sources: unknown[],
  options: { trustedOrigins?: string[] } = {},
): Promise<string[]> {
  const trustedOrigins = new Set(
    (options.trustedOrigins || []).flatMap(value => {
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

      // External URLs remain supported. The browser validates them before the
      // web request; fetching arbitrary URLs here would introduce SSRF risk.
      if (/^https?:\/\//i.test(source)) {
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
