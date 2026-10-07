import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const locks = new Map<string, Promise<string>>();
const remoteLocks = new Map<string, Promise<string>>();
const probes = new Map<string, Promise<boolean>>();
const fallbackUntil = new Map<string, number>();
let conversionQueue: Promise<unknown> = Promise.resolve();

function fingerprint(file: string) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || !stat.size) throw new Error('Video file is empty or missing');
  return `${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

async function isCompatible(file: string): Promise<boolean> {
  const key = fingerprint(file);
  let pending = probes.get(key);
  if (!pending) {
    pending = (async () => {
      const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries',
        'stream=codec_type,codec_name,pix_fmt:format=format_name', '-of', 'json', file], { timeout: 30_000 });
      const info = JSON.parse(stdout);
      const videos = info.streams?.filter((s: any) => s.codec_type === 'video') || [];
      if (!videos.length) throw new Error('Source contains no video stream');
      const audios = info.streams?.filter((s: any) => s.codec_type === 'audio') || [];
      return videos.length === 1 && videos[0].codec_name === 'h264' && videos[0].pix_fmt === 'yuv420p'
        && audios.every((s: any) => s.codec_name === 'aac') && String(info.format?.format_name).split(',').includes('mp4');
    })();
    // Bound memory while keeping repeated Range requests free of child processes.
    if (probes.size >= 500) probes.delete(probes.keys().next().value!);
    probes.set(key, pending);
    pending.catch(() => probes.delete(key));
  }
  return pending;
}

/** Strict conversion primitive. Delivery uses prepareVideoForDelivery below. */
export async function ensureH264Video(source: string): Promise<string> {
  const file = fs.realpathSync(source);
  const key = fingerprint(file);
  const existing = locks.get(key);
  if (existing) return existing;
  const pending = (async () => {
    if (await isCompatible(file)) return file;
    const output = `${file}.h264.mp4`;
    if (fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(file).mtimeMs) {
      try { if (await isCompatible(output)) return output; } catch { /* rebuild invalid cache */ }
    }
    // One encode at a time, two threads: batch previews must not exhaust the VPS.
    const conversion = conversionQueue.then(async () => {
      const temp = `${output}.${crypto.randomUUID()}.tmp.mp4`;
      try {
        await run('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-i', file,
          '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-tag:v', 'avc1',
          '-pix_fmt', 'yuv420p', '-preset', 'superfast', '-crf', '23', '-threads', '2',
          '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', temp],
        { timeout: 30 * 60_000, maxBuffer: 1024 * 1024 });
        if (!await isCompatible(temp)) throw new Error('H.264 conversion verification failed');
        if (fingerprint(file) !== key) throw new Error('Video source changed during conversion; please retry');
        fs.renameSync(temp, output);
        return output;
      } finally {
        fs.rmSync(temp, { force: true });
      }
    });
    conversionQueue = conversion.catch(() => {});
    return conversion;
  })();
  locks.set(key, pending);
  try { return await pending; } finally { locks.delete(key); }
}

/** Prefer H.264, but a failed conversion must not hide a valid original video.
 * Keep using authenticated application URLs rather than redirecting to upstream.
 * A short cooldown avoids retrying the same failed encode for every Range request. */
export async function prepareVideoForDelivery(source: string): Promise<string> {
  const file = fs.realpathSync(source);
  const key = fingerprint(file);
  if ((fallbackUntil.get(key) || 0) > Date.now()) return file;
  try {
    const result = await ensureH264Video(file);
    fallbackUntil.delete(key);
    return result;
  } catch (error) {
    // Probe failures, missing/corrupt files and upstream error pages are not
    // usable fallback videos. Only a successfully probed original can be served.
    await isCompatible(file);
    if (fingerprint(file) !== key) throw error;
    if (fallbackUntil.size >= 500) fallbackUntil.delete(fallbackUntil.keys().next().value!);
    fallbackUntil.set(key, Date.now() + 60_000);
    console.warn('[video] H.264 preparation failed; serving original video for 60 seconds:',
      error instanceof Error ? error.message : String(error));
    return file;
  }
}

export function videoDeliveryContentType(file: string): string {
  const header = Buffer.alloc(4096);
  const fd = fs.openSync(file, 'r');
  let size: number;
  try { size = fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
  if (header.readUInt32BE(0) === 0x1a45dfa3) {
    return header.subarray(0, size).includes(Buffer.from('webm')) ? 'video/webm' : 'video/x-matroska';
  }
  const extension = path.extname(file).toLowerCase();
  return extension === '.webm' ? 'video/webm' : extension === '.mkv' ? 'video/x-matroska'
    : extension === '.mov' ? 'video/quicktime' : 'video/mp4';
}

export function videoDeliveryExtension(file: string): string {
  const mime = videoDeliveryContentType(file);
  return mime === 'video/webm' ? '.webm' : mime === 'video/x-matroska' ? '.mkv'
    : mime === 'video/quicktime' ? '.mov' : '.mp4';
}

/** Share the same preferred cache for remote playback and downloads. Auth headers
 * are included in the cache identity, never in filenames or logs. */
export async function cacheVideoForDelivery(url: string, headers: Record<string, string> = {}): Promise<string> {
  const hash = crypto.createHash('sha256').update(JSON.stringify([url, headers])).digest('hex');
  const existing = remoteLocks.get(hash);
  if (existing) return existing;
  const pending = (async () => {
    const directory = path.resolve('data/video_cache');
    fs.mkdirSync(directory, { recursive: true });
    const source = path.join(directory, `${hash}.mp4`);
    if (!fs.existsSync(source)) {
      const temp = `${source}.${crypto.randomUUID()}.part`;
      try {
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(300_000) });
        if (!response.ok || !response.body) throw new Error(`Failed to fetch video: ${response.status}`);
        await pipeline(Readable.fromWeb(response.body as any), fs.createWriteStream(temp, { flags: 'wx' }));
        // Do not publish an invalid download to the reusable cache.
        await isCompatible(temp);
        fs.renameSync(temp, source);
      } finally { fs.rmSync(temp, { force: true }); }
    }
    return prepareVideoForDelivery(source);
  })();
  remoteLocks.set(hash, pending);
  try { return await pending; } finally { remoteLocks.delete(hash); }
}
