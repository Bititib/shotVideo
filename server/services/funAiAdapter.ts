import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { funAiModelKind, funAiModelLimits, isFunAiGeminiImage } from '../../shared/funAi.js';
import { routingMismatches } from '../../shared/modelRouting.js';
import { detectedMediaMime } from './privateMediaStore.js';
import type { SpecificationRequest } from './specificationAdapters.js';

export type FunAiChannel = { type?: string; baseUrl: string; apiKey: string; timeout?: number };
export function isFunAiChannel(channel: { type?: string; baseUrl?: string } | null | undefined) {
  if (channel?.type === 'funai') return true;
  try { return new URL(channel?.baseUrl || '').hostname === 'ztyunjuan.com'; } catch { return false; }
}
export function funAiBaseUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('FunAI 接口地址无效，请填写服务根地址');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1(?:beta)?$/i, '');
  return url.href.replace(/\/$/, '');
}
export function funAiTaskUrl(base: string, id: string) { return funAiBaseUrl(base) + '/v1/videos/' + encodeURIComponent(id); }
export function shouldSendFunAiAuthorization(source: string, base: string) {
  try { return new URL(source).origin === new URL(base).origin; } catch { return false; }
}
export class FunAiApiError extends Error {
  constructor(message: string, readonly status = 0, readonly uncertain = false, readonly confirmedFailure = false) { super(message); }
}
function safeMessage(value: unknown, channel: FunAiChannel) {
  const text = String(value || '接口暂不可用');
  return (channel.apiKey ? text.split(channel.apiKey).join('[REDACTED]') : text).replace(/sk-[\w-]+/g, '[REDACTED]').slice(0, 400);
}
export async function fetchFunAiModels(channel: FunAiChannel) {
  const response = await fetch(funAiBaseUrl(channel.baseUrl) + '/v1/models', {
    headers: { Authorization: 'Bearer ' + channel.apiKey }, signal: AbortSignal.timeout(channel.timeout || 30_000), redirect: 'error',
  });
  if (!response.ok) throw new FunAiApiError(await responseDiagnostic('FunAI', '模型查询', response, channel.apiKey), response.status);
  const payload = await diagnosticJson('FunAI', '模型查询', response, channel.apiKey);
  if (payload?.error) throw new FunAiApiError(upstreamDiagnostic('FunAI', '模型查询', payload, channel.apiKey, response.status), response.status);
  const entries = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(entries) || entries.some(item => typeof item !== 'string' && (typeof item?.id !== 'string' || !item.id.trim()))) throw new FunAiApiError('FunAI 模型列表格式无效', 502);
  return [...new Set<string>(entries.map(item => (typeof item === 'string' ? item : item.id).trim()))].filter(Boolean);
}
function reference(value: string) {
  if (/^data:(?:image|video|audio)\/[\w.+-]+;base64,[A-Za-z0-9+/=\s]+$/.test(value)) return value;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('FunAI 参考素材地址无效');
  return value;
}
export function buildFunAiVideoPayload(model: string, request: SpecificationRequest) {
  if (funAiModelKind(model) !== 'video') throw new Error('FunAI 视频模型未适配');
  const i = request.input, limits = funAiModelLimits(model);
  const mismatch = routingMismatches(limits, { ...i, images: request.images.length, videos: request.videos.length, audios: request.audios.length,
    firstFrame: Boolean(request.firstFrame), lastFrame: Boolean(request.lastFrame), outputs: 1 }, 'video');
  if (mismatch.length) throw new Error('FunAI：' + mismatch.join('；'));
  if (request.lastFrame && !request.firstFrame) throw new Error('FunAI 尾帧必须搭配首帧');
  if ((request.firstFrame || request.lastFrame) && request.images.length) throw new Error('FunAI 首尾帧不能与普通参考图同时使用');
  const images = request.images.map(reference), videos = request.videos.map(reference), audios = request.audios.map(reference);
  const first = request.firstFrame ? reference(request.firstFrame) : '', last = request.lastFrame ? reference(request.lastFrame) : '';
  const payload: Record<string, any> = { model, prompt: request.prompt, seconds: i.seconds, aspect_ratio: i.ratio,
    resolution: model === 'minimax-h3' ? '1440P' : i.resolution, n: 1 };
  if (request.body.audio !== undefined) {
    if (typeof request.body.audio !== 'boolean') throw new Error('FunAI audio 必须为布尔值');
    if (!['minimax-h3', 'happy-horse-1.1'].includes(model)) throw new Error('此 FunAI 模型没有开放结果音轨开关');
    if (model === 'minimax-h3' && request.body.audio === false) throw new Error('MiniMax H3 固定生成原生音频');
    payload.audio = request.body.audio;
  }
  if (model === 'minimax-h3') {
    if (audios.length && (!images.length || first || last)) throw new Error('MiniMax 音频参考必须搭配普通参考图');
    if (first) payload.start_frame = first;
    if (last) payload.end_frame = last;
    if (images.length) payload.reference_images = images;
    if (audios.length) payload.audio_reference = audios;
  } else if (model === 'kling-o3' || model === 'kling-v3') {
    if (videos.length && (first || last || i.resolution.toLowerCase() === '4k')) throw new Error('Kling 源视频不能搭配首尾帧或 4K');
    if (first) payload.start_frame = first;
    if (last) payload.end_frame = last;
    if (images.length && model === 'kling-v3') {
      payload.start_frame = images[0]; if (images[1]) payload.end_frame = images[1];
    } else if (images.length) payload.reference_images = images;
    if (videos.length) { payload.input_video = videos[0]; delete payload.seconds; }
  } else if (model.startsWith('kling-')) {
    if (model !== 'kling-v3-omni-v2v-create' && images.length + Number(Boolean(first)) + Number(Boolean(last)) + videos.length > 4) throw new Error('Kling Reference 素材合计最多 4 项');
    // The first three ordinary images are elements; further images are styles.
    if (images.length) payload.element_references = images.slice(0, 3);
    if (images.length > 3) payload.style_references = images.slice(3);
    if (first) payload.images = [first, ...(last ? [last] : [])];
    if (videos.length) payload.input_video = videos[0];
  } else if (model.startsWith('happy-horse')) {
    if (videos.length && (images.length || first)) throw new Error('Happy Horse 参考视频不能与图片模式混用');
    if (first) payload.start_frame = first;
    if (images.length) payload.reference_images = images;
    if (videos.length) { payload.video_references = videos; delete payload.seconds; }
  } else if (model === 'gemini-omni') {
    if (images.length) payload.reference_images = images;
  } else if (model === 'gemini-omni-flash') {
    if (images.length + Number(Boolean(first)) + videos.length > 4) throw new Error('Omni Flash 参考素材合计最多 4 项');
    if (first) payload.input_reference = first;
    if (images.length) payload.element_references = images;
    if (videos.length) payload.input_video = videos[0];
  } else if (images.length || first) {
    payload.images = first ? [first, ...(last ? [last] : [])] : images;
  }
  return payload;
}
export function normalizeFunAiTask(raw: any, channel: FunAiChannel, id: string, kind: 'image' | 'video' = 'video') {
  const status = String(raw?.status || '').toLowerCase();
  if (!['queued', 'processing', 'in_progress', 'completed', 'failed', 'cancelled'].includes(status)) throw new FunAiApiError('FunAI 任务响应缺少有效状态', 502, true);
  const item = raw.data?.[0];
  let resultUrl = raw.url || item?.url || '';
  if (!resultUrl && item?.b64_json) resultUrl = 'data:image/png;base64,' + item.b64_json;
  if (status === 'completed' && !resultUrl && kind === 'video') resultUrl = funAiTaskUrl(channel.baseUrl, id) + '/content';
  if (resultUrl && !resultUrl.startsWith('data:image/')) {
    const url = new URL(resultUrl, funAiBaseUrl(channel.baseUrl) + '/');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new FunAiApiError('FunAI 返回了无效结果地址', 502, true);
    resultUrl = url.href;
  }
  return { status: status === 'in_progress' ? 'processing' : status, progress: Math.min(100, Math.max(0, Number(raw.progress) || 0)),
    resultUrl: status === 'completed' ? resultUrl : '', error: raw.error ? upstreamDiagnostic('FunAI', '任务 task_id=' + id, { error: raw.error, error_code: raw.error_code }, channel.apiKey) : '' };
}
export async function pollFunAiTask(channel: FunAiChannel, id: string, fetchImpl: typeof fetch = fetch, kind: 'image' | 'video' = 'video') {
  const response = await fetchImpl(funAiTaskUrl(channel.baseUrl, id), {
    headers: { Authorization: 'Bearer ' + channel.apiKey }, signal: AbortSignal.timeout(30_000), redirect: 'error',
  });
  if (!response.ok) throw new FunAiApiError(await responseDiagnostic('FunAI', '任务查询 task_id=' + id, response, channel.apiKey), response.status, true);
  return normalizeFunAiTask(await diagnosticJson('FunAI', '任务查询 task_id=' + id, response, channel.apiKey), channel, id, kind);
}

function blockedAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19].includes(b) || a >= 224;
  }
  return !/^[23][0-9a-f]{3}:/i.test(address); // Only globally routable IPv6 space.
}
function downloadPublicImage(url: URL, address: string, max: number): Promise<{ status: number; location: string; mime: string; bytes: Buffer }> {
  // Pin the validated DNS address for the actual connection, including every redirect.
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { lookup: ((_host: string, options: any, callback: any) => {
      const record = { address, family: isIP(address) };
      if (options?.all) callback(null, [record]); else callback(null, record.address, record.family);
    }) as any }, response => {
      const status = response.statusCode || 0, location = String(response.headers.location || ''), mime = String(response.headers['content-type'] || '');
      if (status >= 300 && status < 400) { response.resume(); resolve({ status, location, mime, bytes: Buffer.alloc(0) }); return; }
      if (status < 200 || status >= 300 || Number(response.headers['content-length']) > max) {
        response.destroy(); reject(new Error('参考图下载失败或超过 25 MiB')); return;
      }
      let size = 0; const chunks: Buffer[] = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > max) { response.destroy(new Error('参考图超过 25 MiB')); return; }
        chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => resolve({ status, location, mime, bytes: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    const timer = setTimeout(() => request.destroy(new Error('参考图下载超时')), 60_000);
    request.on('close', () => clearTimeout(timer)); request.on('error', reject); request.end();
  });
}
/** Gemini requires bytes, so read public HTTPS references without any channel credentials. */
export async function funAiInlineImage(source: string) {
  const max = 25 * 1024 * 1024;
  let bytes: Buffer, declared = '';
  if (source.startsWith('data:')) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(source);
    if (!match || match[2].length > Math.ceil(max / 3) * 4) throw new Error('FunAI 图片格式无效或超过 25 MiB');
    declared = match[1]; bytes = Buffer.from(match[2], 'base64');
  } else {
    let url = new URL(source); let downloaded: Buffer | undefined;
    for (let count = 0; count < 4; count++) {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (url.protocol !== 'https:' || url.username || url.password || /(^|\.)(localhost|local)$/i.test(host)) throw new Error('Gemini 参考图需要公网 HTTPS 地址或上传图片');
      const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
      if (!addresses.length || addresses.some(a => blockedAddress(a.address))) throw new Error('不能读取内网参考图');
      const response = await downloadPublicImage(url, addresses[0].address, max);
      if (response.status >= 300 && response.status < 400) {
        if (!response.location) throw new Error('参考图重定向无效');
        url = new URL(response.location, url); continue;
      }
      downloaded = response.bytes; declared = response.mime; break;
    }
    if (!downloaded) throw new Error('参考图重定向次数过多');
    bytes = downloaded;
  }
  const mime = detectedMediaMime(bytes, declared);
  if (!bytes.length || bytes.length > max || !['image/png', 'image/jpeg', 'image/webp'].includes(mime || '')) throw new Error('FunAI 参考图必须是有效的 PNG、JPEG 或 WebP');
  return { mimeType: mime!, data: bytes.toString('base64') };
}

