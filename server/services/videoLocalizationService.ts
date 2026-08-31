import crypto from 'crypto';
import { execSync, exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { ChannelService } from './channelService.js';
import { isHmStudioChannel, shouldSendHmStudioAuthorization } from './hmStudioAdapter.js';
import { isWxHaidiYueChannel, shouldSendWxHaidiYueAuthorization } from './wxHaidiYueAdapter.js';

const execPromise = promisify(exec);

export function detectVideoCodec(filePath: string): string {
  try {
    return execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: 'utf8' },
    ).trim().toLowerCase();
  } catch {
    return '';
  }
}

async function ensureBrowserCompatibleVideo(filePath: string): Promise<void> {
  if (detectVideoCodec(filePath) !== 'hevc') return;

  const transcodedPath = `${filePath}.${crypto.randomUUID()}.h264.mp4`;
  try {
    console.log(`[video] HEVC detected; transcoding localized video to H.264: ${filePath}`);
    await execPromise(
      `ffmpeg -y -i "${filePath}" -c:v libx264 -tag:v avc1 -pix_fmt yuv420p -preset superfast -movflags +faststart -c:a copy "${transcodedPath}"`,
    );
    fs.renameSync(transcodedPath, filePath);
    console.log(`[video] Browser-compatible H.264 video ready: ${filePath}`);
  } finally {
    if (fs.existsSync(transcodedPath)) fs.unlinkSync(transcodedPath);
  }
}

/** Download a completed upstream video to durable VPS storage. */
export async function downloadAndLocalizeVideo(
  url: string,
  videoId: string,
  model: string,
  channelId?: number | null,
  channelApiKeyId?: number | null,
): Promise<string> {
  if (!url) throw new Error('Upstream completed without a video URL');
  if (url.startsWith('/uploads/')) return url;

  const exactChannel = channelId ? ChannelService.getChannelRaw(channelId, channelApiKeyId) : null;
  const channel = exactChannel || ChannelService.findChannelForModel(model);
  const headers: Record<string, string> = {};
  const maySendAuthorization = isHmStudioChannel(channel)
    ? shouldSendHmStudioAuthorization(url, channel.baseUrl)
    : isWxHaidiYueChannel(channel)
      ? shouldSendWxHaidiYueAuthorization(url, channel.baseUrl)
      : true;
  if (channel?.apiKey && maySendAuthorization) headers.Authorization = `Bearer ${channel.apiKey}`;

  const uploadDir = path.join(process.cwd(), 'data', 'uploads', 'videos');
  fs.mkdirSync(uploadDir, { recursive: true });

  const safeId = `${model}_${videoId}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 160);
  for (const extension of ['mp4', 'webm']) {
    const existingName = `video_${safeId}.${extension}`;
    const existingPath = path.join(uploadDir, existingName);
    if (fs.existsSync(existingPath) && fs.statSync(existingPath).size > 0) {
      await ensureBrowserCompatibleVideo(existingPath);
      return `/uploads/videos/${existingName}`;
    }
  }

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`Failed to fetch video from upstream: ${response.status} ${response.statusText}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error('Upstream returned an empty video file');

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const isMp4 = buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp';
  const isWebm = buffer.length >= 4
    && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3;
  if (!contentType.startsWith('video/') && !isMp4 && !isWebm) {
    throw new Error(`Upstream response is not a video (${contentType || 'unknown content type'})`);
  }

  const extension = isWebm && !isMp4 ? 'webm' : 'mp4';
  const filename = `video_${safeId}.${extension}`;
  const finalPath = path.join(uploadDir, filename);
  const tempPath = `${finalPath}.${crypto.randomUUID()}.part`;
  try {
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, finalPath);
    await ensureBrowserCompatibleVideo(finalPath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }

  console.log(`[video] Video localized to VPS: /uploads/videos/${filename}`);
  return `/uploads/videos/${filename}`;
}
