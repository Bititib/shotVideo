import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { aspectRatios } from './fixtures.mjs';

const run = promisify(execFile);
export async function ffmpeg(args, cwd) {
  await run('ffmpeg', ['-nostdin', '-y', '-hide_banner', '-v', 'error', ...args], {
    cwd, timeout: 180_000, maxBuffer: 1_048_576, windowsHide: true,
  });
}

export async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], {
    timeout: 15_000, windowsHide: true, maxBuffer: 1_048_576,
  });
  return JSON.parse(stdout);
}

export function resolveDimensions(ratioId = '9:16') {
  const found = aspectRatios.find(r => r.id === ratioId) || aspectRatios[0];
  return { width: found.width, height: found.height, id: found.id };
}

export function detectAspectRatio(info) {
  const v = info?.streams?.find(s => s.codec_type === 'video');
  const w = Number(v?.width || 0);
  const h = Number(v?.height || 0);
  if (!w || !h) return '9:16';
  if (w > h * 1.15) return '16:9';
  if (Math.abs(w - h) <= Math.max(w, h) * 0.15) return '1:1';
  return '9:16';
}

export async function fixtureFrame(input, output, crop, ratioId = '9:16') {
  const { width, height } = resolveDimensions(ratioId);
  let image = sharp(input);
  if (crop) image = image.extract(crop);
  await image.resize(width, height, { fit: 'cover', position: 'centre' }).png().toFile(output);
}

export async function animateFrame(input, output, seconds, variant = 0, camera = 'auto', ratioId = '9:16') {
  // Local mock motion only. Every video opens on the exact confirmed frame; camera & variants vary pan/zoom.
  const { width, height } = resolveDimensions(ratioId);
  const count = Math.max(1, Math.round(seconds * 24));
  const speed = [0.00035, 0.0006, 0.0002, 0.00048][(variant || 0) % 4];
  let expr = `z='min(1+on*${speed},1.12)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2'`;
  if (camera === 'static') {
    expr = `z='1':x='0':y='0'`;
  } else if (camera === 'pull_out') {
    expr = `z='max(1.12-on*${speed},1)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2'`;
  } else if (camera === 'pan_left') {
    expr = `z='1.10':x='max((iw-iw/zoom)*(1-on/${count}),0)':y='ih/2-ih/zoom/2'`;
  } else if (camera === 'pan_right') {
    expr = `z='1.10':x='min((iw-iw/zoom)*(on/${count}),iw-iw/zoom)':y='ih/2-ih/zoom/2'`;
  } else if (camera === 'tilt_up') {
    expr = `z='1.10':x='iw/2-iw/zoom/2':y='max((ih-ih/zoom)*(1-on/${count}),0)'`;
  } else if (camera === 'tilt_down') {
    expr = `z='1.10':x='iw/2-iw/zoom/2':y='min((ih-ih/zoom)*(on/${count}),ih-ih/zoom)'`;
  } else if (camera === 'handheld') {
    expr = `z='1.06':x='iw/2-iw/zoom/2+sin(on/4)*8':y='ih/2-ih/zoom/2+cos(on/5)*6'`;
  } else if (camera === 'dolly_zoom') {
    expr = `z='min(1+on*0.0012,1.22)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2'`;
  }
  const filter = `zoompan=${expr}:d=${count}:s=${width}x${height}:fps=24,format=yuv420p`;
  await ffmpeg(['-i', input, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-vf', filter, '-t', String(seconds), '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264',
    '-threads', '2', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', output]);
}

export function captions(plan, vtt = false) {
  const stamp = seconds => new Date(seconds * 1000).toISOString().slice(11, 23).replace('.', vtt ? '.' : ',');
  return (vtt ? 'WEBVTT\n\n' : '') + plan.shots.map((shot, i) =>
    `${i + 1}\n${stamp(shot.start)} --> ${stamp(shot.end)}\n${(shot.caption || ' ').replace(/[<>\r\n]/g, ' ')}\n`).join('\n');
}

export async function assemble(files, output, plan, options = {}) {
  const folder = path.dirname(output);
  const normalized = [];
  const concatFile = path.join(folder, 'concat.txt');
  const srtFile = path.join(folder, 'captions.srt');
  try {
    for (let i = 0; i < files.length; i++) {
      // Every input is a server-controlled local path, never an upstream URL.
      const destination = path.join(folder, 'assemble-' + i + '.mp4');
      await ffmpeg(['-i', files[i], '-t', String(plan.shots[i].end - plan.shots[i].start),
        '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', destination]);
      normalized.push(destination);
    }
    await fs.writeFile(concatFile, normalized.map(file => "file '" + path.basename(file) + "'").join('\n'));
    await fs.writeFile(srtFile, captions(plan), 'utf8');
    await fs.writeFile(path.join(folder, 'captions.vtt'), captions(plan, true), 'utf8');

    const sourceFile = options.sourceFile || path.join(folder, 'source.mp4');
    let useOriginalAudio = options.audioMode !== 'mute' && existsSync(sourceFile);
    if (useOriginalAudio) {
      try {
        const srcInfo = await probe(sourceFile);
        useOriginalAudio = Boolean(srcInfo.streams?.some(s => s.codec_type === 'audio'));
      } catch {
        useOriginalAudio = false;
      }
    }

    if (useOriginalAudio) {
      await ffmpeg([
        '-f', 'concat', '-safe', '1', '-i', 'concat.txt',
        '-f', 'srt', '-i', 'captions.srt',
        '-i', path.basename(sourceFile),
        '-t', String(plan.duration),
        '-map', '0:v:0', '-map', '2:a:0', '-map', '1:s:0',
        '-c:v', 'copy', '-c:a', 'aac', '-c:s', 'mov_text',
        '-disposition:s:0', 'default', '-shortest', '-movflags', '+faststart', output,
      ], folder);
    } else {
      await ffmpeg([
        '-f', 'concat', '-safe', '1', '-i', 'concat.txt',
        '-f', 'srt', '-i', 'captions.srt',
        '-map', '0:v:0', '-map', '0:a:0', '-map', '1:s:0',
        '-c:v', 'copy', '-c:a', 'copy', '-c:s', 'mov_text',
        '-disposition:s:0', 'default', '-movflags', '+faststart', output,
      ], folder);
    }

    const info = await probe(output);
    if (!info.streams.some(stream => stream.codec_name === 'h264') || Math.abs(Number(info.format.duration) - plan.duration) > .2) {
      throw new Error('合成结果的格式或时长验证失败');
    }
  } finally {
    // Always clean up intermediate slice files and temporary concat/srt manifests (captions.vtt is kept for web preview).
    await Promise.all([
      ...normalized.map(f => fs.rm(f, { force: true }).catch(() => {})),
      fs.rm(concatFile, { force: true }).catch(() => {}),
      fs.rm(srtFile, { force: true }).catch(() => {}),
    ]);
  }
}
