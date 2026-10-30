import { SNUMOM_WAN_NSFW_MODEL, SNUMOM_OUTPUT_ONLY_MODELS, snumomOutputOnlySpec, isSnumomWanVideoModel } from '../../shared/snumomWanNsfw.js';
import { isRetiredVideoModel, RETIRED_VIDEO_MODEL_MESSAGE } from '../../shared/retiredVideoModels.js';
export const SNUMOM_BASE_URL = 'https://snumom.com';
export const SNUMOM_CHANNEL_TYPE = 'snumom';
export const SNUMOM_GROK_IMAGINE_VIDEO_MODEL = 'grok-imagine-video-1.5';
export const SNUMOM_GROK_IMAGINE_VIDEO_LEGACY_MODEL = 'grok-imagine-video-1.5（按次）';
export const SNUMOM_GROK_IMAGINE_VIDEO_SECONDS = Array.from({ length: 15 }, (_, index) => index + 1);
export const SNUMOM_GROK_IMAGINE_VIDEO_MAX_IMAGES = 7;
export const SNUMOM_SD_MINI_MODEL = 'sd-mini';
export const SNUMOM_SD_MINI_SECONDS = [10, 15] as const;
export const SNUMOM_SD_MINI_MAX_IMAGES = 9;
export const SNUMOM_SD_MINI_MAX_VIDEOS = 3;
export const SNUMOM_SD_MINI_MAX_AUDIOS = 3;
export const SNUMOM_VIDEO_MODELS = [
  SNUMOM_WAN_NSFW_MODEL,
  ...Object.keys(SNUMOM_OUTPUT_ONLY_MODELS),
  SNUMOM_GROK_IMAGINE_VIDEO_MODEL,
  SNUMOM_SD_MINI_MODEL,
] as const;

export function canonicalSnumomVideoModel(model: string): string {
  return model === SNUMOM_GROK_IMAGINE_VIDEO_LEGACY_MODEL ? SNUMOM_GROK_IMAGINE_VIDEO_MODEL : model;
}

export function isSnumomWan30VideoModel(model: string): boolean {
  return isSnumomWanVideoModel(model);
}

export function snumomWanBillableSeconds(model: string, outputSeconds: number, referenceVideoSeconds = 0): number {
  const output = Number(outputSeconds);
  const references = Number(referenceVideoSeconds);
  if (!Number.isFinite(output) || output < 0 || !Number.isFinite(references) || references < 0) {
    throw new Error('snumom billable seconds must be non-negative finite numbers');
  }
  return output + (model === SNUMOM_WAN_NSFW_MODEL ? references : 0);
}

export function snumomSdMiniSecondsForResolution(resolution: string): 10 | 15 | null {
  const normalized = String(resolution || '').toLowerCase();
  if (normalized === '480p') return 15;
  if (normalized === '720p') return 10;
  return null;
}

export interface SnumomChannelLike {
  type?: string | null;
  baseUrl?: string | null;
}

export interface SnumomWanPayloadInput {
  model: string;
  prompt: string;
  seconds: number;
  resolution: string;
  aspectRatio: string;
  images?: Array<{ url: string; role?: 'reference_image' | 'first_frame' | 'last_frame' }>;
  videos?: Array<{ url: string; duration?: number }>;
  audios?: Array<{ url: string }>;
  smartDuration?: boolean;
  promptExtend?: boolean;
  inputMedia?: Array<{ type: 'file' | 'link'; url: string }>;
}

export interface SnumomWanBillingUsage {
  billableSeconds: number;
  outputSeconds?: number;
  referenceVideoSeconds?: number;
  resolution?: '480p' | '720p' | '1080p';
}

export function normalizeSnumomWanInputMedia(value: unknown): Array<{ type: 'file' | 'link'; url: string }> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('input.media must be an array');
  if (value.length > 1) throw new Error('Wan 3.0 supports at most one file or link reference');
  return value.map(item => {
    if (!item || typeof item !== 'object') throw new Error('input.media items must be objects');
    const type = String((item as any).type || '').toLowerCase();
    if (type !== 'file' && type !== 'link') throw new Error('input.media type must be file or link');
    const url = String((item as any).url || '').trim();
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('input.media url must be a public HTTPS URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.hostname === 'localhost' || /^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(parsed.hostname)) {
      throw new Error('input.media url must be a public HTTP(S) URL');
    }
    return { type, url } as { type: 'file' | 'link'; url: string };
  });
}

