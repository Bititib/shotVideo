import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import fs from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';

const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;
const CACHE_DIRECTORY = 'wx-haidiyue';

type SupportedImage = {
  buffer: Buffer;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  extension: 'jpg' | 'png' | 'webp';
};

export type WxHaidiYueImageOptions = {
  uploadsRoot?: string;
  /** Public URL that may already appear in incoming /uploads references. */
  publicBaseUrl?: string;
  /** HTTPS origin used in URLs sent to wx-海底月; ideally a DNS-only direct media domain. */
  mediaBaseUrl?: string;
  maxImageBytes?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

function detectImage(buffer: Buffer): Omit<SupportedImage, 'buffer'> | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  return null;
}

function isHeicBuffer(buffer: Buffer): boolean {
  if (buffer.length < 12 || buffer.subarray(4, 8).toString('ascii') !== 'ftyp') return false;
  const brands = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
  for (let offset = 8; offset + 4 <= Math.min(buffer.length, 64); offset += 4) {
    if (brands.has(buffer.subarray(offset, offset + 4).toString('ascii'))) return true;
  }
  return false;
}

function validateImageBuffer(buffer: Buffer, maxImageBytes: number, label: string): SupportedImage {
  if (buffer.length === 0) throw new Error(`参考图为空（${label}）`);
  if (buffer.length > maxImageBytes) {
    throw new Error(`参考图超过 ${Math.round(maxImageBytes / 1024 / 1024)}MB（${label}）`);
  }
  const detected = detectImage(buffer);
  if (!detected) {
    if (isHeicBuffer(buffer)) {
      throw new Error(`参考图仍是 HEIC/HEIF（${label}），请使用新版网页上传以自动转换为 JPEG`);
    }
    throw new Error(`参考图不是有效的 PNG/JPEG/WebP 文件（${label}）`);
  }
  return { buffer, ...detected };
}

function decodeImageDataUrl(source: string, maxImageBytes: number): SupportedImage {
  const match = source.match(/^data:image\/[^;,]+;base64,([a-zA-Z0-9+/=\s]+)$/i);
  if (!match) throw new Error('参考图 Base64 格式无效');
  return validateImageBuffer(Buffer.from(match[1].replace(/\s/g, ''), 'base64'), maxImageBytes, 'Base64');
}

function configuredOrigins(options: WxHaidiYueImageOptions): Set<string> {
  const origins = new Set<string>();
  for (const value of [options.publicBaseUrl, options.mediaBaseUrl]) {
    if (!value) continue;
    try { origins.add(new URL(value).origin); } catch { /* validated when used as output */ }
  }
  return origins;
}

function localUploadPath(source: string, uploadsRoot: string, options: WxHaidiYueImageOptions): string | null {
  let pathname = '';
  if (source.startsWith('/uploads/')) {
    pathname = source.split(/[?#]/, 1)[0];
  } else {
    try {
      const sourceUrl = new URL(source);
      if (!configuredOrigins(options).has(sourceUrl.origin)) return null;
      pathname = sourceUrl.pathname;
    } catch {
      return null;
    }
  }
  if (!pathname.startsWith('/uploads/')) return null;

  let relativePath: string;
  try {
    relativePath = decodeURIComponent(pathname.slice('/uploads/'.length)).replace(/\\/g, '/');
  } catch {
    throw new Error('参考图本地路径编码无效');
  }
  const root = path.resolve(uploadsRoot);
  const target = path.resolve(root, relativePath);
  if (!relativePath || target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('参考图本地路径无效');
  }
  return target;
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && parts[2] === 100)
    || (a === 203 && b === 0 && parts[2] === 113)
    || a >= 224;
}

function isBlockedAddress(address: string): boolean {
  if (isIP(address) === 4) return isBlockedIpv4(address);
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return isBlockedIpv4(mappedIpv4);
  return normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('::ffff:')
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith('ff');
}

async function assertPublicHttpsUrl(url: URL): Promise<void> {
  if (url.protocol !== 'https:') throw new Error(`外部参考图必须使用 HTTPS（${url.hostname}）`);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new Error('不允许访问本地参考图地址');
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(item => isBlockedAddress(item.address))) {
    throw new Error(`不允许访问内网参考图地址（${hostname}）`);
  }
}

