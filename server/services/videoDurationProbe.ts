import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { lookup } from 'node:dns/promises';
import fs from 'node:fs/promises';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { uploadPath } from './uploadAccess.js';

const run = promisify(execFile);
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const cache = new Map<string, Promise<number>>();
type MediaKind = 'video' | 'audio';

function blockedAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
      || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19].includes(b) || a >= 224;
  }
  const ip = address.toLowerCase();
  return ip === '::' || ip === '::1' || ip.startsWith('::ffff:') || /^(fc|fd|fe[89ab]|ff)/.test(ip);
}

async function assertPublicHttps(url: URL, kind: MediaKind) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || host === 'localhost' || /\.(local|localhost)$/i.test(host)) {
    throw new Error(`参考${kind === 'video' ? '视频' : '音频'}须为本站上传文件或公网 HTTPS 直链`);
  }
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => blockedAddress(item.address))) throw new Error(`参考${kind === 'video' ? '视频' : '音频'}地址不能指向内网`);
}

async function downloadRemote(source: string, target: string, kind: MediaKind, maxBytes: number) {
  const label = kind === 'video' ? '视频' : '音频';
  let url = new URL(source);
  for (let redirects = 0; redirects <= 3; redirects++) {
    await assertPublicHttps(url, kind);
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`参考${label}重定向地址无效`);
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`参考${label}读取失败 (${response.status})`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new Error(`参考${label}不能超过 ${kind === 'video' ? '100MB' : '15MB'}`);
    const handle = await fs.open(target, 'wx');
    let size = 0;
    try {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > maxBytes) throw new Error(`参考${label}不能超过 ${kind === 'video' ? '100MB' : '15MB'}`);
          await handle.write(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    } finally {
      await handle.close();
    }
    if (!size) throw new Error(`参考${label}为空`);
    return;
  }
  throw new Error(`参考${label}重定向次数过多`);
}

async function materialize(source: string, target: string, kind: MediaKind, maxBytes: number): Promise<{ file: string; temporary: boolean }> {
  const label = kind === 'video' ? '视频' : '音频';
  if (source.startsWith('data:')) {
    const match = new RegExp(`^data:${kind}\\/[^;,]+;base64,([A-Za-z0-9+/=\\s]+)$`).exec(source);
    if (!match || match[1].replace(/\s/g, '').length > Math.ceil(maxBytes / 3) * 4) {
      throw new Error(`参考${label}格式无效或超过 ${kind === 'video' ? '100MB' : '15MB'}`);
    }
    const bytes = Buffer.from(match[1], 'base64');
    if (!bytes.length || bytes.length > maxBytes) throw new Error(`参考${label}为空或超过 ${kind === 'video' ? '100MB' : '15MB'}`);
    await fs.writeFile(target, bytes, { flag: 'wx' });
    return { file: target, temporary: true };
  }

  const localResource = uploadPath(source);
  if (localResource) {
    const root = await fs.realpath(path.resolve('data/uploads'));
    const relative = localResource.replace(/^\/uploads\//, '');
    const candidate = await fs.realpath(path.resolve(root, relative));
    if (!candidate.startsWith(root + path.sep)) throw new Error(`参考${label}路径无效`);
    const stat = await fs.stat(candidate);
    if (!stat.isFile() || !stat.size || stat.size > maxBytes) throw new Error(`参考${label}为空或超过 ${kind === 'video' ? '100MB' : '15MB'}`);
    return { file: candidate, temporary: false };
  }

  try {
    await downloadRemote(source, target, kind, maxBytes);
    return { file: target, temporary: true };
  } catch (error) {
    await fs.rm(target, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function uncachedProbe(source: string, kind: MediaKind): Promise<number> {
  const target = path.join(os.tmpdir(), `${kind}-duration-${crypto.randomUUID()}.bin`);
  let materialized: { file: string; temporary: boolean } | undefined;
  try {
    materialized = await materialize(source, target, kind, kind === 'video' ? MAX_VIDEO_BYTES : MAX_AUDIO_BYTES);
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', kind === 'video' ? 'v:0' : 'a:0', '-show_entries',
      'format=duration:stream=duration', '-of', 'json', materialized.file], { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
    const info = JSON.parse(stdout);
    if (kind === 'audio' && !info?.streams?.length) throw new Error('参考音频没有可读取的音频流');
    const seconds = Number(info?.format?.duration || info?.streams?.[0]?.duration);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`无法读取参考${kind === 'video' ? '视频' : '音频'}时长`);
    return Math.round(seconds * 1000) / 1000;
  } finally {
    if (materialized?.temporary) await fs.rm(materialized.file, { force: true }).catch(() => undefined);
  }
}

export async function probeVideoDurationSeconds(source: string): Promise<number> {
  if (!source || typeof source !== 'string') throw new Error('参考视频地址无效');
  const key = `video:${crypto.createHash('sha256').update(source).digest('hex')}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = uncachedProbe(source, 'video');
    if (cache.size >= 200) cache.delete(cache.keys().next().value!);
    cache.set(key, pending);
    pending.catch(() => cache.delete(key));
  }
  return pending;
}

export async function probeAudioDurationSeconds(source: string): Promise<number> {
  if (!source || typeof source !== 'string') throw new Error('参考音频地址无效');
  const key = `audio:${crypto.createHash('sha256').update(source).digest('hex')}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = uncachedProbe(source, 'audio');
    if (cache.size >= 200) cache.delete(cache.keys().next().value!);
    cache.set(key, pending);
    pending.catch(() => cache.delete(key));
  }
  return pending;
}

export function roundUpVideoDurationTenths(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('参考视频时长无效');
  return Math.ceil((seconds - Number.EPSILON) * 10) / 10;
}

export async function probeReferenceVideoSeconds(sources: string[]): Promise<{ rawDurations: number[]; durations: number[]; total: number }> {
  const rawDurations = await Promise.all(sources.map(probeVideoDurationSeconds));
  const durations = rawDurations.map(roundUpVideoDurationTenths);
  return { rawDurations, durations, total: Math.round(durations.reduce((sum, seconds) => sum + seconds, 0) * 10) / 10 };
}

export async function probeReferenceAudioSeconds(sources: string[]): Promise<{ rawDurations: number[]; durations: number[]; total: number }> {
  const rawDurations = await Promise.all(sources.map(probeAudioDurationSeconds));
  const durations = rawDurations.map(roundUpVideoDurationTenths);
  return { rawDurations, durations, total: Math.round(durations.reduce((sum, seconds) => sum + seconds, 0) * 10) / 10 };
}
