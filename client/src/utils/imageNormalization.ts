export const MOBILE_IMAGE_ACCEPT = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.heic',
  '.heif',
].join(',');

export type NormalizedImageType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface NormalizeImageOptions {
  maxDimension?: number;
  quality?: number;
  outputType?: NormalizedImageType;
  maxInputBytes?: number;
}

export interface NormalizedImage {
  blob: Blob;
  file: File;
  dataUrl: string;
  width: number;
  height: number;
  wasHeic: boolean;
}

const KNOWN_IMAGE_EXTENSIONS = /\.(?:jpe?g|png|webp|heic|heif)$/i;
const HEIC_EXTENSIONS = /\.(?:heic|heif)$/i;
const HEIC_MIME_TYPES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);

export function isSupportedImageFile(file: File): boolean {
  const mimeType = String(file.type || '').toLowerCase();
  return mimeType.startsWith('image/') || KNOWN_IMAGE_EXTENSIONS.test(file.name || '');
}

export async function isHeicFile(file: Blob & { name?: string }): Promise<boolean> {
  const mimeType = String(file.type || '').toLowerCase();
  if (HEIC_MIME_TYPES.has(mimeType) || HEIC_EXTENSIONS.test(file.name || '')) return true;
  if (file.size < 12) return false;

  try {
    const bytes = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    const ascii = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
    if (ascii.slice(4, 8) !== 'ftyp') return false;
    for (let offset = 8; offset + 4 <= ascii.length; offset += 4) {
      if (HEIC_BRANDS.has(ascii.slice(offset, offset + 4))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function outputExtension(type: NormalizedImageType): string {
  if (type === 'image/png') return 'png';
  if (type === 'image/webp') return 'webp';
  return 'jpg';
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('图片编码失败'));
    reader.readAsDataURL(blob);
  });
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(blob);
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('浏览器无法读取该图片'));
    };
    image.src = objectUrl;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  outputType: NormalizedImageType,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('图片格式转换失败')),
      outputType,
      quality,
    );
  });
}

async function decodeHeic(file: File, quality: number): Promise<Blob> {
  try {
    const { default: heic2any } = await import('heic2any');
    const converted = await heic2any({
      blob: file,
      toType: 'image/jpeg',
      quality,
    });
    const first = Array.isArray(converted) ? converted[0] : converted;
    if (!(first instanceof Blob)) throw new Error('未生成有效图片');
    return first;
  } catch (error) {
    console.error('[image-normalization] HEIC/HEIF conversion failed:', error);
    throw new Error('HEIC/HEIF 照片转换失败，请改用“最兼容”拍摄格式或先保存为 JPG 后重试');
  }
}

/**
 * Decode a phone photo, apply its display orientation, resize it and emit a
 * standards-compliant JPEG/PNG/WebP. HEIC support is loaded only when needed.
 */
export async function normalizeImageFile(
  file: File,
  options: NormalizeImageOptions = {},
): Promise<NormalizedImage> {
  if (!isSupportedImageFile(file)) throw new Error('仅支持 JPG、JPEG、PNG、WebP、HEIC 或 HEIF 图片');

  const maxInputBytes = options.maxInputBytes ?? 20 * 1024 * 1024;
  if (file.size > maxInputBytes) {
    throw new Error(`图片超过 ${Math.round(maxInputBytes / 1024 / 1024)}MB 上限`);
  }

  const outputType = options.outputType ?? 'image/jpeg';
  const quality = Math.max(0.1, Math.min(1, options.quality ?? 0.86));
  const maxDimension = Math.max(1, Math.round(options.maxDimension ?? 2048));
  const wasHeic = await isHeicFile(file);
  const decodableBlob = wasHeic ? await decodeHeic(file, quality) : file;
  const image = await loadImage(decodableBlob);

  let width = image.naturalWidth || image.width;
  let height = image.naturalHeight || image.height;
  if (!width || !height) throw new Error('无法获取图片尺寸');
  if (Math.max(width, height) > maxDimension) {
    const scale = maxDimension / Math.max(width, height);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持图片转换');
  if (outputType === 'image/jpeg') {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(image, 0, 0, width, height);

  const blob = await canvasToBlob(canvas, outputType, quality);
  const dataUrl = await blobToDataUrl(blob);
  const baseName = (file.name || 'image').replace(/\.[^.]+$/, '') || 'image';
  const normalizedFile = new File([blob], `${baseName}.${outputExtension(outputType)}`, {
    type: outputType,
    lastModified: file.lastModified || Date.now(),
  });

  return { blob, file: normalizedFile, dataUrl, width, height, wasHeic };
}
