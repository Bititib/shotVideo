import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createMediaPreview, resolvePreviewSource } from '../server/services/mediaPreviewService.js';

let root: string, cache: string, source: string;
beforeAll(async () => {
  sharp.cache(false); // libvips otherwise retains file handles across Windows fixture cleanup.
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'media-preview-'));
  cache = path.join(root, 'cache'); source = path.join(root, 'source.png');
  await sharp({ create: { width: 3840, height: 2160, channels: 3, background: '#589167' } }).png().toFile(source);
});
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

it('deduplicates 4K previews, keeps originals byte-identical and reuses generated files', async () => {
  const original = await fs.readFile(source);
  const results = await Promise.all(Array.from({ length: 5 }, () => createMediaPreview(source, 'image', cache)));
  expect(new Set(results).size).toBe(1);
  const result = results[0], before = await fs.stat(result);
  expect(await sharp(result).metadata()).toMatchObject({ format: 'webp', width: 640, height: 360 });
  expect(before.size).toBeLessThan(original.length);
  expect(await fs.readFile(source)).toEqual(original);
  expect(await createMediaPreview(source, 'image', cache)).toBe(result);
  expect((await fs.stat(result)).mtimeMs).toBe(before.mtimeMs);
  expect((await fs.readdir(cache)).some(file => file.includes('.tmp.'))).toBe(false);
});

it('invalidates derivatives when source changes and does not upscale small images', async () => {
  const small = path.join(root, 'small.png');
  await sharp({ create: { width: 40, height: 20, channels: 3, background: 'red' } }).png().toFile(small);
  const first = await createMediaPreview(small, 'image', cache);
  expect(await sharp(first).metadata()).toMatchObject({ width: 40, height: 20 });
  await sharp({ create: { width: 80, height: 40, channels: 3, background: 'blue' } }).png().toFile(small);
  expect(await createMediaPreview(small, 'image', cache)).not.toBe(first);
});

it('contains paths including encoded traversal and directory symlinks', async () => {
  expect(await resolvePreviewSource(root, '/source.png')).toBe(await fs.realpath(source));
  for (const url of ['/../secret.png', '/%2e%2e/secret.png', '/%5c..%5csecret.png', '/%00.png']) {
    await expect(resolvePreviewSource(root, url)).rejects.toThrow();
  }
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'secret.png'), 'private');
    await fs.symlink(outside, path.join(root, 'escape'), 'junction');
    await expect(resolvePreviewSource(root, '/escape/secret.png')).rejects.toThrow();
  } finally {
    await fs.rm(path.join(root, 'escape'), { force: true, recursive: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

it('does not leave corrupt output and lets subsequent conversions continue', async () => {
  const invalid = path.join(root, 'invalid.png'); await fs.writeFile(invalid, 'not an image');
  await expect(createMediaPreview(invalid, 'image', cache)).rejects.toThrow();
  expect(await createMediaPreview(source, 'image', cache)).toBeTruthy();
  expect((await fs.readdir(cache)).some(file => file.includes('.tmp.'))).toBe(false);
});

let ffmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { ffmpeg = false; }
it.skipIf(!ffmpeg)('extracts and reuses a JPEG poster without changing the playable source', async () => {
  const video = path.join(root, 'video.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:r=5:d=0.4', '-c:v', 'libx264', '-threads', '1', video]);
  const original = await fs.readFile(video);
  const poster = await createMediaPreview(video, 'poster', cache);
  expect(await sharp(poster).metadata()).toMatchObject({ format: 'jpeg', width: 640, height: 360 });
  expect(await fs.readFile(video)).toEqual(original);
  expect(await createMediaPreview(video, 'poster', cache)).toBe(poster);
});
