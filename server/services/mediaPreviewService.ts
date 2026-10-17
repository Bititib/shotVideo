import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';

export type MediaPreviewKind = 'image' | 'poster';
const run = promisify(execFile);
const pending = new Map<string, Promise<string>>();
let queue: Promise<unknown> = Promise.resolve();

/** Fixed-size, versioned derivatives, never overwriting the downloadable source.
 * Callers must authorize the SOURCE before serving a derivative. Cache is outside
 * public upload directories. One conversion at a time protects small VPS CPUs. */
export async function createMediaPreview(source: string, kind: MediaPreviewKind,
  cacheRoot = path.resolve('data/media-previews')): Promise<string> {
  const file = await fs.realpath(source);
  const stat = await fs.stat(file);
  if (!stat.isFile() || !stat.size) throw new Error('Media source is empty');
  const key = createHash('sha256').update(JSON.stringify([file, stat.size, stat.mtimeMs, stat.ctimeMs, kind, 'v1'])).digest('hex');
  const output = path.join(cacheRoot, key + (kind === 'image' ? '.webp' : '.jpg'));
  if (await fs.stat(output).then(s => s.size > 0, () => false)) return output;
  const running = pending.get(output);
  if (running) return running;
  if (pending.size >= 32) throw Object.assign(new Error('Preview queue is busy'), { status: 503 });
  const task = queue.then(async () => {
    await fs.mkdir(cacheRoot, { recursive: true });
    const temp = output + '.' + randomUUID() + (kind === 'image' ? '.tmp.webp' : '.tmp.jpg');
    try {
      if (kind === 'image') {
        await sharp(file, { limitInputPixels: 64_000_000 }).rotate()
          .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 78 }).timeout({ seconds: 20 }).toFile(temp);
      } else {
        await run('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-threads', '1', '-i', file,
          '-frames:v', '1', '-an', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease',
          '-threads', '1', '-q:v', '4', temp], { timeout: 30_000, maxBuffer: 256 * 1024, windowsHide: true });
      }
      const after = await fs.stat(file);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('Media changed during preview');
      await fs.rename(temp, output);
      return output;
    } finally { await fs.rm(temp, { force: true }); }
  });
  pending.set(output, task);
  queue = task.catch(() => {});
  try { return await task; } finally { pending.delete(output); }
}

/** Resolve only files beneath uploads, including symlink checks. */
export async function resolvePreviewSource(root: string, requestPath: string): Promise<string> {
  const realRoot = await fs.realpath(root);
  const decoded = decodeURIComponent(requestPath);
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').includes('..')) throw new Error('Invalid preview path');
  const file = await fs.realpath(path.resolve(realRoot, '.' + decoded));
  const relative = path.relative(realRoot, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid preview path');
  return file;
}
