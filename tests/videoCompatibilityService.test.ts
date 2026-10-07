import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { ensureH264Video, prepareVideoForDelivery, videoDeliveryContentType, cacheVideoForDelivery } from '../server/services/videoCompatibilityService.js';
import { h264Uploads } from '../server/middleware/h264Uploads.js';

let available = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); }
catch { available = false; }

describe.skipIf(!available)('real H.264 delivery', () => {
  let directory: string, hevc: string, avc: string, webm: string, server: Server, origin: string;
  const probe = (file: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], { encoding: 'utf8' }));
  const makeVideo = (name: string, codec: string, extra: string[] = []) => {
    const file = path.join(directory, name);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=64x64:r=5:d=0.4',
      '-c:v', codec, '-pix_fmt', 'yuv420p', '-threads', '1', ...extra, file], { stdio: 'pipe' });
    return file;
  };
  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'h264-test-'));
    hevc = makeVideo('historical.mp4', 'libx265', ['-x265-params', 'pools=1:frame-threads=1:log-level=error']);
    avc = makeVideo('compatible.mp4', 'libx264');
    webm = makeVideo('vp9.webm', 'libvpx-vp9');
    const app = express();
    app.use('/uploads', (req, res, next) => {
      if (req.headers.authorization !== 'Bearer owner') { res.status(404).end(); return; }
      res.setHeader('Cache-Control', 'private, no-store'); next();
    }, h264Uploads(directory));
    server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });
  it('converts HEVC once under concurrent requests, preserves source and puts moov first', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => ensureH264Video(hevc)));
    expect(new Set(results).size).toBe(1);
    const output = results[0];
    expect(probe(output).streams[0]).toMatchObject({ codec_name: 'h264', pix_fmt: 'yuv420p' });
    expect(probe(hevc).streams[0].codec_name).toBe('hevc');
    const bytes = fs.readFileSync(output);
    expect(bytes.indexOf(Buffer.from('moov'))).toBeLessThan(bytes.indexOf(Buffer.from('mdat')));
    const mtime = fs.statSync(output).mtimeMs;
    expect(await ensureH264Video(hevc)).toBe(output);
    expect(fs.statSync(output).mtimeMs).toBe(mtime);
    expect(fs.readdirSync(directory).filter(f => f.includes('.tmp.'))).toEqual([]);
  });
  it('does not re-encode compatible H.264', async () => {
    expect(await ensureH264Video(avc)).toBe(fs.realpathSync(avc));
    expect(fs.existsSync(`${avc}.h264.mp4`)).toBe(false);
  });
  it('converts VP9/WebM too, not just HEVC', async () => {
    expect(probe(await ensureH264Video(webm)).streams[0].codec_name).toBe('h264');
  });
  it('rejects corrupt media instead of returning unknown original bytes', async () => {
    const invalid = path.join(directory, 'broken.mp4'); fs.writeFileSync(invalid, 'invalid');
    await expect(ensureH264Video(invalid)).rejects.toThrow();
    expect(fs.existsSync(`${invalid}.h264.mp4`)).toBe(false);
  });
  it('repairs corrupt compatibility caches', async () => {
    const source = path.join(directory, 'repair.mp4'); fs.copyFileSync(hevc, source);
    fs.writeFileSync(`${source}.h264.mp4`, 'corrupt cache');
    expect(probe(await ensureH264Video(source)).streams[0].codec_name).toBe('h264');
  });
  it('serves historical URLs with H.264 byte ranges and keeps authorization', async () => {
    const url = `${origin}/uploads/historical.mp4`;
    expect((await fetch(url)).status).toBe(404);
    const response = await fetch(url, { headers: { Authorization: 'Bearer owner', Range: 'bytes=0-127' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-range')).toMatch(/^bytes 0-127\//);
    expect(response.headers.get('cache-control')).toContain('private');
    const expected = fs.readFileSync(await ensureH264Video(hevc)).subarray(0, 128);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(expected);
    const head = await fetch(url, { method: 'HEAD', headers: { Authorization: 'Bearer owner' } });
    expect(Number(head.headers.get('content-length'))).toBe(fs.statSync(await ensureH264Video(hevc)).size);
  });
  it('still rejects a corrupt original rather than treating it as a conversion fallback', async () => {
    const response = await fetch(`${origin}/uploads/broken.mp4`, { headers: { Authorization: 'Bearer owner' } });
    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toContain('application/json');
  });
  it('falls back to valid HEVC with Range support when conversion fails, without retrying every request', async () => {
    const source = path.join(directory, 'fallback.mp4');
    fs.copyFileSync(hevc, source);
    // Force the final publish step to fail without modifying the video itself.
    const blockedOutput = `${source}.h264.mp4`;
    fs.mkdirSync(blockedOutput);
    const url = `${origin}/uploads/fallback.mp4`;
    expect((await fetch(url)).status).toBe(404);
    const response = await fetch(url, { headers: { Authorization: 'Bearer owner', Range: 'bytes=0-127' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fs.readFileSync(source).subarray(0, 128));
    expect(probe(source).streams[0].codec_name).toBe('hevc');
    fs.rmdirSync(blockedOutput);
    expect(await prepareVideoForDelivery(source)).toBe(fs.realpathSync(source));
    expect(fs.existsSync(blockedOutput)).toBe(false); // cooldown: no repeated encode
  });
  it('retains WebM content type when falling back, including sources cached with mp4 extensions', async () => {
    const source = path.join(directory, 'webm-fallback.mp4'); fs.copyFileSync(webm, source);
    fs.mkdirSync(`${source}.h264.mp4`);
    const result = await prepareVideoForDelivery(source);
    expect(result).toBe(fs.realpathSync(source));
    expect(videoDeliveryContentType(result)).toBe('video/webm');
  });
  it('shares a verified H.264 cache for concurrent remote downloads and playback', async () => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(directory);
    const remote = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(fs.readFileSync(hevc)));
    try {
      const outputs = await Promise.all(Array.from({ length: 4 }, () => cacheVideoForDelivery('https://example.invalid/video.mp4')));
      expect(remote).toHaveBeenCalledTimes(1);
      expect(new Set(outputs).size).toBe(1);
      expect(probe(outputs[0]).streams[0].codec_name).toBe('h264');
      expect(await cacheVideoForDelivery('https://example.invalid/video.mp4')).toBe(outputs[0]);
      expect(remote).toHaveBeenCalledTimes(1);
    } finally { cwd.mockRestore(); remote.mockRestore(); }
  });
  it('rejects upstream error pages instead of caching/returning them as video', async () => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(directory);
    const remote = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>error</html>'));
    try {
      await expect(cacheVideoForDelivery('https://example.invalid/bad.mp4')).rejects.toThrow();
      expect(fs.readdirSync(path.join(directory, 'data/video_cache')).some(f => f.endsWith('.part'))).toBe(false);
    } finally { cwd.mockRestore(); remote.mockRestore(); }
  });
});