export async function generateFunAiImage(channel: FunAiChannel, model: string, request: SpecificationRequest,
  fetchImpl: typeof fetch, onSubmitted: (id: string) => void, wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {
  if (funAiModelKind(model) !== 'image') throw new Error('FunAI 图片模型未适配');
  const mismatch = routingMismatches(funAiModelLimits(model), { ...request.input, images: request.images.length }, 'image');
  if (mismatch.length) throw new Error('FunAI：' + mismatch.join('；'));
  const gemini = isFunAiGeminiImage(model), base = funAiBaseUrl(channel.baseUrl);
  if (gemini && request.input.quality) throw new Error('Gemini 图片不支持 quality 参数');
  const parts: any[] = [{ text: request.prompt }];
  if (gemini) for (const source of request.images) parts.push({ inlineData: await funAiInlineImage(source) });
  const payload: any = gemini ? { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: { aspectRatio: request.input.ratio, imageSize: request.input.resolution.toUpperCase() } } }
    : { model, prompt: request.prompt, aspect_ratio: request.input.ratio, output_resolution: request.input.resolution.toUpperCase(),
      quality: request.input.quality || 'medium', n: 1, ...(request.images.length ? { images: request.images.map(reference) } : {}) };
  if (request.body.output_format !== undefined) {
    if (gemini || !['png', 'jpeg', 'webp'].includes(request.body.output_format)) throw new Error('此 FunAI 图片请求不支持该 output_format');
    payload.output_format = request.body.output_format;
  }
  const response = await fetchImpl(gemini ? base + '/v1beta/models/' + encodeURIComponent(model) + ':generateContent' : base + '/v1/videos', {
    method: 'POST', headers: { Authorization: 'Bearer ' + channel.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(channel.timeout || 120_000), redirect: 'error',
  });
  if (!response.ok) {
    const body = await response.clone().json().catch(() => null);
    const uncertain = Boolean(body?.id || body?.task_id || body?.data?.id || response.headers.get('x-task-id'))
      || response.status === 408 || response.status >= 500;
    throw new FunAiApiError(await responseDiagnostic('FunAI', '图片提交', response, channel.apiKey), response.status, uncertain, !uncertain);
  }
  let raw: any;
  try { raw = await diagnosticJson('FunAI', '图片提交响应；请勿重复提交', response, channel.apiKey); } catch (error: any) { throw new FunAiApiError(error.message, 502, true); }
  if (gemini) {
    const image = raw?.candidates?.[0]?.content?.parts?.find((part: any) => part.inlineData?.data)?.inlineData;
    if (!image) throw new FunAiApiError('Gemini 未返回图片，请核实原请求', 502, true);
    const valid = await funAiInlineImage('data:' + image.mimeType + ';base64,' + image.data);
    const imageUrl = 'data:' + valid.mimeType + ';base64,' + valid.data;
    return { imageUrl, reportedImageUrl: '[inline image]', taskId: '', raw: {} };
  }
  if (!['string', 'number'].includes(typeof raw?.id) || !String(raw.id).trim()) throw new FunAiApiError('FunAI 未返回图片任务 ID，请勿重复提交', 502, true);
  const id = String(raw.id); onSubmitted(id);
  const deadline = Date.now() + 20 * 60_000; let failures = 0;
  while (Date.now() < deadline) {
    let task: ReturnType<typeof normalizeFunAiTask>;
    try { task = await pollFunAiTask(channel, id, fetchImpl, 'image'); failures = 0; }
    catch (error: any) {
      if (error instanceof FunAiApiError && ![429, 500, 502, 503].includes(error.status)) throw error;
      if (++failures > 5) throw new FunAiApiError(transportDiagnostic('FunAI', '图片查询；保留原任务继续查询', error, channel.apiKey), 502, true);
      await wait(Math.min(30_000, 1000 * 2 ** failures) + Math.random() * 500); continue;
    }
    if (['failed', 'cancelled'].includes(task.status)) throw new FunAiApiError(task.error || 'FunAI 图片生成失败', 0, false, true);
    if (task.status === 'completed' && task.resultUrl) return { imageUrl: task.resultUrl, reportedImageUrl: task.resultUrl, taskId: id, raw: {} };
    await wait(5000);
  }
  throw new FunAiApiError('FunAI 图片原任务仍在处理中', 0, true);
}
import { responseDiagnostic, upstreamDiagnostic, diagnosticJson, transportDiagnostic } from './upstreamDiagnostic.js';