export function isSnumomWanChannel(channel: SnumomChannelLike | null | undefined): boolean {
  if (channel?.type === SNUMOM_CHANNEL_TYPE) return true;
  if (!channel?.baseUrl) return false;
  try {
    return new URL(channel.baseUrl).hostname.toLowerCase() === 'snumom.com';
  } catch {
    return false;
  }
}

export function normalizeSnumomResolution(resolution: string): '480P' | '720P' | '1080P' {
  const value = String(resolution || '').toUpperCase();
  if (value === '480P' || value === '1080P') return value;
  return '720P';
}

export function buildSnumomWanPayload(input: SnumomWanPayloadInput): Record<string, unknown> {
  if (isRetiredVideoModel(input.model)) throw new Error(RETIRED_VIDEO_MODEL_MESSAGE);
  if (isSnumomWanVideoModel(input.model)) validateSnumomNsfwInput(input);
  const images = (input.images || []).filter(item => item?.url);
  const videos = (input.videos || []).filter(item => item?.url);
  const audios = (input.audios || []).filter(item => item?.url);
  const normalizedModel = canonicalSnumomVideoModel(input.model);
  const normalizedResolution = normalizeSnumomResolution(input.resolution);
  const frameMode = isSnumomWan30VideoModel(normalizedModel)
    && images.some(item => item.role === 'first_frame' || item.role === 'last_frame');
  const parameters = {
    ...(input.smartDuration ? { duration: -1 } : {}),
    ...(typeof input.promptExtend === 'boolean' ? { prompt_extend: input.promptExtend } : {}),
  };
  return {
    model: normalizedModel,
    prompt: input.prompt.trim(),
    ...(!input.smartDuration ? { seconds: String(input.seconds) } : {}),
    size: normalizedModel.startsWith('grok-imagine-video-1.5') && normalizedResolution === '1080P' ? '720P' : normalizedResolution,
    aspect_ratio: frameMode ? 'adaptive' : input.aspectRatio,
    ...(Object.keys(parameters).length ? { parameters } : {}),
    ...(images.length ? { reference_images: images } : {}),
    ...(videos.length ? { reference_videos: videos } : {}),
    ...(audios.length ? { reference_audios: audios } : {}),
    ...(input.inputMedia?.length ? { input: { media: input.inputMedia } } : {}),
  };
}

/** NSFW reuses standard parameters by explicit user confirmation, not name guessing. */
export function validateSnumomNsfwInput(input: SnumomWanPayloadInput): void {
  const fixed = snumomOutputOnlySpec(input.model);
  if(fixed && (String(input.resolution).toLowerCase()!==fixed.resolution || !(fixed.seconds as readonly number[]).includes(input.seconds) || input.smartDuration)) throw new Error(`${input.model} 仅支持 ${fixed.resolution}，时长 ${fixed.seconds.join('/')} 秒`);
  const images = input.images || [], videos = input.videos || [], audios = input.audios || [];
  if (!input.prompt?.trim()) throw new Error('请输入描述');
  if (!['480p','720p','1080p'].includes(String(input.resolution).toLowerCase())) throw new Error('Wan 3.0 NSFW 仅支持 480p/720p/1080p');
  if (!['adaptive','21:9','16:9','4:3','1:1','3:4','9:16'].includes(input.aspectRatio)) throw new Error('Wan 3.0 NSFW 画面比例不支持');
  if (!input.smartDuration && (!Number.isInteger(input.seconds) || input.seconds < 2 || input.seconds > 30)) throw new Error('Wan 3.0 NSFW 输出时长须为 2-30 秒整数');
  if (input.smartDuration && !videos.length) throw new Error('Wan 3.0 NSFW 智能时长必须提供参考视频');
  if (images.length > 10 || videos.length > 5 || audios.length > 5 || images.length + videos.length + audios.length + (input.inputMedia?.length || 0) > 20) throw new Error('Wan 3.0 NSFW 最多10图、5视频、5音频，素材合计最多20个');
  if ([...images,...videos,...audios].some(item => typeof item?.url !== 'string' || !item.url.trim())) throw new Error('参考素材地址无效，未提交上游');
  const first = images.filter(item=>item.role === 'first_frame'), last = images.filter(item=>item.role === 'last_frame');
  if (first.length > 1 || last.length > 1 || last.length && !first.length) throw new Error('首帧和尾帧各最多一张，尾帧必须同时提供首帧');
  if ((first.length || last.length) && (images.some(item=>!['first_frame','last_frame'].includes(item.role || '')) || videos.length || audios.length || input.inputMedia?.length)) throw new Error('首尾帧不能与普通参考素材、文件或网页混用');
}

