import fs from 'node:fs/promises';
import path from 'node:path';
import { sanitizedGenerationReason } from '../../shared/generationErrorPrivacy.js';
import type { RoutingInput } from '../../shared/modelRouting.js';
import {
  isZhiyingVideoModel, validateZhiyingVideoInput, zhiyingApiBase, zhiyingVideoSpec, type ZhiyingVideoModel,
} from '../../shared/zhiyingVideo.js';
import { detectedMediaMime } from './privateMediaStore.js';
import { downloadPublicMedia } from './publicImageDownload.js';
import { publicReferenceRoot } from './publicReferenceService.js';
import { ownsUpload, uploadPath } from './uploadAccess.js';
import { upstreamDiagnostic } from './upstreamDiagnostic.js';
import { probeVideoBufferDuration } from './videoDurationProbe.js';

type Channel = { baseUrl: string; apiKey: string; timeout?: number | null; type?: string };
import { normalizeZhiyingReferencePrompt } from '../../shared/zhiyingReferences.js';
type Kind = 'image' | 'video' | 'audio';
type Stage = '上传素材' | '创建任务' | '查询原任务' | '保存原结果';
type Input = Partial<Omit<RoutingInput, 'images' | 'videos' | 'audios'>> & { images?: string[]; videos?: string[]; audios?: string[] };
type Request = { model: string; prompt: string; input: Input; publicBaseUrl?: string };
type Payload = {
  model: ZhiyingVideoModel; prompt: string; duration: number; resolution: string; aspect_ratio: string;
  reference_images?: string[]; reference_videos?: string[]; reference_audios?: string[];
  reference_video_duration_total?: number;
  reference_mode?: 'multi_reference'; reference_image_processing?: 'direct';
};
export type ZhiyingVideoTask = {
  taskId: string; status: 'pending' | 'processing' | 'completed' | 'failed'; upstreamStatus: string;
  progress?: number; error?: string; resultUrl?: string; costPoints?: number; chargedPoints?: number;
  refundedPoints?: number; refunded?: boolean;
};
const MiB = 1024 * 1024;
const maxResultBytes = 256 * MiB;
const extensions: Record<string, string> = {
  'image/png': 'png', 'image/gif': 'gif', 'image/jpeg': 'jpg', 'image/avif': 'avif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'audio/webm': 'webm',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/aac': 'aac',
};

export class ZhiyingApiError extends Error {
  readonly uncertain: boolean;
  constructor(message: string, readonly status = 0, readonly confirmedFailure = false,
    readonly code?: string, readonly requestId?: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'ZhiyingApiError';
    this.uncertain = !confirmedFailure;
  }
}
export function isZhiyingChannel(channel: { type?: string } | undefined | null) {
  return channel?.type === 'zhiying';
}

function cleanScalar(value: unknown, key: string): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return;
  const text = key ? value.split(key).join('[密钥已隐藏]') : value;
  return sanitizedGenerationReason(text).slice(0, 250);
}
function retryDelay(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return;
  const ms = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
  if (Number.isFinite(ms) && ms > 0) return Math.min(ms, 2_147_483_647);
}

function failure(channel: Channel, stage: Stage, response: Response, raw: any, reason: string, confirmed = false) {
  const envelope = raw?.error;
  const code = cleanScalar(envelope?.code, channel.apiKey);
  const id = cleanScalar(envelope?.request_id || response.headers.get('x-request-id'), channel.apiKey);
  const detail = { code, message: typeof envelope?.message === 'string' ? envelope.message : reason,
    detail: cleanScalar(envelope?.type, channel.apiKey) };
  return new ZhiyingApiError(upstreamDiagnostic('智赢', stage, detail, channel.apiKey, response.status, id),
    response.status, confirmed, code, id, retryDelay(response));
}

async function api(channel: Channel, stage: Stage, endpoint: string, init: RequestInit = {}) {
  const base = zhiyingApiBase(channel.baseUrl);
  if (!channel.apiKey?.trim()) throw new ZhiyingApiError('智赢渠道尚未设置 API Key', 0, stage !== '查询原任务');
  const headers = new Headers(init.headers);
  headers.set('Authorization', 'Bearer ' + channel.apiKey);
  let response: Response;
  try {
    response = await fetch(base + endpoint, { ...init, headers, redirect: 'error', cache: 'no-store',
      signal: AbortSignal.timeout(channel.timeout || 60_000) });
  } catch (err: any) {
    throw new ZhiyingApiError(upstreamDiagnostic('智赢', stage, { message: err?.message, code: err?.cause?.code || err?.name }, channel.apiKey),
      0, stage === '上传素材');
  }
  let raw;
  try { raw = await response.json(); }
  catch { throw failure(channel, stage, response, null, '响应正文不完整或不是 JSON', stage === '上传素材'); }
  return { response, raw };
}

