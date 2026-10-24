import { defaultRoutingLimits, type ModelInputLimits } from '../../shared/modelRouting.js';
import { ASYNC_VIDEO_CHANNEL_TYPE, VX_LE_SEEDANCE_MODEL, asyncVideoConfirmedLimits } from '../../shared/asyncVideo.js';
export { ASYNC_VIDEO_CHANNEL_TYPE } from '../../shared/asyncVideo.js';

/** The documented /videos/generations + /tasks protocol, distinct from /v1/videos. */
export type AsyncVideoChannel = { type?: string | null; baseUrl: string; apiKey: string; timeout?: number };
export const isAsyncVideoChannel = (channel: { type?: string | null } | null | undefined) => channel?.type === ASYNC_VIDEO_CHANNEL_TYPE;
export const asyncVideoBaseUrl = (baseUrl: string) => baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
export const asyncVideoCreateUrl = (baseUrl: string) => asyncVideoBaseUrl(baseUrl) + '/v1/videos/generations';
export const asyncVideoTaskUrl = (baseUrl: string, id: string) => asyncVideoBaseUrl(baseUrl) + '/v1/tasks/' + encodeURIComponent(id);

export function buildAsyncVideoPayload(input: {
  model: string; prompt: string; seconds: number; ratio: string; images: string[];
  videos: string[]; audios: string[]; firstFrame: string; lastFrame: string;
}) {
  if (input.videos.length || input.audios.length || input.firstFrame || input.lastFrame) {
    throw new Error('异步视频渠道仅支持文本和图片参考，不支持视频、音频或独立首尾帧');
  }
  if (!Number.isInteger(input.seconds) || input.seconds <= 0) throw new Error('视频时长必须为正整数');
  if (input.model === VX_LE_SEEDANCE_MODEL) {
    if (input.seconds !== 15) throw new Error(`${VX_LE_SEEDANCE_MODEL} 固定生成 15 秒视频`);
    if (input.images.length > 9) throw new Error(`${VX_LE_SEEDANCE_MODEL} 最多支持 9 张参考图`);
  }
  for (const source of input.images) {
    const url = new URL(source);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('参考图必须使用公网 HTTP/HTTPS 链接');
  }
  return { model: input.model, prompt: input.prompt.trim(), seconds: input.seconds, aspect_ratio: input.ratio,
    ...(input.images.length ? { reference_images: input.images } : {}) };
}

async function getJson(channel: AsyncVideoChannel, url: string, fetchImpl: typeof fetch) {
  const response = await fetchImpl(url, { headers: { Authorization: 'Bearer ' + channel.apiKey },
    signal: AbortSignal.timeout(channel.timeout || 30_000), redirect: 'error' });
  // Do not expose provider response bodies, which may contain credentials or signed URLs.
  if (!response.ok) throw new Error(await responseDiagnostic('Vx-乐', '查询', response, channel.apiKey));
  return diagnosticJson('Vx-乐', '查询', response, channel.apiKey);
}

export function normalizeAsyncVideoTask(raw: any) {
  const status = String(raw?.status || '').toLowerCase();
  if (!['pending', 'processing', 'completed', 'failed'].includes(status)) throw new Error(upstreamDiagnostic('Vx-乐', '异步视频返回了未知任务状态 ' + status, raw));
  return { status, progress: status === 'completed' ? 100 : 0, resultUrl: '',
    error: status === 'failed' ? upstreamDiagnostic('Vx-乐', '任务失败', { error: raw.error, error_message: raw.error_message, error_code: raw.error_code }) : '' };
}

/** Always resolve with the API key: signed resolver links expire after five minutes. */
export async function resolveAsyncVideoUrl(channel: AsyncVideoChannel, id: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const raw = await getJson(channel, asyncVideoTaskUrl(channel.baseUrl, id) + '/url', fetchImpl);
  if (typeof raw?.url !== 'string') throw new Error('异步视频未返回 CDN 直链');
  const url = new URL(raw.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('异步视频返回了无效的视频直链');
  return url.href;
}

export async function pollAsyncVideo(channel: AsyncVideoChannel, id: string, fetchImpl: typeof fetch = fetch) {
  const task = normalizeAsyncVideoTask(await getJson(channel, asyncVideoTaskUrl(channel.baseUrl, id), fetchImpl));
  if (task.status === 'completed') task.resultUrl = await resolveAsyncVideoUrl(channel, id, fetchImpl);
  return task;
}

export type AsyncVideoModel = { name: string; limits: ModelInputLimits };
export async function fetchAsyncVideoModels(channel: AsyncVideoChannel, fetchImpl: typeof fetch = fetch): Promise<AsyncVideoModel[]> {
  const raw = await getJson(channel, asyncVideoBaseUrl(channel.baseUrl) + '/v1/models', fetchImpl);
  if (!Array.isArray(raw?.data)) throw new Error('异步视频模型列表格式无效');
  const entries = raw.data.map((model: any) => {
    // `id` is the numeric database ID; generation requires `name`.
    if (typeof model?.name !== 'string' || !model.name.trim()) throw new Error('异步视频模型缺少名称');
    const ratios = String(model.ratio || '9:16,16:9,1:1').split(',').map(v => v.trim());
    const seconds = String(model.seconds || '5,10,15').split(',').map(v => Number(v.trim()));
    if (!ratios.length || ratios.some(v => !/^\d+:\d+$/.test(v)) || !seconds.length || seconds.some(v => !Number.isInteger(v) || v <= 0 || v > 3600)) {
      throw new Error('异步视频模型比例或时长配置无效');
    }
    const values = [...new Set(seconds)].sort((a, b) => a - b);
    const limits: ModelInputLimits = { ...defaultRoutingLimits(),
      // The document gives no image-count limit or selectable resolution. Start
      // with one reference; administrators can adjust the local limit after confirmation.
      maxImages: 1, resolutions: ['default'], ratios: [...new Set(ratios)],
      duration: { mode: 'options', min: values[0], max: values[values.length - 1], step: 1, values } };
    return { name: model.name.trim(), limits: asyncVideoConfirmedLimits(model.name.trim(), limits) };
  });
  if (new Set(entries.map((model: AsyncVideoModel) => model.name)).size !== entries.length) throw new Error('异步视频模型名称重复');
  return entries;
}
import { responseDiagnostic, upstreamDiagnostic, diagnosticJson } from './upstreamDiagnostic.js';
