import { isHussChannel } from './hussVideoAdapter.js';
import { fetchZhiyingVideoContent } from './zhiyingVideoAdapter.js';
import { isZhiyingVideoModel } from '../../shared/zhiyingVideo.js';
import { assertZhiyingOriginalChannel } from './zhiyingVideoExecution.js';
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
import { saveHussVideo, type HussDownloadProgress } from './hussResumableDownload.js';
import { prepareVideoForDelivery } from './videoCompatibilityService.js';
import { createMediaPreview } from './mediaPreviewService.js';
import { ChannelService } from './channelService.js';
import { isHmStudioChannel, shouldSendHmStudioAuthorization } from './hmStudioAdapter.js';
import { isLongxiaChannel } from './longxiaVideoAdapter.js';
import { isMiaowuChannel, shouldSendMiaowuAuthorization } from './miaowuVideoAdapter.js';
import { isWxHaidiYueChannel, shouldSendWxHaidiYueAuthorization } from './wxHaidiYueAdapter.js';
import { assertPublicMediaUrl } from './videoDurationProbe.js';

export function originalVideoPathFor(filePath: string): string {
  const extension = path.extname(filePath);
  return extension ? `${filePath.slice(0, -extension.length)}.original${extension}` : `${filePath}.original`;
}

// Prefer H.264; a valid original remains available if conversion fails.
export const preferredVideoDownloadPath = prepareVideoForDelivery;

function localVideoUrl(filePath: string, preview = true): string {
  // Prepare the card cover without delaying completion or making users download video for a preview.
  if (preview) void createMediaPreview(filePath, 'poster').catch(() => {});
  return '/uploads/' + path.relative(path.resolve('data/uploads'), filePath).split(path.sep).join('/');
}