async function readResponseWithLimit(response: Response, maxImageBytes: number, label: string): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxImageBytes) {
    throw new Error(`参考图超过 ${Math.round(maxImageBytes / 1024 / 1024)}MB（${label}）`);
  }
  if (!response.body) throw new Error(`参考图响应为空（${label}）`);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxImageBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`参考图超过 ${Math.round(maxImageBytes / 1024 / 1024)}MB（${label}）`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function downloadPublicImage(
  source: string,
  maxImageBytes: number,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<SupportedImage> {
  let current: URL;
  try {
    current = new URL(source);
  } catch {
    throw new Error('参考图地址无效');
  }

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertPublicHttpsUrl(current);
    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: 'image/jpeg,image/png,image/webp',
          'User-Agent': 'shotVideo-reference-fetcher/1.0',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error: any) {
      const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? '连接超时' : '连接失败';
      throw new Error(`参考图下载失败（${current.hostname}：${reason}）`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`参考图重定向地址缺失（${current.hostname}）`);
      if (redirects === MAX_REDIRECTS) throw new Error(`参考图重定向次数过多（${current.hostname}）`);
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`参考图下载失败（${current.hostname}，HTTP ${response.status}）`);
    const buffer = await readResponseWithLimit(response, maxImageBytes, current.hostname);
    return validateImageBuffer(buffer, maxImageBytes, current.hostname);
  }
  throw new Error('参考图下载失败');
}

async function readSourceImage(source: string, options: WxHaidiYueImageOptions): Promise<SupportedImage> {
  const value = String(source || '').trim();
  if (!value) throw new Error('参考图地址为空');
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  if (/^data:/i.test(value)) return decodeImageDataUrl(value, maxImageBytes);

  const uploadsRoot = options.uploadsRoot || path.resolve(process.cwd(), 'data/uploads');
  const localPath = localUploadPath(value, uploadsRoot, options);
  if (localPath) {
    try {
      const fileInfo = await fs.stat(localPath);
      if (!fileInfo.isFile()) throw new Error(`参考图不是有效文件（${path.basename(localPath)}）`);
      if (fileInfo.size > maxImageBytes) {
        throw new Error(`参考图超过 ${Math.round(maxImageBytes / 1024 / 1024)}MB（${path.basename(localPath)}）`);
      }
      return validateImageBuffer(await fs.readFile(localPath), maxImageBytes, path.basename(localPath));
    } catch (error: any) {
      if (error?.message?.startsWith('参考图')) throw error;
      throw new Error(`本站参考图读取失败（${path.basename(localPath)}）`);
    }
  }

  return downloadPublicImage(
    value,
    maxImageBytes,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.fetchImpl || fetch,
  );
}

function resolveMediaBaseUrl(options: WxHaidiYueImageOptions): string {
  const value = String(options.mediaBaseUrl || options.publicBaseUrl || '').trim();
  if (!value) throw new Error('未配置海底月图片公网地址 WX_HAIDIYUE_IMAGE_BASE_URL');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('海底月图片公网地址配置无效'); }
  if (parsed.protocol !== 'https:') throw new Error('海底月图片公网地址必须使用 HTTPS');
  return value.replace(/\/+$/, '');
}

export async function wxHaidiYueImageToPublicUrl(
  source: string,
  options: WxHaidiYueImageOptions = {},
): Promise<string> {
  const image = await readSourceImage(source, options);
  const uploadsRoot = options.uploadsRoot || path.resolve(process.cwd(), 'data/uploads');
  const cacheRoot = path.join(uploadsRoot, CACHE_DIRECTORY);
  const hash = createHash('sha256').update(image.buffer).digest('hex');
  const filename = `${hash}.${image.extension}`;
  await fs.mkdir(cacheRoot, { recursive: true });
  try {
    await fs.writeFile(path.join(cacheRoot, filename), image.buffer, { flag: 'wx' });
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
  }

  return `${resolveMediaBaseUrl(options)}/uploads/${CACHE_DIRECTORY}/${filename}`;
}

/** Cache every image behind one controlled HTTPS origin and only send URLs supported by wx-海底月. */
export async function prepareWxHaidiYueImageUrls(
  sources: string[] | undefined,
  options: WxHaidiYueImageOptions = {},
): Promise<string[]> {
  const images = (sources || []).filter(Boolean);
  const prepared = await Promise.all(images.map(source => wxHaidiYueImageToPublicUrl(source, options)));
  if (prepared.length > 0) {
    const hostname = new URL(prepared[0]).hostname;
    console.log(`[wx-haidiyue] 已缓存 ${prepared.length} 张参考图并提交 HTTPS URL（${hostname}）`);
  }
  return prepared;
}