function finiteNonNegative(value: unknown): number | undefined {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

/** Normalize documented NSFW media objects before either entry can reserve funds. */
export function normalizeSnumomNsfwRequestBody(value: any): any {
  if (!isSnumomWanVideoModel(value?.model)) return value;
  const body = {...value};
  const resolutions=[body.resolution,body.resolution_name,body.size].filter(v=>v!==undefined).map(v=>String(v).toLowerCase());
  if(new Set(resolutions).size>1)throw new Error('分辨率参数必须一致');
  body.resolution=resolutions[0]||snumomOutputOnlySpec(body.model)?.resolution||'720p';
  if(snumomOutputOnlySpec(body.model) && [body.seconds,body.duration,body.video_length,body.parameters?.duration,body.duration_seconds].every(v=>v===undefined)) body.seconds=snumomOutputOnlySpec(body.model)!.seconds[0];
  if(body.start_frame!==undefined){if(body.first_frame!==undefined||body.first_frame_url!==undefined)throw new Error('首帧不能重复传入');body.first_frame=body.start_frame;}
  if(body.end_frame!==undefined){if(body.last_frame!==undefined||body.last_frame_url!==undefined||body.end_frame_url!==undefined)throw new Error('尾帧不能重复传入');body.last_frame=body.end_frame;}
  const durations = [body.seconds,body.duration,body.video_length,body.parameters?.duration,body.duration_seconds].filter(v=>v!==undefined).map(Number);
  if (durations.some(v=>!Number.isFinite(v)) || new Set(durations).size>1) throw new Error('视频时长参数必须一致且为有效数字');
  if(durations.length)body.seconds=durations[0];
  const url = (v:any):string => {const result=typeof v==='string'?v:v?.url;if(typeof result!=='string'||!result.trim())throw new Error('参考素材地址无效');return result;};
  for (const key of ['first_frame','first_frame_url','last_frame','last_frame_url','end_frame_url']) if(body[key]!==undefined)body[key]=url(body[key]);
  if (Array.isArray(body.reference_images)) {
    const images:string[]=[];
    for(const item of body.reference_images){
      const source=url(item),role=typeof item==='object'?item.role:undefined;
      if(role && !['reference_image','first_frame','last_frame'].includes(role))throw new Error('参考图片 role 不支持');
      if(role==='first_frame'||role==='last_frame'){
        if(body[role]||body[role+'_url']||role==='last_frame'&&body.end_frame_url)throw new Error('首尾帧不能重复传入');
        body[role]=source;
      } else images.push(source);
    }
    body.reference_images=images;
  }
  for(const key of ['reference_videos','reference_audios','audio_urls'])if(Array.isArray(body[key]))body[key]=body[key].map(url);
  if(body.reference_audios!==undefined){
    if(body.audio_urls?.length||body.audio_url)throw new Error('参考音频请只使用一个素材字段');
    body.audio_urls=body.reference_audios;delete body.reference_audios;
  }
  const images=body.reference_images||body.image_urls||[],videos=body.reference_videos||body.video_urls||[],audios=body.audio_urls||body.reference_audios||[];
  const asList=(v:any)=>v===undefined||v===''?[]:Array.isArray(v)?v:[v];
  const first=body.first_frame||body.first_frame_url,last=body.last_frame||body.last_frame_url||body.end_frame_url;
  if(first)body.first_frame=first;
  if(last)body.last_frame=last;
  const promptExtend=body.parameters?.prompt_extend??body.prompt_extend;
  if(promptExtend!==undefined&&typeof promptExtend!=='boolean')throw new Error('prompt_extend 必须为布尔值');
  validateSnumomNsfwInput({model:body.model,prompt:body.prompt,seconds:durations[0]??6,smartDuration:durations[0]===-1,
    resolution:body.resolution||body.resolution_name||'720p',aspectRatio:body.aspect_ratio||body.ratio||'16:9',inputMedia:normalizeSnumomWanInputMedia(body.input?.media),
    images:[...asList(images).map(v=>({url:url(v)})),...(first?[{url:first,role:'first_frame' as const}]:[]),...(last?[{url:last,role:'last_frame' as const}]:[])],
    videos:asList(videos).map(v=>({url:url(v)})),audios:asList(audios).map(v=>({url:url(v)}))});
  return body;
}

/** Read settlement data only when the upstream explicitly labels it as usage/billing data. */
export function extractSnumomWanBillingUsage(payload: any, fallbackReferenceSeconds = 0, model = ''): SnumomWanBillingUsage | null {
  const scopes = [payload?.usage, payload?.billing, payload?.metadata?.usage, payload?.metadata?.billing]
    .filter(value => value && typeof value === 'object');
  for (const scope of scopes) {
    const outputSeconds = finiteNonNegative(scope.output_seconds ?? scope.outputSeconds ?? scope.output_duration);
    const referenceVideoSeconds = finiteNonNegative(scope.reference_video_seconds ?? scope.referenceVideoSeconds ?? scope.input_seconds);
    const explicitTotal = finiteNonNegative(scope.billable_seconds ?? scope.billableSeconds ?? scope.total_seconds ?? scope.totalSeconds);
    const billableSeconds = snumomOutputOnlySpec(model) ? outputSeconds ?? explicitTotal : explicitTotal ?? (outputSeconds !== undefined
      ? outputSeconds + (referenceVideoSeconds ?? finiteNonNegative(fallbackReferenceSeconds) ?? 0)
      : undefined);
    if (billableSeconds === undefined) continue;
    const resolutionValue = String(scope.resolution ?? scope.actual_resolution ?? '').toLowerCase();
    const resolution = ['480p', '720p', '1080p'].includes(resolutionValue)
      ? resolutionValue as SnumomWanBillingUsage['resolution']
      : undefined;
    return { billableSeconds, outputSeconds, referenceVideoSeconds, resolution };
  }
  return null;
}

export function normalizeSnumomWanTask(payload: any, referenceVideoSeconds = 0, model = '') {
  return {
    id: extractSnumomTaskId(payload),
    status: String(payload?.status || '').toLowerCase(),
    progress: Number(payload?.progress || 0),
    resultUrl: String(payload?.metadata?.url || payload?.video_url || payload?.result_url || payload?.url || ''),
  error: payload?.error || payload?.message ? upstreamDiagnostic('snumom', '任务失败', { error: payload.error, message: payload.message, error_code: payload.error_code }) : '',
    billingUsage: extractSnumomWanBillingUsage(payload, referenceVideoSeconds, model),
  };
}

function snumomTaskId(value: unknown): string {
  if (!['string', 'number'].includes(typeof value)) return '';
  const taskId = String(value).trim();
  return /^task_[A-Za-z0-9_-]+$/.test(taskId) ? taskId : '';
}

/** snumom documents only id/task_id as polling IDs; request_id is a trace ID. */
export function extractSnumomTaskId(
  payload: any,
  headers?: Pick<Headers, 'get'> | Record<string, string | string[] | undefined> | null,
): string {
  const firstData = Array.isArray(payload?.data) ? payload.data[0] : payload?.data;
  const scopes = [payload, firstData, payload?.result, payload?.output, payload?.task, payload?.response?.data]
    .filter(value => value && typeof value === 'object');
  for (const scope of scopes) {
    for (const field of ['task_id', 'taskId', 'id']) {
      const taskId = snumomTaskId(scope?.[field]);
      if (taskId) return taskId;
    }
  }
  for (const name of ['x-task-id', 'task-id']) {
    const value = headers && typeof (headers as Pick<Headers, 'get'>).get === 'function'
      ? (headers as Pick<Headers, 'get'>).get(name)
      : (headers as Record<string, string | string[] | undefined> | null)?.[name];
    const taskId = snumomTaskId(Array.isArray(value) ? value[0] : value);
    if (taskId) return taskId;
  }
  const location = headers && typeof (headers as Pick<Headers, 'get'>).get === 'function'
    ? (headers as Pick<Headers, 'get'>).get('location')
    : (headers as Record<string, string | string[] | undefined> | null)?.location;
  const locationValue = Array.isArray(location) ? location[0] : location;
  const match = String(locationValue || '').match(/\/v1\/videos\/(task_[A-Za-z0-9_-]+)(?:[/?#]|$)/i);
  return match ? match[1] : '';
}

export function snumomContentUrl(baseUrl: string, taskId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/videos/${encodeURIComponent(taskId)}/content`;
}
import { upstreamDiagnostic } from './upstreamDiagnostic.js';