/** Download a completed upstream video to durable VPS storage. */
export async function downloadAndLocalizeVideo(
  url: string,
  videoId: string,
  model: string,
  channelId?: number | null,
  channelApiKeyId?: number | null,
  onProgress?: (progress: HussDownloadProgress) => void,
  originalCredential?: string,
  restoration?: { channel: NonNullable<ReturnType<typeof ChannelService.getChannelRaw>>; fileId: string },
): Promise<string> {
  if (!url && !isZhiyingVideoModel(model)) throw new Error('Upstream completed without a video URL');
  if (url.startsWith('/uploads/') && !isZhiyingVideoModel(model)) {
    if (restoration) throw new Error('原成品接口返回了本站路径，无法核验来源');
    const { resolveBatchArchiveFile } = await import('./videoBatchArchive.js');
    return localVideoUrl(await prepareVideoForDelivery(resolveBatchArchiveFile(url, path.resolve('data/uploads'))));
  }

  const exactChannel = restoration?.channel ?? (channelId ? ChannelService.getChannelRaw(channelId, channelApiKeyId) : null);
  if (isZhiyingVideoModel(model) && exactChannel?.type !== 'zhiying') throw new Error('智赢原任务渠道不可用，停止下载原结果');
  const channel = exactChannel || ChannelService.findChannelForModel(model);
  if (channel?.type === 'zhiying') assertZhiyingOriginalChannel(channel, { channelId, zhiyingCredential:originalCredential });
  const authenticatedV6kContent = channel && isZonghengChannel(channel) && url === zonghengTaskUrl(channel.baseUrl, videoId) + '/content';
  const headers: Record<string, string> = {};
  const maySendAuthorization = channel?.type === 'zhiying' ? false : isHussChannel(channel) ? false : isMegabyChannel(channel) ? false : isAsyncVideoChannel(channel) ? false : isFunAiChannel(channel) ? shouldSendFunAiAuthorization(url, channel.baseUrl) : isZonghengChannel(channel) ? Boolean(authenticatedV6kContent) : isHayaChannel(channel) ? shouldSendHayaAuthorization(url, channel.baseUrl) : isHmStudioChannel(channel)
    ? shouldSendHmStudioAuthorization(url, channel.baseUrl)
    : isWxHaidiYueChannel(channel)
      ? shouldSendWxHaidiYueAuthorization(url, channel.baseUrl)
      : (isMiaowuChannel(channel) || isLongxiaChannel(channel))
        ? shouldSendMiaowuAuthorization(url, channel.baseUrl)
        : true;
  if (channel?.apiKey && maySendAuthorization) headers.Authorization = `Bearer ${channel.apiKey}`;
  const strictFetch = async (source: string) => {
    if (!restoration) return fetch(source, { headers, signal: AbortSignal.timeout(300_000) });
    const target = new URL(source);
    const sameOrigin = target.origin === new URL(restoration.channel.baseUrl).origin;
    await assertPublicMediaUrl(target, 'video', sameOrigin);
    return fetch(source, { headers: sameOrigin ? headers : {}, redirect: 'error', signal: AbortSignal.timeout(300_000) });
  };

  const uploadDir = path.join(process.cwd(), 'data', 'uploads', 'videos');
  fs.mkdirSync(uploadDir, { recursive: true });

  const safeId = restoration?.fileId ?? (channel?.type === 'zhiying'
    ? 'zhiying_' + channel.id + '_' + crypto.createHash('sha256').update(JSON.stringify([originalCredential, videoId])).digest('hex')
    : `${model}_${videoId}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 160));
  for (const extension of ['mp4', 'webm']) {
    const existingName = `video_${safeId}.${extension}`;
    const existingPath = path.join(uploadDir, existingName);
    if (fs.existsSync(existingPath) && fs.statSync(existingPath).size > 0) {
      return localVideoUrl(await prepareVideoForDelivery(existingPath));
    }
  }

  if (isHussChannel(channel)) {
    return localVideoUrl(await saveHussVideo({ ...channel, id: channelId || undefined, apiKeyId: channelApiKeyId }, videoId,
      path.join(uploadDir, `video_${safeId}`), onProgress, Boolean(restoration)), !restoration);
  }
  let buffer: Buffer;
  let contentType = '';
  if (channel?.type === 'zhiying') {
    buffer = await fetchZhiyingVideoContent(channel, videoId, url, model);
  } else {
    let response = authenticatedV6kContent ? await fetchV6kVideoContent(channel, videoId) : isMegabyChannel(channel) ? await fetchMegabyVideoContent(channel, url, videoId) : await strictFetch(url);
    if (isMegabyChannel(channel) && [401, 403, 404].includes(response.status) && url !== megabyContentUrl(channel.baseUrl, videoId)) response = await fetchMegabyVideoContent(channel, megabyContentUrl(channel.baseUrl, videoId), videoId);
    if (!response.ok && isMegabyChannel(channel)) await readMegabyJson(channel, response, 'query');
    if (isAsyncVideoChannel(channel) && [401, 403, 404].includes(response.status)) {
      const freshUrl = await resolveAsyncVideoUrl(channel, videoId);
      if (restoration) await assertPublicMediaUrl(new URL(freshUrl), 'video');
      response = await fetch(freshUrl, { signal: AbortSignal.timeout(300_000), redirect: 'error' });
    }
    // Expired signatures are not failed generations. Retry the authenticated content endpoint.
    if (isHayaChannel(channel) && [401, 403, 409].includes(response.status)) {
      response = await fetch(hayaTaskUrl(channel.baseUrl, videoId) + '/content', {
        headers: { Authorization: 'Bearer ' + channel.apiKey }, signal: AbortSignal.timeout(300_000),
        ...(restoration ? { redirect: 'error' as const } : {}),
      });
    }
    if (isFunAiChannel(channel) && [401, 403, 404].includes(response.status) && url !== funAiTaskUrl(channel.baseUrl, videoId) + '/content') {
      response = await fetch(funAiTaskUrl(channel.baseUrl, videoId) + '/content', {
        headers: { Authorization: 'Bearer ' + channel.apiKey }, signal: AbortSignal.timeout(300_000), redirect: 'error',
      });
    }
    if (!response.ok) throw new Error(`Failed to fetch video from upstream: ${response.status} ${response.statusText}`);
    if (restoration && response.status !== 200) {
      await response.body?.cancel();
      throw new Error('原成品接口未返回完整视频（HTTP ' + response.status + '）');
    }

    buffer = Buffer.from(await response.arrayBuffer());
    const length = response.headers.get('content-length');
    if (restoration && length && !response.headers.get('content-encoding') && Number(length) !== buffer.length)
      throw new Error('原视频收到的字节数与响应声明不一致');
    contentType = (response.headers.get('content-type') || '').toLowerCase();
  }
  if (buffer.length === 0) throw new Error('Upstream returned an empty video file');
  const isMp4 = buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp';
  const isWebm = buffer.length >= 4
    && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3;
  if (!isMp4 && !isWebm && (restoration || !contentType.startsWith('video/'))) {
    throw new Error(`Upstream response is not a video (${contentType || 'unknown content type'})`);
  }

  const extension = isWebm && !isMp4 ? 'webm' : 'mp4';
  const filename = `video_${safeId}.${extension}`;
  const finalPath = path.join(uploadDir, filename);
  const tempPath = `${finalPath}.${crypto.randomUUID()}.part`;
  try {
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, finalPath);
    if (restoration) return localVideoUrl(finalPath, false);
    const compatiblePath = await prepareVideoForDelivery(finalPath);
    return localVideoUrl(compatiblePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }

}