async function boundedLocalFile(rootDir: string, relative: string, limit: number): Promise<Buffer> {
  if (!relative || relative.includes('\\') || relative.includes('\0') || relative.includes(':') ||
    relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('参考素材路径无效');
  const root = await fs.realpath(rootDir);
  let file: string;
  try { file = await fs.realpath(path.resolve(root, relative)); } catch { throw new Error('本站参考素材已不存在'); }
  if (!file.startsWith(root + path.sep)) throw new Error('参考素材路径无效');
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size || stat.size > limit) throw new Error('参考素材为空或超过大小限制');
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function readReference(source: string, kind: Kind, limit: number, publicBase?: string, userId?: number) {
  if (typeof source !== 'string' || !source.length) throw new Error('参考素材地址无效');
  let bytes: Buffer;
  let declared = '';
  if (source.startsWith('data:')) {
    const comma = source.indexOf(',');
    const header = comma > 0 && comma < 100 ? /^data:([^;,]+);base64$/i.exec(source.slice(0, comma)) : null;
    if (!header || source.length - comma - 1 > Math.ceil(limit / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(source.slice(comma + 1))) throw new Error('内联素材格式无效或超过大小限制');
    declared = header[1].toLowerCase();
    if (!declared.startsWith(kind + '/')) throw new Error('参考素材声明类型与位置不符');
    bytes = Buffer.from(source.slice(comma + 1), 'base64');
  } else {
    const site = process.env.BACKEND_URL || publicBase;
    const relative = /^\/(?!\/)/.test(source);
    if (!relative && !/^https?:\/\//i.test(source)) throw new Error('参考素材必须为本站素材或公网 HTTP/HTTPS 链接');
    const parsed = new URL(source, 'https://local.invalid');
    if (parsed.username || parsed.password) throw new Error('参考素材地址不能包含账号密码');
    const local = relative || (site && parsed.origin === new URL(site).origin);
    const resource = local ? uploadPath(parsed.pathname) : null;
    const ext = path.extname(parsed.pathname).toLowerCase().slice(1);
    declared = Object.keys(extensions).find(mime => mime.startsWith(kind + '/') && extensions[mime] === ext) || '';
    if (local && parsed.pathname.startsWith('/api/media/')) {
      const id = /^\/api\/media\/([a-f0-9-]{36})$/.exec(parsed.pathname)?.[1];
      const { privateMediaStore } = await import('../routes/media.js');
      const store = privateMediaStore(), media = id ? store.get(id) : undefined;
      if (!media || !userId || media.user_id !== userId) throw new Error('参考素材不存在或无权访问');
      declared = media.mime;
      const file = store.filePath(media);
      bytes = await boundedLocalFile(path.dirname(file), path.basename(file), limit);
    } else if (resource) {
      if (!(userId && ownsUpload(userId, resource))) {
        const { validMediaSignature } = await import('./mediaSignature.js');
        if (!validMediaSignature(resource, parsed.searchParams.get('expires'), parsed.searchParams.get('signature'))) {
          throw new Error('参考素材不存在或无权访问');
        }
      }
      bytes = await boundedLocalFile(path.resolve('data/uploads'), resource.slice('/uploads/'.length), limit);
    } else if (local && parsed.pathname.startsWith('/reference-assets/')) {
      const filename = parsed.pathname.slice('/reference-assets/'.length);
      if (!/^[0-9a-f-]{36}\.[a-z0-9]{2,5}$/i.test(filename)) throw new Error('本站公开素材地址无效');
      bytes = await boundedLocalFile(publicReferenceRoot(), filename, limit);
    } else {
      if (relative) throw new Error('无法识别本站参考素材地址');
      bytes = await downloadPublicMedia(source, AbortSignal.timeout(60_000), limit, kind);
    }
  }
  let mime = detectedMediaMime(bytes, declared);
  if (mime === 'video/mp4' && bytes.subarray(8, 12).toString() === 'qt  ') mime = 'video/quicktime';
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) mime = 'audio/aac';
  if (!bytes.length || bytes.length > limit || !mime?.startsWith(kind + '/') || !extensions[mime]) throw new Error('参考素材内容类型与位置不符、为空或超过大小限制');
  return { bytes, mime };
}

/** Upload only user-authorized bytes. No upstream file ID supplied by a user may cross the shared channel account. */
export async function prepareZhiyingVideo(channel: Channel, request: Request, options: { userId?: number } = {}): Promise<Payload> {
  const { model, prompt, input } = request;
  if (!isZhiyingVideoModel(model)) throw new Error('智赢未接入该型号');
  const { limits, defaultDuration } = zhiyingVideoSpec(model);
  const images = input.images ?? [], videos = input.videos ?? [], audios = input.audios ?? [];
  for (const group of [images, videos, audios]) if (!Array.isArray(group) || group.some(item => typeof item !== 'string' || !item)) throw new Error('参考素材列表无效');
  const resolution = (input.resolution ?? limits.resolutions[0]).toLowerCase();
  const duration = input.seconds ?? defaultDuration, ratio = input.ratio ?? '16:9';
  const invalid = validateZhiyingVideoInput(model, prompt, { ...input, seconds: duration, resolution, ratio, outputs: input.outputs ?? 1,
    firstFrame: input.firstFrame ?? false, lastFrame: input.lastFrame ?? false, images: images.length, videos: videos.length, audios: audios.length });
  if (invalid.length) throw new Error(invalid.join('；'));
  const payload: Payload = { model, prompt: normalizeZhiyingReferencePrompt(prompt), resolution, duration, aspect_ratio: ratio };
  let videoSeconds = 0;
  for (const [kind, values, field] of [
    ['image', images, 'reference_images'], ['video', videos, 'reference_videos'], ['audio', audios, 'reference_audios'],
  ] as const) {
    if (!values.length) continue;
    const fileIds: string[] = [];
    const maxBytes = kind === 'image' ? 20 * MiB : 100 * MiB;
    for (const [index, source] of values.entries()) {
      try {
        const { bytes, mime } = await readReference(source, kind, maxBytes, request.publicBaseUrl, options.userId);
        if (kind === 'video' && model === 'sd-2.5-fullblood') {
          // Probe the bytes being uploaded, never a second fetch of a possibly changed URL.
          videoSeconds += await probeVideoBufferDuration(bytes);
        }
        const form = new FormData();
        form.set('file', new Blob([new Uint8Array(bytes)], { type: mime }), 'reference.' + extensions[mime]);
        const { response, raw } = await api(channel, '上传素材', '/v1/files', { method: 'POST', body: form });
        // The upload operation documents the file_ ID but omits the JSON response schema.
        const ids = [raw?.id, raw?.file_id].filter(id => id !== undefined);
        if (response.status !== 201 || raw?.error || !ids.length || ids.some(id =>
          typeof id !== 'string' || id !== ids[0] || !/^file_[A-Za-z0-9_-]{1,250}$/.test(id))) {
          throw failure(channel, '上传素材', response, raw, '上传未取得已验收文件 ID', true);
        }
        fileIds.push(ids[0]);
      } catch (error: any) {
        throw new ZhiyingApiError(field + '[' + (index + 1) + '] ' + sanitizedGenerationReason(error.message, [channel.apiKey]),
          error.status, true, error.code, error.requestId, error.retryAfterMs);
      }
    }
    payload[field] = fileIds;
  }
  if (videoSeconds > 0) payload.reference_video_duration_total = Math.round(videoSeconds * 1000) / 1000;
  return payload;
}

function validTaskId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(id) && !/^(image|file)_/.test(id);
}
function signedResult(raw: unknown, base: string): string | undefined {
  if (typeof raw !== 'string' || !raw || (!/^https?:\/\//i.test(raw) && !/^\/v1\/generations\/[\w-]+\/content(?:\?|$)/.test(raw))) return;
  try {
    const url = new URL(raw, base);
    if (url.protocol !== 'https:' || url.username || url.password) return;
    return url.href;
  } catch { return; }
}
function parseTask(channel: Channel, stage: Stage, response: Response, raw: any, expectedId?: string, model?: string): ZhiyingVideoTask {
  const id = raw?.id;
  const identified = validTaskId(id) && (!expectedId || id === expectedId) && (!raw.object || raw.object === 'video') &&
    (!raw.model || (isZhiyingVideoModel(raw.model) && (!model || raw.model === model)));
  // An upstream or gateway error may carry a valid task envelope. Retain the receipt and ask
  // that task for its authoritative state. A 409 may name a different request with the same key.
  if (stage === '创建任务' && identified && !response.ok && response.status !== 409 && raw.object === 'video' && typeof raw.status === 'string') {
    return { taskId: id, upstreamStatus: '创建响应待核实', status: 'pending',
      error: failure(channel, stage, response, raw, '创建回执含有效任务编号及异常 HTTP 状态，继续查询原任务').message };
  }
  if (!identified || !response.ok) {
    // A structured rejection and no competing task evidence. Conflict can refer to a prior accepted task.
    const documentedRejection = [400, 402].includes(response.status)
      || (response.status === 401 && raw?.error?.code === 'invalid_api_key');
    const rejection = stage === '创建任务' && documentedRejection && !id &&
      !raw?.status && !!raw?.error && typeof raw.error.code === 'string' && typeof raw.error.message === 'string';
    throw failure(channel, stage, response, raw, expectedId ? '查询回执缺少或不匹配原视频任务标识' : '创建回执缺少可确认的视频任务标识', rejection);
  }
  const state = typeof raw.status === 'string' ? raw.status : '';
  const upstreamStatus = cleanScalar(state, channel.apiKey) || '未提供状态';
  const task: ZhiyingVideoTask = { taskId: id, upstreamStatus, status: 'pending' };
  if (['failed','canceled'].includes(state)) {
    task.status = 'failed';
    task.error = failure(channel, stage, response, raw,
      state === 'canceled' ? '原视频任务已取消，上游未提供具体原因' : '原视频任务失败，上游未提供具体原因').message;
  } else if (state === 'succeeded') {
    task.status = 'completed';
    task.progress = 100;
    task.resultUrl = signedResult(raw.result_url, zhiyingApiBase(channel.baseUrl));
  } else if (state === 'processing' || state === 'review') {
    task.status = 'processing';
  } else if (state !== 'queued' && state !== 'created') {
    task.error = failure(channel, stage, response, raw, '生成回执状态待核实：' + upstreamStatus).message;
  }
  for (const [from, to] of [['cost_points','costPoints'], ['charged_points','chargedPoints'], ['refunded_points','refundedPoints']] as const) {
    if (Number.isSafeInteger(raw[from]) && raw[from] >= 0) task[to] = raw[from];
  }
  if (typeof raw.refunded === 'boolean') task.refunded = raw.refunded;
  return task;
}

export async function createZhiyingVideo(channel: Channel, payload: Payload, key: string) {
  if (!isZhiyingVideoModel(payload?.model) || typeof key !== 'string' || !/^[\x21-\x7e]{8,200}$/.test(key)) throw new ZhiyingApiError('智赢提交型号或幂等键无效', 0, true);
  const { response, raw } = await api(channel, '创建任务', '/v1/generations', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(payload),
  });
  return parseTask(channel, '创建任务', response, raw, undefined, payload.model);
}
export async function pollZhiyingVideo(channel: Channel, taskId: string, expectedModel?: string) {
  if (!validTaskId(taskId)) throw new ZhiyingApiError('智赢原任务编号无效');
  const { response, raw } = await api(channel, '查询原任务', '/v1/generations/' + encodeURIComponent(taskId));
  return parseTask(channel, '查询原任务', response, raw, taskId, expectedModel);
}

export async function fetchZhiyingVideoContent(channel: Channel, taskId: string, resultUrl?: string, model?: string): Promise<Buffer> {
  if (!validTaskId(taskId)) throw new ZhiyingApiError('智赢原任务编号无效');
  const refresh = async () => {
    const task = await pollZhiyingVideo(channel, taskId, model);
    if (task.status !== 'completed' || !task.resultUrl) throw new ZhiyingApiError('原视频尚未返回可保存的签名链接');
    return task.resultUrl;
  };
  const source = resultUrl ? signedResult(resultUrl, zhiyingApiBase(channel.baseUrl)) : await refresh();
  if (!source) throw new ZhiyingApiError('原视频结果链接格式无效');
  const download = (url: string) => downloadPublicMedia(url, AbortSignal.timeout(300_000), maxResultBytes, 'video', true);
  try {
    return await download(source);
  } catch (error: any) {
    if (![401,403,404,410].includes(error?.httpStatus)) throw error;
    const fresh = await refresh();
    if (fresh === source) throw error;
    return download(fresh);
  }
}
