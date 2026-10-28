import { responseDiagnostic, upstreamDiagnostic } from './upstreamDiagnostic.js';
import { isHussChannel, fetchHussVideoContent, HussApiError } from './hussVideoAdapter.js';
import { isMegabyChannel, megabyContentUrl, fetchMegabyVideoContent, readMegabyJson } from './megabyVideoAdapter.js';
import { zonghengTaskUrl } from './zonghengAdapter.js';
import { fetchV6kVideoContent } from './v6kVideoContent.js';
import { isAsyncVideoChannel, resolveAsyncVideoUrl } from './asyncVideoAdapter.js';
import { isFunAiChannel, shouldSendFunAiAuthorization, funAiTaskUrl } from './funAiAdapter.js';
import { isZonghengChannel } from './zonghengAdapter.js';
import { isHayaChannel, shouldSendHayaAuthorization, hayaTaskUrl } from './hayaVideoAdapter.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { prepareVideoForDelivery } from './videoCompatibilityService.js';
import { createMediaPreview } from './mediaPreviewService.js';
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
  // Prepare the card cover without delaying completion or making users download video for a preview.
  void createMediaPreview(filePath, 'poster').catch(() => {});
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
  const authenticatedV6kContent = channel && isZonghengChannel(channel) && url === zonghengTaskUrl(channel.baseUrl, videoId) + '/content';
  const headers: Record<string, string> = {};
  const maySendAuthorization = isHussChannel(channel) ? false : isMegabyChannel(channel) ? false : isAsyncVideoChannel(channel) ? false : isFunAiChannel(channel) ? shouldSendFunAiAuthorization(url, channel.baseUrl) : isZonghengChannel(channel) ? Boolean(authenticatedV6kContent) : isHayaChannel(channel) ? shouldSendHayaAuthorization(url, channel.baseUrl) : isHmStudioChannel(channel)
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

  const hssContent = isHussChannel(channel) && model === 'hss-2.5-301010' && videoId.startsWith('video_');
  let response = authenticatedV6kContent ? await fetchV6kVideoContent(channel, videoId) : hssContent ? await fetchHussVideoContent(channel, videoId) : isMegabyChannel(channel) ? await fetchMegabyVideoContent(channel, url, videoId) : await fetch(url, { headers, signal: AbortSignal.timeout(300_000) });
  // HUSS documents /content as an alternative to the signed media URL.
  // One read-only fallback per save attempt; never recreate the generation.
  let hussContentFallback = hssContent;
  if (!hssContent && isHussChannel(channel) && [401, 403, 404].includes(response.status)) {
    await response.body?.cancel();
    hussContentFallback = true;
    response = await fetchHussVideoContent(channel, videoId);
  }
  if (isMegabyChannel(channel) && [401, 403, 404].includes(response.status) && url !== megabyContentUrl(channel.baseUrl, videoId)) response = await fetchMegabyVideoContent(channel, megabyContentUrl(channel.baseUrl, videoId), videoId);
  if (!response.ok && isMegabyChannel(channel)) await readMegabyJson(channel, response, 'query');
  if (isAsyncVideoChannel(channel) && [401, 403, 404].includes(response.status)) {
    const freshUrl = await resolveAsyncVideoUrl(channel, videoId);
    response = await fetch(freshUrl, { signal: AbortSignal.timeout(300_000), redirect: 'error' });
  }
  // Expired signatures are not failed generations. Retry the authenticated content endpoint.
  if (isHayaChannel(channel) && [401, 403, 409].includes(response.status)) {
    response = await fetch(hayaTaskUrl(channel.baseUrl, videoId) + '/content', {
      headers: { Authorization: 'Bearer ' + channel.apiKey }, signal: AbortSignal.timeout(300_000),
    });
  }
  if (isFunAiChannel(channel) && [401, 403, 404].includes(response.status) && url !== funAiTaskUrl(channel.baseUrl, videoId) + '/content') {
    response = await fetch(funAiTaskUrl(channel.baseUrl, videoId) + '/content', {
      headers: { Authorization: 'Bearer ' + channel.apiKey }, signal: AbortSignal.timeout(300_000), redirect: 'error',
    });
  }
  if (!response.ok && isHussChannel(channel)) {
    const retry = response.headers.get('retry-after') || '';
    const retryAfterMs = /^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now()) || 0;
    const stage = hussContentFallback ? '原任务 /content 回退下载' : '结果下载';
    // HUSS redirects media downloads to TOS, whose errors use capitalized fields.
    // This is a download diagnostic, never evidence of a failed generation.
    const payload = await response.clone().json().catch(() => null);
    if (typeof payload?.Code === 'string' && typeof payload?.Message === 'string') {
      const timing = ['ExpiresSeconds', 'Expires', 'ServerTime'].filter(key =>
        typeof payload[key] === 'string' || typeof payload[key] === 'number')
        .map(key => `${key}=${payload[key]}`).join('; ');
      throw new HussApiError(upstreamDiagnostic('HUSS/TOS', stage, {
        code: payload.Code, message: payload.Message + (timing ? '; ' + timing : ''),
      }, channel.apiKey, response.status, payload.RequestId), response.status, false, retryAfterMs);
    }
    throw new HussApiError(await responseDiagnostic('HUSS', stage, response, channel.apiKey), response.status, false, retryAfterMs);
  }
  if (isHussChannel(channel) && response.status === 202) {
    throw new Error(await responseDiagnostic('HUSS', '原任务下载仍在准备，继续查询原任务', response, channel.apiKey));
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
