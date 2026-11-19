import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import type { ZipFile } from 'yauzl';
import { chatImageExtension, type ChatAttachment } from '../../shared/websiteChat.js';
import { isImage2proChannel } from './image2proAdapter.js';

export interface PreparedChatAttachment extends ChatAttachment {
  digest: string;
  content: string;
}

export function chatAttachmentError(message: string, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function channelSupportsChatImages(channel: { type?: string; baseUrl: string; apiKey?: string }) {
  if (!channel.apiKey?.trim()) return false;
  if (isImage2proChannel(channel)) return true;
  try { return new URL(channel.baseUrl).origin === 'https://api.openai.com'; } catch { return false; }
}

const maxDocumentBytes = 48_000;
const maxImagePixels = 20_000_000;
const require = createRequire(import.meta.url);

async function extractPdf(buffer: Buffer) {
  const { getDocument, PasswordResponses } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const assets = dirname(require.resolve('pdfjs-dist/package.json'));
  const task = getDocument({ data: new Uint8Array(buffer), useSystemFonts: false,
    cMapUrl: join(assets, 'cmaps') + '/', cMapPacked: true, standardFontDataUrl: join(assets, 'standard_fonts') + '/' });
  try {
    const document = await task.promise;
    if (document.numPages > 50) throw chatAttachmentError('PDF 最多支持 50 页');
    const pages: string[] = [];
    let bytes = 0;
    let hasText = false;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const { items } = await page.getTextContent();
      page.cleanup();
      const text = items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
      hasText ||= Boolean(text);
      const line = `第 ${number} 页\n${text || '［本页无可提取文字］'}`;
      bytes += Buffer.byteLength(line) + 2;
      if (bytes > maxDocumentBytes) throw chatAttachmentError('PDF 提取的文字过长，请拆分后上传');
      pages.push(line);
    }
    if (!hasText) throw chatAttachmentError('PDF 没有可提取的文字，请将扫描页转成图片后上传');
    return pages.join('\n\n');
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code === PasswordResponses.NEED_PASSWORD || code === PasswordResponses.INCORRECT_PASSWORD) {
      throw chatAttachmentError('PDF 有密码保护，请解密后再上传');
    }
    throw error;
  } finally { await task.destroy(); }
}

async function checkWordArchive(buffer: Buffer) {
  const { fromBuffer } = await import('yauzl');
  await new Promise<void>((resolve, reject) => {
    fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip: ZipFile) => {
      if (error) return reject(error);
      let bytes = 0;
      let document = false;
      zip.on('error', reject);
      zip.on('entry', entry => {
        bytes += entry.uncompressedSize;
        document ||= entry.fileName === 'word/document.xml';
        if (bytes > 16 * 1024 * 1024 || zip.entryCount > 512) {
          zip.close();
          reject(chatAttachmentError('Word 文档解包后过大，请拆分后上传'));
        } else if (entry.fileName.endsWith('/')) zip.readEntry();
        else zip.openReadStream(entry, (error, stream) => {
          if (error) { zip.close(); reject(error); return; }
          stream.on('error', failure => { zip.close(); reject(failure); });
          stream.on('end', () => zip.readEntry());
          stream.resume();
        });
      });
      zip.on('end', () => document ? resolve() : reject(chatAttachmentError('文件不是有效的 Word .docx 文档')));
      zip.readEntry();
    });
  });
}

export async function prepareChatAttachment(file: Express.Multer.File): Promise<PreparedChatAttachment> {
  const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');
  const name = (decodedName.includes('\uFFFD') ? file.originalname : decodedName).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180);
  const rawName = file.originalname.toLowerCase();
  const digest = createHash('sha256').update(file.buffer).digest('hex');
  try {
    if (chatImageExtension.test(rawName)) {
      const { format, width, height, pages = 1 } = await sharp(file.buffer, { limitInputPixels: maxImagePixels }).metadata();
      const expected = /\.jpe?g$/.test(rawName) ? 'jpeg' : rawName.split('.').at(-1);
      if (format !== expected || pages !== 1) throw chatAttachmentError('请上传格式正确的静态 PNG、JPEG 或 WebP 图片');
      if (!width || !height || width * height > maxImagePixels) throw chatAttachmentError('图片尺寸过大，请缩小后上传');
      return { name, digest, kind: 'image', content: `data:image/${format};base64,${file.buffer.toString('base64')}` };
    }
    let content: string;
    if (rawName.endsWith('.pdf')) {
      if (file.buffer.subarray(0, 5).toString() !== '%PDF-') throw chatAttachmentError('文件不是有效的 PDF');
      content = await extractPdf(file.buffer);
    } else if (rawName.endsWith('.docx')) {
      await checkWordArchive(file.buffer);
      const { default: mammoth } = await import('mammoth');
      content = (await mammoth.extractRawText({ buffer: file.buffer })).value.trim();
    } else throw chatAttachmentError('支持 PNG、JPEG、WebP、PDF 和 Word .docx');
    if (!content) throw chatAttachmentError('文档没有可提取的文字');
    if (Buffer.byteLength(content) > maxDocumentBytes) throw chatAttachmentError('文档提取的文字过长，请拆分后上传');
    return { name, digest, kind: 'document', content };
  } catch (error) {
    const reason = (error as { status?: number }).status === 400 ? (error as Error).message : '无法读取文件，请检查格式、大小或是否已损坏';
    throw chatAttachmentError(`${name} · ${reason}`);
  }
}
