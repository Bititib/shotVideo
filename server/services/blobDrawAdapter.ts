import { randomUUID } from 'node:crypto';
import type { ModelInputLimits } from '../../shared/modelRouting.js';
import { uploadBlobDrawMedia } from './blobDrawMediaService.js';

export const BLOB_DRAW_BASE_URL = 'https://www.iblob.cc/api/v1';
export type BlobDrawModel = { id: string | number; name?: string; type: string; config: Record<string, any> };
export type BlobDrawChannel = { type?: string; baseUrl: string; apiKey: string; timeout?: number };
export function isBlobDrawChannel(channel: { type?: string; baseUrl?: string } | null | undefined) {
  if (channel?.type === 'blobdraw') return true;
  try { return ['iblob.cc', 'www.iblob.cc'].includes(new URL(channel?.baseUrl || '').hostname); } catch { return false; }
}
export function blobDrawApiBase(baseUrl: string) {
  const url = new URL(baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('BlobDraw 接口地址无效');
  const p = url.pathname.replace(/\/+$/, '');
  url.pathname = /\/api\/v1$/i.test(p) || /\/v1$/i.test(p) ? p : /\/api$/i.test(p) ? p + '/v1' : p + '/api/v1';
  return url.href.replace(/\/$/, '');
}
export class BlobDrawApiError extends Error {
  constructor(message: string, readonly status: number, readonly uncertain = false) { super(message); }
}
export async function blobDrawRequest(channel: BlobDrawChannel, endpoint: string, body?: unknown) {
  const generation = endpoint === '/generations' && body !== undefined;
  let response: Response;
  try {
    response = await fetch(blobDrawApiBase(channel.baseUrl) + endpoint, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-API-Key': channel.apiKey, ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(channel.timeout || 60_000), redirect: 'error',
    });
  } catch { throw new BlobDrawApiError('BlobDraw 连接失败' + (generation ? '，提交结果待核实，请勿重复生成' : ''), 0, generation); }
  let payload: any;
  try { payload = await response.json(); }
  catch { throw new BlobDrawApiError('BlobDraw 响应无法解析', response.status, generation); }
  if (!response.ok || payload?.code !== 0) {
    const message = String(payload?.message || '接口暂不可用');
    const safe = channel.apiKey ? message.split(channel.apiKey).join('[REDACTED]') : message;
    throw new BlobDrawApiError('BlobDraw 请求失败：' + safe.slice(0, 300), response.status === 200 ? Number(payload?.code) || 502 : response.status,
      generation && (Boolean(payload?.data?.id) || response.status === 408 || response.status >= 500));
  }
  return payload.data;
}
export async function fetchBlobDrawModels(channel: BlobDrawChannel): Promise<BlobDrawModel[]> {
  const data = await blobDrawRequest(channel, '/models');
  const items = Array.isArray(data) ? data : data?.items || data?.models;
  if (!Array.isArray(items)) throw new Error('BlobDraw 模型列表格式无效');
  return items.filter(m => m && ['string', 'number'].includes(typeof m.id) && String(m.id).trim() && m.type === 'video')
    .map(m => ({ ...m, config: m.config || {} }));
}
const strings = (v: unknown): string[] => Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string' && x.trim()))] : [];
export function blobDrawModelLimits(model: BlobDrawModel): ModelInputLimits {
  const c = model.config, modes = strings(c.video_modes);
  const values: number[] = Array.isArray(c.video_duration_options) ? [...new Set<number>(c.video_duration_options.map(Number).filter(n => Number.isInteger(n) && n >= 4 && n <= 60))].sort((a, b) => a - b) : [];
  const fixed = Number(c.video_fixed_duration);
  if (!modes.length || !strings(c.video_resolutions).length || !strings(c.video_aspect_ratios).length
    || (c.video_duration_mode === 'fixed' ? !Number.isInteger(fixed) || fixed < 4 || fixed > 60 : !values.length)) throw new Error('BlobDraw 模型 ' + model.id + ' 的视频参数配置不完整');
  const count = (key: string, max: number) => Math.min(max, Math.max(0, Math.floor(Number(c[key]) || 0)));
  const maxImages = count('video_reference_image_count', 30);
  return { maxImages, maxVideos: count('video_reference_video_count', 10), maxAudios: count('video_reference_audio_count', 10), maxOutputs: 1,
    minImages: modes.includes('文生视频') || modes.some(m => /多模态|全能|参考/.test(m)) ? 0 : modes.every(m => m === '首尾帧') ? 2 : 1,
    resolutions: strings(c.video_resolutions), ratios: strings(c.video_aspect_ratios), qualities: [],
    firstFrame: maxImages >= 1 && (modes.includes('首帧') || modes.includes('首尾帧')),
    lastFrame: maxImages >= 1 && (modes.includes('尾帧') || modes.includes('首尾帧')),
    duration: c.video_duration_mode === 'fixed' ? { mode: 'fixed', min: fixed, max: fixed, step: 1, values: [fixed] }
      : { mode: 'options', min: values[0], max: values.at(-1)!, step: 1, values },
  };
}
export type BlobDrawVideoInput = {
  model: string; prompt: string; seconds: number; ratio: string; resolution: string;
  images: string[]; videos: string[]; audios: string[]; firstFrame?: string; lastFrame?: string;
  mode?: string; faceMode?: string; idempotencyKey?: string; publicBaseUrl: string;
};
const videoModeAliases: Record<string, string> = {
  t2v: '文生视频', 'text-to-video': '文生视频', text_to_video: '文生视频',
  i2v: '图生视频', 'image-to-video': '图生视频', image_to_video: '图生视频',
  multimodal: '多模态', 'multi-modal': '多模态', multi_modal: '多模态',
};
function blobDrawVideoMode(model: BlobDrawModel, input: BlobDrawVideoInput, modes: string[]): string {
  if (input.mode !== undefined && typeof input.mode !== 'string') throw new Error('BlobDraw 视频 mode 必须是字符串，或省略以自动选择');
  const requested = input.mode?.trim() || '';
  const automatic = !requested || ['auto', '自动'].includes(requested.toLowerCase());
  const frameMode = input.firstFrame && input.lastFrame ? '首尾帧' : input.firstFrame ? '首帧' : input.lastFrame ? '尾帧' : '';
  const multimodal = modes.find(m => /多模态|全能|参考/.test(m));
  let mode: string | undefined;
  if (!automatic) {
    // Translate only known aliases; the value sent upstream must still come from /models.
    const name = videoModeAliases[requested.toLowerCase()] || requested;
    mode = modes.find(m => m === requested || m === name);
  } else if (frameMode) {
    mode = modes.find(m => m === frameMode);
  } else if (input.videos.length || input.audios.length) {
    mode = multimodal;
  } else if (input.images.length) {
    mode = (input.images.length > 1 ? multimodal : undefined)
      || modes.find(m => m === '图生视频')
      || (input.images.length === 1 ? modes.find(m => m === '首帧') : undefined)
      || multimodal;
  } else {
    mode = modes.find(m => m === '文生视频') || multimodal;
  }
  if (!mode) {
    const reason = automatic && frameMode
      ? `当前模型不支持${frameMode}，请使用支持该模式的模型；普通参考图片请放入参考图区`
      : automatic ? '当前素材组合没有可用的视频模式'
        : '指定的 mode 无效，请使用上游支持的值，或省略 mode 以自动选择';
    throw new Error(`BlobDraw ${reason}（模型 ID：${model.id}；支持模式：${modes.join('、')}；图片 ${input.images.length}、视频 ${input.videos.length}、音频 ${input.audios.length}、首尾帧 ${Number(Boolean(input.firstFrame)) + Number(Boolean(input.lastFrame))}）`);
  }
  return mode;
}
export function blobDrawVideoParameters(model: BlobDrawModel, input: BlobDrawVideoInput) {
  const limits = blobDrawModelLimits(model), modes = strings(model.config.video_modes);
  const frames = Number(Boolean(input.firstFrame)) + Number(Boolean(input.lastFrame));
  if (frames && (input.images.length || input.videos.length || input.audios.length)) throw new Error('BlobDraw 独立首尾帧不能与普通参考素材混用');
  const mode = blobDrawVideoMode(model, input, modes);
  const images = frames || input.images.length;
  if (images > limits.maxImages || input.videos.length > limits.maxVideos || input.audios.length > limits.maxAudios) throw new Error('BlobDraw 参考素材数量超过模型上限');
  if (mode === '文生视频' && (images || input.videos.length || input.audios.length)) throw new Error('BlobDraw 文生视频模式不能携带参考素材');
  if (['图生视频', '首帧', '尾帧', '首尾帧'].includes(mode) && (input.videos.length || input.audios.length)) throw new Error('BlobDraw 视频或音频参考须使用多模态模式，或省略 mode 以自动选择');
  if (mode === '首尾帧' && images !== 2 || ['首帧', '尾帧'].includes(mode) && images !== 1 || mode === '图生视频' && !images) throw new Error('BlobDraw 视频模式与图片数量不匹配');
  if (frames && mode !== (input.firstFrame && input.lastFrame ? '首尾帧' : input.firstFrame ? '首帧' : '尾帧')) throw new Error('BlobDraw 首尾帧与指定视频模式不一致');
  const duration = limits.duration;
  if (!Number.isInteger(input.seconds) || !(duration.mode === 'fixed' ? input.seconds === duration.min : duration.values.includes(input.seconds))) throw new Error('BlobDraw 视频时长不符合模型配置');
  const resolution = limits.resolutions.find(v => v.toLowerCase() === input.resolution.toLowerCase());
  if (!resolution || !limits.ratios.includes(input.ratio)) throw new Error('BlobDraw 分辨率或比例不符合模型配置');
  if (!input.prompt.trim() || input.prompt.length > 10_000) throw new Error('BlobDraw 提示词长度须为 1–10000 字符');
  if (input.faceMode !== undefined && !['portrait', 'native'].includes(input.faceMode)) throw new Error('BlobDraw face_mode 仅支持 portrait / native');
  const key = input.idempotencyKey || randomUUID();
  if (!key.trim() || Buffer.byteLength(key) > 128) throw new Error('BlobDraw 请求标识须为 1–128 字节');
  return { type: 'video', model_id: model.id, prompt: input.prompt.trim(), idempotency_key: key, mode,
    resolution, aspect_ratio: input.ratio, duration: input.seconds,
    ...(model.config.video_portrait_enabled === true ? { face_mode: input.faceMode || 'portrait' } : {}) };
}
export function resolveBlobDrawModel(models: BlobDrawModel[], reference: string): BlobDrawModel {
  // Stored numeric platform IDs take precedence over display names.
  const byId = models.find(model => String(model.id) === reference);
  if (byId) return byId;
  const byName = models.filter(model => model.name?.trim() === reference);
  if (byName.length > 1) throw new Error('BlobDraw 模型名称重复，请通过同步模型使用实际模型 ID');
  if (!byName.length) throw new Error('BlobDraw 当前账号不可用此视频模型，请重新同步模型');
  return byName[0];
}
export async function submitBlobDrawVideo(channel: BlobDrawChannel, input: BlobDrawVideoInput, beforeSubmit: (payload: Record<string, unknown>) => void) {
  const model = resolveBlobDrawModel(await fetchBlobDrawModels(channel), input.model);
  const parameters = blobDrawVideoParameters(model, input);
  const images = input.firstFrame || input.lastFrame ? [input.firstFrame, input.lastFrame].filter(Boolean) as string[] : input.images;
  const options = { ...channel, publicBaseUrl: input.publicBaseUrl };
  const imageIds = await uploadBlobDrawMedia(images, 'image', options);
  const videoIds = await uploadBlobDrawMedia(input.videos, 'video', options);
  const audioIds = await uploadBlobDrawMedia(input.audios, 'audio', options);
  const payload = { ...parameters, ...(imageIds.length ? { image_asset_ids: imageIds } : {}),
    ...(videoIds.length ? { video_asset_ids: videoIds } : {}), ...(audioIds.length ? { audio_asset_ids: audioIds } : {}) };
  beforeSubmit(payload);
  const result = await blobDrawRequest(channel, '/generations', payload);
  if (!['string', 'number'].includes(typeof result?.id) || !String(result.id).trim()) throw new BlobDrawApiError('BlobDraw 未返回任务编号，提交结果待核实', 202, true);
  return String(result.id);
}
export function normalizeBlobDrawTask(data: any, baseUrl: string) {
  if (!data || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(data.status)) throw new Error('BlobDraw 任务响应未包含有效状态');
  const rawUrl = data.output?.video_url || data.output?.url || '';
  const url = rawUrl ? new URL(rawUrl, new URL(baseUrl).origin) : null;
  if (url && (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)) throw new Error('BlobDraw 视频结果地址无效');
  return { status: data.status, progress: Math.max(0, Math.min(100, Number(data.progress) || 0)),
    resultUrl: data.status === 'completed' ? url?.href || '' : '', error: String(data.error_message || '') };
}
export async function pollBlobDrawVideo(channel: BlobDrawChannel, taskId: string) {
  return normalizeBlobDrawTask(await blobDrawRequest(channel, '/generation-tasks/' + encodeURIComponent(taskId)), channel.baseUrl);
}
