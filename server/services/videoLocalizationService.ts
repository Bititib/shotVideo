import { isHayaChannel, shouldSendHayaAuthorization, hayaTaskUrl } from './hayaVideoAdapter.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { prepareVideoForDelivery } from './videoCompatibilityService.js';
import { ChannelService } from './channelService.js';
import { isHmStudioChannel, shouldSendHmStudioAuthorization } from './hmStudioAdapter.js';
import { isLongxiaChannel } from './longxiaVideoAdapter.js';
import { isMiaowuChannel, shouldSendMiaowuAuthorization } from './miaowuVideoAdapter.js';
import { isWxHaidiYueChannel, shouldSendWxHaidiYueAuthorization } from './wxHaidiYueAdapter.js';

export function originalVideoPathFor(filePath: string): string {
  const extension = path.extname(filePath);
  return extension ? `${filePath.slice(0, -extension.length)}.original${extension}` : `${filePath}.original`;
}

// Prefer H.264; a valid original remains available if conversion fails.
export const preferredVideoDownloadPath = prepareVideoForDelivery;

function localVideoUrl(filePath: string): string {
  return '/uploads/' + path.relative(path.resolve('data/uploads'), filePath).split(path.sep).join('/');
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
  if (url.startsWith('/uploads/')) {
    const { resolveBatchArchiveFile } = await import('./videoBatchArchive.js');
    return localVideoUrl(await prepareVideoForDelivery(resolveBatchArchiveFile(url, path.resolve('data/uploads'))));
  }

  const exactChannel = channelId ? ChannelService.getChannelRaw(channelId, channelApiKeyId) : null;
  const channel = exactChannel || ChannelService.findChannelForModel(model);
  const headers: Record<string, string> = {};
  const maySendAuthorization = isHayaChannel(channel) ? shouldSendHayaAuthorization(url, channel.baseUrl) : isHmStudioChannel(channel)
    ? shouldSendHmStudioAuthorization(url, channel.baseUrl)
    : isWxHaidiYueChannel(channel)
      ? shouldSendWxHaidiYueAuthorization(url, channel.baseUrl)
      : (isMiaowuChannel(channel) || isLongxiaChannel(channel))
        ? shouldSendMiaowuAuthorization(url, channel.baseUrl)
        : true;
  if (channel?.apiKey && maySendAuthorization) headers.Authorization = `Bearer ${channel.apiKey}`;

  const uploadDir = path.join(process.cwd(), 'data', 'uploads', 'videos');
  fs.mkdirSync(uploadDir, { recursive: true });

  const safeId = `${model}_${videoId}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 160);
  for (const extension of ['mp4', 'webm']) {
    const existingName = `video_${safeId}.${extension}`;
    const existingPath = path.join(uploadDir, existingName);
    if (fs.existsSync(existingPath) && fs.statSync(existingPath).size > 0) {
      return localVideoUrl(await prepareVideoForDelivery(existingPath));
    }
  }

  let response = await fetch(url, { headers, signal: AbortSignal.timeout(300_000) });
  // Expired signatures are not failed generations. Retry the authenticated content endpoint.
  if (isHayaChannel(channel) && [401, 403, 409].includes(response.status)) {
    response = await fetch(hayaTaskUrl(channel.baseUrl, videoId) + '/content', {
      headers: { Authorization: 'Bearer ' + channel.apiKey }, signal: AbortSignal.timeout(300_000),
    });
  }
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
    const compatiblePath = await prepareVideoForDelivery(finalPath);
    return localVideoUrl(compatiblePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }

}
