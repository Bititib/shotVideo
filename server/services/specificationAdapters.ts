import { isMegabyChannel, buildMegabyVideoPayload, submitMegabyVideo, pollMegabyVideo, validateMegabyReferenceDurations, MegabyApiError } from './megabyVideoAdapter.js';
import { isZonghengChannel, submitZonghengVideo, normalizeZonghengTask, readZonghengTaskResponse, zonghengTaskUrl, ZonghengSubmissionError } from './zonghengAdapter.js';
import { zonghengProtocol, zonghengProtocolSnapshot } from './zonghengProtocol.js';
import { prepareZonghengMedia } from './zonghengMediaService.js';
import { fetchVideoTaskResponse } from './videoPollDeadline.js';
import { imageGenerationTimeout } from './imageGenerationTimeout.js';
import { isMjChannel, mjBaseUrl, buildMjImagePayload, MJ_ASYNC_TIMEOUT_MS, type MjAsyncImageState } from './mjAdapter.js';
import { isAsyncVideoChannel, buildAsyncVideoPayload, asyncVideoCreateUrl, pollAsyncVideo } from './asyncVideoAdapter.js';
import fs from 'node:fs';
import { extractImageUpstreamTaskId, imageResponseEvidence, type ImageResponseEvidence } from './imageTaskMetadataService.js';
import { isFunAiChannel, funAiBaseUrl, buildFunAiVideoPayload, pollFunAiTask, generateFunAiImage, FunAiApiError } from './funAiAdapter.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RouteCandidate } from './modelRoutingService.js';
import type { RoutingInput } from '../../shared/modelRouting.js';
import { buildHmStudioVideoPayload, buildHmStudioImageForm, hmStudioCreateUrl, hmStudioTaskUrl, normalizeHmStudioTask } from './hmStudioAdapter.js';
import { HAYA_XG_SEEDANCE_20_MODEL, hayaPublicModelId, validateHayaVideoInput } from '../../shared/hayaVideo.js';
import { buildSiYueTianSeedance25VideoPayload, getSiYueTianC2Model, getSiYueTianSeedance25VideoSpec } from './siYueTianVideoModels.js';
import { getHmStudioUpstreamVideoModel, getHmStudioPublicVideoModel, isHmStudioNovaVideoModel, validateHmStudioAdditionalVideoInput } from '../../shared/hmStudioVideo.js';
import { buildWxHaidiYueVideoPayload, wxHaidiYueCreateUrl, wxHaidiYueTaskUrl, normalizeWxHaidiYueTask, isWxHaidiYueChannel } from './wxHaidiYueAdapter.js';
import { buildMjNewApiVideoPayload, normalizeMjNewApiPrompt, isMjNewApiChannel } from './mjNewApiAdapter.js';
import { buildLongxiaVideoPayload, longxiaVideoCreateUrl, longxiaVideoTaskUrl, normalizeLongxiaVideoTask, isLongxiaChannel } from './longxiaVideoAdapter.js';
import { buildMiaowuVideoPayload, miaowuVideoCreateUrl, miaowuVideoTaskUrl, normalizeMiaowuVideoTask, isMiaowuChannel } from './miaowuVideoAdapter.js';
import { buildSnumomWanPayload, normalizeSnumomWanTask, isSnumomWanChannel, extractSnumomTaskId } from './snumomWanAdapter.js';
import { buildSudaShuiVideoPayload, sudaShuiVideoCreateUrl } from './sudaShuiAdapter.js';
import { buildNewTokenVideoPayload, newTokenVideoCreateUrl, isNewTokenChannel } from './newTokenAdapter.js';
import { buildJulunMinimaxH3Payload, isJulunMinimaxH3Model } from './julunMinimaxAdapter.js';
import { submitHayaVideo, HayaSubmissionError, hayaTaskUrl, normalizeHayaTask, isHayaChannel } from './hayaVideoAdapter.js';
import { prepareHayaMedia } from './hayaMediaService.js';
import { generateMingFeiImage, isMingFeiImageChannel, mingFeiImageContentUrl } from './mingFeiImageAdapter.js';
import { generateSiYueTianImage, isSiYueTianImageChannel, siYueTianImageContentUrl } from './siYueTianImageAdapter.js';
import { publishReferenceUrl } from './publicReferenceService.js';
import { isHussChannel, submitHussVideo, pollHussVideo, HussApiError } from './hussVideoAdapter.js';
import { registerUpload } from './uploadAccess.js';
import { isSnumomSubmissionRejection } from './snumomSubmissionRejection.js';
import { videoErrorTaskId, videoRequestNotSent, explicitVideoCreateError } from './videoSubmissionErrors.js';
import { isVideoQueryErrorPayload } from './videoFailureService.js';
import { classifyHmSubmission } from './hmStudioSubmission.js';

export type SpecificationRequest = { prompt: string; input: RoutingInput; images: string[]; videos: string[]; audios: string[]; firstFrame: string; lastFrame: string; body: Record<string, any>; publicBaseUrl: string };
export class SpecificationUpstreamError extends Error {
  constructor(message: string, public readonly retrySafe: boolean, public readonly uncertain = false, public readonly blocked = false, public readonly upstreamStatus = 0, public readonly confirmedFailure = false) { super(message); }
}
export function submissionFailure(status: number, text: string, channel?: { type?: string | null; baseUrl?: string | null }, videoSubmission = false, headers?: Pick<Headers, 'get'>): SpecificationUpstreamError {
  if (channel?.type === 'hmstudio') {
    let body: any; try { body = JSON.parse(text); } catch { body = text; }
    const decision = classifyHmSubmission(status, body, headers || new Headers());
    const rejected = decision.outcome === 'rejected';
    return new SpecificationUpstreamError(upstreamDiagnostic('HM Studio', '提交', body, '', status, headers?.get('x-request-id') || undefined),
      false, !rejected, false, status, rejected);
  }
  if (videoSubmission && isSnumomSubmissionRejection(status, text, channel, headers)) {
    return new SpecificationUpstreamError(upstreamDiagnostic('snumom', '上游明确拒绝', text, '', status, headers?.get('x-request-id') || undefined), false, false, false, status, true);
  }
  // The MJ contract defines HTTP 402 as a precharge rejection, even if a log ID is attached.
  // Classify by status, not provider wording or the presence of a diagnostic identifier.
  if (isMjChannel(channel) && status === 402) return new SpecificationUpstreamError(
    upstreamDiagnostic('MJ', '上游积分不足 (HTTP 402)', text, '', status, headers?.get('x-request-id') || undefined), true, false, false, status, true);
  // A gateway timeout/server error can happen AFTER the provider created a job.
  // Only explicit rejections without a task identifier are eligible for retry.
  let payload: any;
  try { payload = JSON.parse(text); } catch {}
  const task = videoSubmission ? videoErrorTaskId(payload, headers)
    : payload?.task_id || payload?.taskId || payload?.request_id || payload?.id || payload?.data?.task_id || payload?.data?.id;
  const rejected = !task && ([401, 402, 429].includes(status) || (status === 403 && /api.?key|unauthori[sz]ed|余额|quota|credit/i.test(text))
    || (!videoSubmission && status === 503 && /unavailable|maintenance|维护|不可用|overload|capacity|busy/i.test(text)));
  const blocked = [401, 402].includes(status) || (status === 403 && rejected);
  if ([502, 504, 524].includes(status) && /<!doctype\s+html|<html\b/i.test(text)) {
    return new SpecificationUpstreamError(upstreamDiagnostic(channel?.type || 'OpenAI-compatible', '上游网关响应超时，任务可能已受理或完成；请勿重复提交', text, '', status, headers?.get('x-request-id') || undefined), false, true, false, status);
  }
  const uncertain = Boolean(task) || status === 408 || status >= 500 && !rejected;
  return new SpecificationUpstreamError(upstreamDiagnostic(channel?.type || 'OpenAI-compatible', '提交', text, '', status, headers?.get('x-request-id') || undefined),
    rejected, uncertain, blocked, status, !uncertain);
}
export function publishSpecificationAsset(source: string, baseUrl: string): string {
  if (!source.startsWith('data:')) return publishReferenceUrl(source, baseUrl);
  const match = source.match(/^data:([\w.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match || !/^(image|video|audio)\//.test(match[1])) throw new Error('素材格式无效');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 100 * 1024 * 1024) throw new Error('素材内容为空或超过 100MB');
  const extensions: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'video/mp4': 'mp4', 'video/webm': 'webm' };
  const ext = extensions[match[1]]; if (!ext) throw new Error('不支持的素材格式');
  const name = 'spec_' + randomUUID() + '.' + ext;
  fs.mkdirSync(path.resolve('data/uploads'), { recursive: true });
  fs.writeFileSync(path.resolve('data/uploads', name), buffer);
  registerUpload(name);
  return publishReferenceUrl('/uploads/' + name, baseUrl);
}
const apiBase = (url: string) => url.replace(/\/+$/, '').replace(/\/v1$/i, '');
async function post(url: string, channel: any, payload: unknown, onStarting: () => void, onParsed?: (body: any, headers: Headers) => void, onResponse?: (evidence: ImageResponseEvidence) => void, evidenceFor = imageResponseEvidence) {
  const form = payload instanceof FormData;
  onStarting();
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + channel.apiKey, ...(!form ? { 'Content-Type': 'application/json' } : {}) },
      body: form ? payload : JSON.stringify(payload), signal: AbortSignal.timeout(channel.timeout || 120_000), redirect: 'error' });
  } catch (e: any) {
    onResponse?.({ id: '', state: 'no_response' });
    const code = e?.cause?.code || e?.code;
    const notSent = videoRequestNotSent(e);
    throw new SpecificationUpstreamError(transportDiagnostic(channel.type || 'OpenAI-compatible', '提交连接；请核实原请求', e, channel.apiKey), notSent, !notSent);
  }
  onResponse?.(evidenceFor(undefined, response.headers, response.status, 'headers_received'));
  if (!response.ok) {
    let text: string;
    try { text = await response.text(); }
    catch (error: any) {
      onResponse?.(evidenceFor(undefined, response.headers, response.status, 'response_unreadable'));
      if (isMjChannel(channel) && response.status === 402) throw submissionFailure(402, '错误响应正文未完整读取', channel, false, response.headers);
      throw new SpecificationUpstreamError(upstreamDiagnostic(channel.type || 'OpenAI-compatible', '上游错误响应读取中断，请核实原请求', { message: error.message, code: error.cause?.code }, channel.apiKey, response.status, response.headers.get('x-request-id') || undefined), false, true);
    }
    let body: unknown; try { body = JSON.parse(text); } catch {}
    onResponse?.(evidenceFor(body, response.headers, response.status, 'response_without_id'));
    throw submissionFailure(response.status, channel.apiKey ? text.split(channel.apiKey).join('[REDACTED]') : text, channel, channel.videoSubmission === true, response.headers);
  }
  let result: any;
  try { result = await diagnosticJson(channel.type || 'OpenAI-compatible', '提交响应；请勿重复提交', response, channel.apiKey); }
  catch (error: any) { onResponse?.(evidenceFor(undefined, response.headers, response.status, 'response_unreadable')); throw new SpecificationUpstreamError(error.message, false, true); }
  onResponse?.(evidenceFor(result, response.headers, response.status, 'response_without_id'));
  if (channel.type === 'hmstudio' && classifyHmSubmission(response.status, result, response.headers).outcome !== 'accepted')
    throw submissionFailure(response.status, JSON.stringify(result), channel, channel.videoSubmission === true, response.headers);
  if (channel.videoSubmission && (isSnumomSubmissionRejection(response.status, JSON.stringify(result), channel, response.headers)
    || explicitVideoCreateError(result, response.headers))) {
    throw submissionFailure(response.status, JSON.stringify(result), channel, true, response.headers);
  }
  onParsed?.(result, response.headers);
  return result;
}
export async function submitSpecificationVideo(target: RouteCandidate, request: SpecificationRequest, onStarting: (metadata?: Record<string, unknown>) => void) {
  const c = { ...target.channel, videoSubmission: true }, model = target.route.upstreamModel, exec = target.route.executionModel, i = request.input;
  if (isZonghengChannel(c)) {
    let acceptedTaskId = '';
    try {
      const protocol = zonghengProtocol(c), snapshot = zonghengProtocolSnapshot(c), orderId = randomUUID();
      const options = { ...c, publicBaseUrl: request.publicBaseUrl, protocol };
      const images = await prepareZonghengMedia(request.images, 'image', options);
      const videos = await prepareZonghengMedia(request.videos, 'video', options);
      const audios = await prepareZonghengMedia(request.audios, 'audio', options);
      const frames = await prepareZonghengMedia([request.firstFrame, request.lastFrame].filter(Boolean), 'image', options);
      const job = await submitZonghengVideo(c.baseUrl, c.apiKey, { model, prompt: request.prompt, seconds: i.seconds,
        ratio: i.ratio, resolution: i.resolution, images, videos, audios, firstFrame: frames[0], lastFrame: frames[1],
        quality: request.body.quality, negativePrompt: request.body.negative_prompt, generateAudio: request.body.generate_audio }, orderId,
        () => onStarting({ ...snapshot, zonghengOrderId: orderId }), c.timeout, protocol, taskId => {
          acceptedTaskId = taskId;
          onStarting({ ...snapshot, videoId: taskId });
        });
      onStarting({ ...snapshot, videoId: job.taskId, zonghengInitialTask: job.initialTask,
        ...(job.warning ? { zonghengSubmissionDiagnostics: { ...job.warning.diagnostics, message: job.warning.message, recordedAt: new Date().toISOString() } } : {}) });
      return job.taskId;
    } catch (error: any) {
      if (acceptedTaskId) throw new SpecificationUpstreamError(error.message, false, true);
      if (error instanceof SpecificationUpstreamError) throw error;
      if (error instanceof ZonghengSubmissionError) throw new SpecificationUpstreamError(error.message, false, error.uncertain, false, error.diagnostics?.httpStatus || 0, !error.uncertain);
      throw new SpecificationUpstreamError(error.message, true);
    }
  }
  if (isMegabyChannel(c)) {
    let payload: ReturnType<typeof buildMegabyVideoPayload>;
    try {
      if (request.body.first_image !== undefined || request.body.last_image !== undefined) throw new Error('Megaby 暂不支持独立首尾帧');
      const refs = (sources: string[]) => sources.map(source => publishSpecificationAsset(source, request.publicBaseUrl));
      payload = buildMegabyVideoPayload({ ...request, model, seconds: i.seconds, ratio: i.ratio, resolution: i.resolution,
        images: refs(request.images), videos: refs(request.videos), audios: refs(request.audios) });
      await validateMegabyReferenceDurations(request.videos, request.audios);
    } catch (error: any) { throw new SpecificationUpstreamError(error.message, true); }
    try { return await submitMegabyVideo(c, payload, onStarting); }
    catch (error: any) {
      if (error instanceof MegabyApiError) throw new SpecificationUpstreamError(error.message, false, error.uncertain, false, error.upstreamStatus, error.confirmedFailure);
      throw error;
    }
  }
  if (isMjChannel(c)) throw new SpecificationUpstreamError('MJ 渠道仅接入 MJ 图片模型', true);
  if (isAsyncVideoChannel(c)) {
    let payload: ReturnType<typeof buildAsyncVideoPayload>;
    try {
      payload = buildAsyncVideoPayload({ ...request, model, seconds: i.seconds, ratio: i.ratio,
        images: request.images.map(source => publishSpecificationAsset(source, request.publicBaseUrl)) });
    } catch (error: any) { throw new SpecificationUpstreamError(error.message, true); }
    const job = await post(asyncVideoCreateUrl(c.baseUrl), c, payload, onStarting);
    if (!['string', 'number'].includes(typeof job?.task_id) || !String(job.task_id).trim()) {
      throw new SpecificationUpstreamError('异步视频未返回任务 ID，请核实原请求', false, true);
    }
    return String(job.task_id);
  }
  if (isFunAiChannel(c)) {
    let payload: Record<string, any>;
    try {
      const refs = (items: string[]) => items.map(s => s.startsWith('data:') ? s : publishSpecificationAsset(s, request.publicBaseUrl));
      payload = buildFunAiVideoPayload(model, { ...request, images: refs(request.images), videos: refs(request.videos), audios: refs(request.audios),
        firstFrame: request.firstFrame ? refs([request.firstFrame])[0] : '', lastFrame: request.lastFrame ? refs([request.lastFrame])[0] : '' });
    } catch (error: any) { throw new SpecificationUpstreamError(error.message, true); }
    const job = await post(funAiBaseUrl(c.baseUrl) + '/v1/videos', c, payload, onStarting);
    if (!['string','number'].includes(typeof job?.id) || !String(job.id).trim()) throw new SpecificationUpstreamError('FunAI 未返回任务 ID，请核实原请求', false, true);
    return String(job.id);
  }
  if (isHussChannel(c)) {
    try {
      return await submitHussVideo(c, { model, prompt: request.prompt, seconds: i.seconds, ratio: i.ratio, resolution: i.resolution, images: request.images, videos: request.videos, audios: request.audios, firstFrame: request.firstFrame, lastFrame: request.lastFrame, publicBaseUrl: request.publicBaseUrl }, payload => onStarting({ hussIdempotencyKey: payload.idempotency_key, hussPayload: payload }), raw => onStarting({ hussInitialTask: raw }));
    } catch (error: any) {
      if (error instanceof HussApiError && error.retryAfterMs > 0) onStarting({ hussReceiptRetryAt: Date.now() + error.retryAfterMs });
      if (error instanceof HussApiError) throw new SpecificationUpstreamError(error.message, model !== 'hss-2.5-301010' && !error.uncertain && [401, 402, 429].includes(error.status), error.uncertain, [401, 402, 403].includes(error.status), error.status, !error.uncertain);
      throw new SpecificationUpstreamError(error.message || 'HUSS 视频提交失败', true);
    }
  }
  const base = apiBase(c.baseUrl);
  const unsupported = (message: string): never => { throw new SpecificationUpstreamError(message, true); };
  if ((request.firstFrame || request.lastFrame) && c.type !== 'hmstudio' && !isSnumomWanChannel(c) && !(isNewTokenChannel(c) && exec === 'veo-3-1') && !/^sora-v4-/.test(exec)) unsupported('此线路协议不支持独立首尾帧');
  const refs = (items: string[]) => items.map(item => publishSpecificationAsset(item, request.publicBaseUrl));
  let payload: any, url = base + '/v1/videos';
  if (c.type === 'hmstudio') {
    if (isHmStudioNovaVideoModel(exec) || isHmStudioNovaVideoModel(model)) {
      const error = validateHmStudioAdditionalVideoInput(getHmStudioPublicVideoModel(isHmStudioNovaVideoModel(model) ? model : exec), {
        seconds: i.seconds, resolution: i.resolution, ratio: i.ratio, imageCount: request.images.length,
        videoCount: request.videos.length, audioCount: request.audios.length,
        hasFirstFrame: Boolean(request.firstFrame), hasLastFrame: Boolean(request.lastFrame),
      });
      if (error) unsupported(error);
    }
    if ((request.firstFrame || request.lastFrame) && (request.images.length || request.videos.length || request.audios.length)) unsupported('HM 独立首尾帧不能与普通参考素材混用');
    payload = buildHmStudioVideoPayload({ model: getHmStudioUpstreamVideoModel(model), prompt: request.prompt, duration: i.seconds,
      ratio: i.ratio, resolution: i.resolution, functionMode: request.images.length || request.videos.length || request.audios.length ? 'omni_reference' : undefined, imageSources: request.images, videoSources: request.videos, audioSources: request.audios,
      firstFrame: request.firstFrame, lastFrame: request.lastFrame, localMediaBaseUrl: request.publicBaseUrl, face: true });
    url = hmStudioCreateUrl(c.baseUrl, 'video');
  } else if (isHayaChannel(c)) {
    if (hayaPublicModelId(model) === HAYA_XG_SEEDANCE_20_MODEL && request.body.content !== undefined) unsupported('此规格入口请使用 reference_images 和 audio_urls 传递素材');
    const validation = validateHayaVideoInput(model, { seconds: i.seconds, resolution: i.resolution, ratio: i.ratio, imageCount: request.images.length, videoCount: request.videos.length, audioCount: request.audios.length, firstFrame: request.firstFrame, lastFrame: request.lastFrame, metadata: request.body.metadata });
    if (validation) unsupported(validation);
    const options = { baseUrl: c.baseUrl, apiKey: c.apiKey, publicBaseUrl: request.publicBaseUrl };
    const input = { model, prompt: request.prompt, seconds: i.seconds, ratio: i.ratio, resolution: i.resolution,
      images: await prepareHayaMedia(request.images, 'image', options), videos: await prepareHayaMedia(request.videos, 'video', options),
      audios: await prepareHayaMedia(request.audios, 'audio', options) };
    try {
      const job = await submitHayaVideo(c.baseUrl, c.apiKey, input, onStarting,
        requestId => { if (requestId) onStarting({ requestId }); });
      return job.taskId;
    } catch (error) {
      if (error instanceof HayaSubmissionError) throw new SpecificationUpstreamError(error.message, false, error.uncertain, false, 0, !error.uncertain);
      throw error;
    }
  } else if (isWxHaidiYueChannel(c)) {
    if (request.firstFrame || request.lastFrame) throw new Error('此线路不支持独立首尾帧');
    payload = buildWxHaidiYueVideoPayload({ model, prompt: request.prompt, duration: i.seconds, aspectRatio: i.ratio,
      images: refs(request.images), videos: refs(request.videos), audios: refs(request.audios),
      faceSplit: request.body.local_face_processed ? false : request.body.face_split ?? Boolean(c.faceSplitEnabled) });
    url = wxHaidiYueCreateUrl(c.baseUrl);
  } else if (isLongxiaChannel(c)) {
    payload = buildLongxiaVideoPayload({ model, prompt: request.prompt, seconds: i.seconds, ratio: i.ratio, resolution: i.resolution,
      imageUrls: request.images.map(s => s.startsWith('data:') ? s : publishSpecificationAsset(s, request.publicBaseUrl)),
      videoUrls: request.videos, audioUrls: request.audios.map(s => s.startsWith('data:') ? s : publishSpecificationAsset(s, request.publicBaseUrl)),
      firstFrame: request.firstFrame, lastFrame: request.lastFrame });
    url = longxiaVideoCreateUrl(c.baseUrl);
  } else if (isMiaowuChannel(c)) {
    payload = buildMiaowuVideoPayload({ model, prompt: request.prompt, seconds: i.seconds, ratio: i.ratio, resolution: i.resolution,
      imageUrls: refs(request.images), videoUrls: refs(request.videos), audioUrls: refs(request.audios) });
    url = miaowuVideoCreateUrl(c.baseUrl);
  } else if (isMjNewApiChannel(c)) {
    payload = buildMjNewApiVideoPayload({ model, prompt: request.prompt, duration: i.seconds, aspectRatio: i.ratio, resolution: i.resolution,
      images: refs(request.images), videos: refs(request.videos), audios: refs(request.audios) });
  } else if (isSnumomWanChannel(c)) {
    payload = buildSnumomWanPayload({ model, prompt: request.prompt, seconds: i.seconds, aspectRatio: i.ratio, resolution: i.resolution,
      images: [...refs(request.images).map(url => ({ url, role: 'reference_image' as const })),
        ...(request.firstFrame ? [{ url: publishSpecificationAsset(request.firstFrame, request.publicBaseUrl), role: 'first_frame' as const }] : []),
        ...(request.lastFrame ? [{ url: publishSpecificationAsset(request.lastFrame, request.publicBaseUrl), role: 'last_frame' as const }] : [])],
      videos: refs(request.videos).map(url => ({ url })), audios: refs(request.audios).map(url => ({ url })) });
  } else if (/sudashuiapi\.com/i.test(c.baseUrl) || c.type === 'sudashui') {
    payload = buildSudaShuiVideoPayload({ model, prompt: request.prompt, duration: i.seconds, aspectRatio: i.ratio,
      imageUrls: refs(request.images), videoUrls: refs(request.videos), audioUrls: refs(request.audios) });
    url = sudaShuiVideoCreateUrl(c.baseUrl);
  } else if (isNewTokenChannel(c)) {
    if (!['16:9', '9:16'].includes(i.ratio)) unsupported('NewToken 此线路只支持 16:9 / 9:16');
    if (exec.startsWith('veo-')) {
      if (i.seconds !== (exec === 'veo-3-1' ? 8 : 10) || request.audios.length || (exec !== 'veo-omni-flash-video-edit' && request.videos.length) || request.images.length > 9) unsupported('Veo 线路时长或素材不匹配');
    } else if (request.images.length > 9 || request.videos.length > 3 || request.audios.length > 3 || request.firstFrame || request.lastFrame) unsupported('NewToken Seedance 素材超限或首尾帧不受支持');
    payload = buildNewTokenVideoPayload({ model: exec, upstreamModel: model, prompt: request.prompt, duration: i.seconds, aspectRatio: i.ratio,
      images: refs(request.images), videos: refs(request.videos), audios: refs(request.audios),
      firstFrame: request.firstFrame ? publishSpecificationAsset(request.firstFrame, request.publicBaseUrl) : undefined, lastFrame: request.lastFrame ? publishSpecificationAsset(request.lastFrame, request.publicBaseUrl) : undefined,
      complianceEnabled: request.body.compliance_enabled, complianceMode: request.body.compliance_mode });
    url = newTokenVideoCreateUrl(c.baseUrl);
  } else if (isJulunMinimaxH3Model(exec)) {
    if (request.images.length > 9 || request.videos.length > 3 || request.audios.length > 3 || i.resolution !== '768p' || ![10,15].includes(i.seconds)) unsupported('巨轮 H3 线路素材、时长或分辨率不匹配');
    payload = buildJulunMinimaxH3Payload({ model, prompt: request.prompt, seconds: i.seconds, ratio: i.ratio,
      imageUrls: refs(request.images), videoUrls: refs(request.videos), audioUrls: refs(request.audios) });
  } else if (exec === 'wan3.0th') {
    if (request.audios.some(a => !/^data:audio\/(?:x-)?wav[;,]/i.test(a) && !a.split('?')[0].toLowerCase().endsWith('.wav'))) unsupported('WAN3.0 此线路音频仅支持 WAV');
    payload = { model, prompt: request.prompt, seconds: i.seconds, ratio: i.ratio, resolution: i.resolution, image_urls: refs(request.images), video_urls: refs(request.videos), audio_urls: refs(request.audios) };
  } else if (getSiYueTianSeedance25VideoSpec(exec) || getSiYueTianC2Model(exec)) {
    payload = buildSiYueTianSeedance25VideoPayload({ model, prompt: normalizeMjNewApiPrompt(request.prompt), seconds: i.seconds, aspectRatio: i.ratio, imageUrls: refs(request.images), videoUrls: refs(request.videos), audioUrls: refs(request.audios) });
  } else if (/^sora-v4-/.test(exec)) {
    if (request.audios.length || request.videos.length > 1 || (request.images.length && (request.firstFrame || request.lastFrame))) unsupported('Sora V4 素材组合不受支持');
    const frames = refs([request.firstFrame, request.lastFrame].filter(Boolean));
    payload = { model, prompt: request.prompt, duration: i.seconds, video_config: { aspect_ratio: i.ratio, resolution_name: i.resolution, reference_mode: request.lastFrame ? 'start_end' : request.firstFrame ? 'start_frame' : request.images.length ? 'image_reference' : 'auto' }, reference_images: frames.length ? frames : refs(request.images), ...(request.videos.length ? { reference_video: refs(request.videos)[0] } : {}) };
  } else if (!/seedance|^sd2|^sd-mini/.test(exec)) {
    if (request.videos.length || request.audios.length || request.firstFrame || request.lastFrame) unsupported('此通用线路只配置了图片参考协议');
    const form = new FormData();
    for (const [key, value] of Object.entries({ model, prompt: request.prompt, seconds: i.seconds, size: ({ '16:9': '1280x720', '9:16': '720x1280', '1:1': '1024x1024', '4:3': '1024x768', '3:4': '768x1024' } as Record<string,string>)[i.ratio] || i.ratio, resolution_name: i.resolution })) form.append(key, String(value));
    for (const source of request.images) { const match = source.match(/^data:([^;]+);base64,(.+)$/s); if (!match) unsupported('参考图未完成校验'); form.append('input_reference[]', new Blob([Buffer.from(match![2], 'base64')], { type: match![1] }), 'reference.jpg'); }
    payload = form;
  } else {
    // Existing Seedance JSON protocol. Every reference is forwarded; none is sliced.
    payload = { model, prompt: normalizeMjNewApiPrompt(request.prompt), duration: i.seconds, seconds: i.seconds, aspect_ratio: i.ratio, resolution: i.resolution,
      image_refs: refs(request.images), video_refs: refs(request.videos), audio_refs: refs(request.audios),
      ...(request.firstFrame ? { first_frame: publishSpecificationAsset(request.firstFrame, request.publicBaseUrl) } : {}),
      ...(request.lastFrame ? { last_frame: publishSpecificationAsset(request.lastFrame, request.publicBaseUrl) } : {}) };
  }
  let taskHeaders: Headers | undefined;
  const job = await post(url, c, payload, onStarting, (_body, headers) => { taskHeaders = headers; });
  if (c.type === 'hmstudio') {
    const decision = classifyHmSubmission(200, job, taskHeaders || new Headers());
    if (decision.outcome !== 'accepted') throw submissionFailure(200, JSON.stringify(job), c, true, taskHeaders);
    return decision.taskId;
  }
  const id = isSnumomWanChannel(c) ? extractSnumomTaskId(job, taskHeaders)
    : job.task_id || job.taskId || job.id || job.data?.task_id || job.data?.id || job.request_id;
  if (!id) throw new SpecificationUpstreamError(upstreamDiagnostic(c.type || 'OpenAI-compatible', '上游未返回任务 ID，提交结果待核实，请勿重复提交', job, c.apiKey, undefined, taskHeaders?.get('x-request-id') || undefined), false, true);
  return String(id);
}
export async function pollSpecificationVideo(channel: any, taskId: string) {
  if (isZonghengChannel(channel)) {
    const response = await fetchVideoTaskResponse(zonghengTaskUrl(channel.baseUrl, taskId), { headers: { Authorization: 'Bearer ' + channel.apiKey, 'Cache-Control': 'no-cache, no-store' }, cache: 'no-store', redirect: 'error' });
    return normalizeZonghengTask(await readZonghengTaskResponse(response, channel.baseUrl, taskId, channel.apiKey), channel.baseUrl, 'v6k', taskId);
  }
  if (isMegabyChannel(channel)) return pollMegabyVideo(channel, taskId);
  if (isAsyncVideoChannel(channel)) return pollAsyncVideo(channel, taskId);
  if (isFunAiChannel(channel)) return pollFunAiTask(channel, taskId);
  if (isHussChannel(channel)) return pollHussVideo(channel, taskId);
  const base = apiBase(channel.baseUrl);
  const url = channel.type === 'hmstudio' ? hmStudioTaskUrl(channel.baseUrl, taskId)
    : isHayaChannel(channel) ? hayaTaskUrl(channel.baseUrl, taskId)
    : isWxHaidiYueChannel(channel) ? wxHaidiYueTaskUrl(channel.baseUrl, taskId)
    : isLongxiaChannel(channel) ? longxiaVideoTaskUrl(channel.baseUrl, taskId)
    : isMiaowuChannel(channel) ? miaowuVideoTaskUrl(channel.baseUrl, taskId)
    : /sudashuiapi\.com/i.test(base) || channel.type === 'sudashui' ? base + '/v1/video/generations/' + encodeURIComponent(taskId)
    : base + '/v1/videos/' + encodeURIComponent(taskId);
  const response = await fetch(url, { headers: { Authorization: 'Bearer ' + channel.apiKey }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(await responseDiagnostic(channel.type || 'custom', '视频查询 task_id=' + taskId, response, channel.apiKey));
  const raw = await diagnosticJson(channel.type || 'OpenAI-compatible', '视频查询 task_id=' + taskId, response, channel.apiKey);
  if (isVideoQueryErrorPayload(raw)) throw new Error(upstreamDiagnostic(channel.type || 'OpenAI-compatible', '视频查询异常 task_id=' + taskId, raw, channel.apiKey, response.status));
  if (isSnumomWanChannel(channel)) {
    const responseTaskId = extractSnumomTaskId(raw);
    if (responseTaskId && responseTaskId !== taskId) throw new Error('上游查询任务编号不一致，继续核实原任务');
  }
  if (channel.type === 'hmstudio') return normalizeHmStudioTask(raw, channel.baseUrl);
  if (isHayaChannel(channel)) return normalizeHayaTask(raw, channel.baseUrl, taskId);
  if (isWxHaidiYueChannel(channel)) return normalizeWxHaidiYueTask(raw, channel.baseUrl);
  if (isLongxiaChannel(channel)) return normalizeLongxiaVideoTask(raw);
  if (isMiaowuChannel(channel)) return normalizeMiaowuVideoTask(raw, channel.baseUrl, taskId);
  if (isSnumomWanChannel(channel)) return normalizeSnumomWanTask(raw);
  const data = raw.data && !Array.isArray(raw.data) ? raw.data : raw;
  return { status: String(data.status || raw.status || '').toLowerCase(), progress: Number(data.progress || data.progress_pct || 0),
    resultUrl: String(data.url || data.video_url || data.result_url || data.output?.url || data.output?.video_url || data.metadata?.url || data.result?.url || data.result?.video_url || (Array.isArray(data.data) ? data.data[0]?.url : '') || ''),
    error: data.error || data.message || data.error_code || data.code ? upstreamDiagnostic(channel.type || 'OpenAI-compatible', '任务 task_id=' + taskId, data, channel.apiKey, response.status, response.headers.get('x-request-id') || undefined) : '' };
}
function mjResponseEvidence(payload: any, headers: Headers, httpStatus: number,
  stage: 'headers_received' | 'response_without_id' | 'response_unreadable'): ImageResponseEvidence {
  // Async id is a volatile polling handle, including on completed/failed responses.
  // Keep compatibility with older synchronous responses that used id with data[].url.
  if (payload && httpStatus < 400 && (payload.status || !Array.isArray(payload.data) || !payload.data.length)) {
    const withoutHandle = (node: any) => node && typeof node === 'object' ? { ...node, id: undefined } : node;
    const receipt = { ...withoutHandle(payload), result: withoutHandle(payload.result),
      data: Array.isArray(payload.data) ? payload.data.map(withoutHandle) : withoutHandle(payload.data) };
    return imageResponseEvidence(receipt, headers, httpStatus, stage);
  }
  return imageResponseEvidence(payload, headers, httpStatus, stage);
}
function mjImageResult(raw: any, taskId: string) {
  const data = raw?.data ?? raw?.result?.data;
  const imageUrls: string[] = Array.isArray(data) ? data.map((item: any) => item?.url).filter((url: any) => typeof url === 'string' && url.trim()) : [];
  if (!imageUrls.length || imageUrls.length > 4 || imageUrls.length !== data.length) {
    throw new SpecificationUpstreamError('MJ 已响应但图片结果数量异常，请核实原请求', false, true);
  }
  return { imageUrl: imageUrls[0], imageUrls, reportedImageUrl: imageUrls[0], taskId, raw };
}
const mjPendingStatuses = ['queued', 'in_progress', 'pending', 'processing', 'running'];
/** GET-only continuation: never resubmit a paid image request, even when a handle expires. */
export async function pollMjSpecificationImage(channel: any, initial: MjAsyncImageState,
  onSubmitted: (id: string) => void, onResponse: ((evidence: ImageResponseEvidence) => void) | undefined,
  onState: (state: MjAsyncImageState) => void, checkReservation: () => void = () => {}) {
  let state = { ...initial }, errors = 0;
  const update = (values: Partial<MjAsyncImageState>) => { state = { ...state, ...values }; onState(state); };
  while (Date.now() < state.deadlineAt) {
    checkReservation();
    let response: Response, raw: any;
    try {
      response = await fetch(mjBaseUrl(channel.baseUrl) + '/v1/images/' + encodeURIComponent(state.handle), {
        headers: { Authorization: 'Bearer ' + channel.apiKey }, redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, Math.min(channel.timeout || 60_000, 60_000, state.deadlineAt - Date.now()))),
      });
      if (!response.ok) {
        // These describe the query, not a confirmed failure of the accepted task.
        if ([400, 401, 402, 403, 404, 410].includes(response.status)) {
          update({ status: 'unavailable', lastPollAt: Date.now() });
          throw new SpecificationUpstreamError(await responseDiagnostic('MJ', '原任务查询 handle=' + state.handle + '；请核实原任务', response, channel.apiKey), false, true, false, response.status);
        }
        throw new Error(await responseDiagnostic('MJ', '原任务查询 handle=' + state.handle, response, channel.apiKey));
      }
      raw = await response.json();
    } catch (error: any) {
      if (error instanceof SpecificationUpstreamError) throw error;
      update({ status: 'poll_error', lastPollAt: Date.now() });
      if (++errors >= 3) throw new SpecificationUpstreamError(transportDiagnostic('MJ', '原任务查询中断 handle=' + state.handle + '；请核实原任务', error, channel.apiKey), false, true);
      await new Promise(resolve => setTimeout(resolve, 5000));
      continue;
    }
    checkReservation();
    errors = 0;
    const evidence = mjResponseEvidence(raw, response.headers, response.status, 'response_without_id');
    onResponse?.(evidence);
    if (evidence.id) onSubmitted(evidence.id);
    const status = String(raw?.status || '').toLowerCase();
    const progress = typeof raw?.progress === 'number' && Number.isFinite(raw.progress) ? Math.max(0, Math.min(99, raw.progress)) : state.progress;
    if (status === 'completed') {
      const result = mjImageResult(raw, evidence.id);
      update({ status, progress: 100, lastPollAt: Date.now() });
      return result;
    }
    if (status === 'failed') {
      update({ status, lastPollAt: Date.now() });
      const detail = String(raw?.error?.message || raw?.error || raw?.message || 'MJ 图片生成失败');
      const safe = upstreamDiagnostic('MJ', '任务失败 handle=' + state.handle, raw, channel.apiKey, response.status);
      throw new SpecificationUpstreamError(safe, false, false, false, response.status, true);
    }
    if (!mjPendingStatuses.includes(status)) {
      update({ status: 'unrecognized', lastPollAt: Date.now() });
      throw new SpecificationUpstreamError(upstreamDiagnostic('MJ', '原任务未知状态 ' + status + '；请核实原任务', raw, channel.apiKey, response.status), false, true);
    }
    update({ status, progress, lastPollAt: Date.now() });
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  update({ status: 'timed_out' });
  throw new SpecificationUpstreamError('MJ 原任务查询超时，请核实原任务；不会重新生成', false, true);
}

export async function generateSpecificationImage(target: RouteCandidate, request: SpecificationRequest, onStarting: () => void, onSubmitted: (id: string) => void, onResponse?: (evidence: ImageResponseEvidence) => void,
  onMjAsyncState: (state: MjAsyncImageState) => void = () => {}, checkMjReservation: () => void = () => {},
  onPidoiFallback?: (state: import('./pidoiImageAdapter.js').PidoiFallbackState) => void) {
  const c = { ...target.channel, timeout: imageGenerationTimeout(target.channel) }, model = target.route.upstreamModel, i = request.input;
  let started = false;
  const trackedFetch: typeof fetch = async (url, init) => {
    init = { ...init, signal: init?.signal || AbortSignal.timeout(c.timeout || 120_000), redirect: 'error' };
    if (init?.method?.toUpperCase() === 'POST') { onStarting(); started = true; }
    let response: Response;
    try { response = await fetch(url, init); }
    catch (e: any) {
      if (!started || isPidoiImageChannel(c)) throw e;
      const notSent = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(e?.cause?.code || e?.code);
      throw new SpecificationUpstreamError(transportDiagnostic(c.type || 'OpenAI-compatible', '图片提交连接失败', e, c.apiKey), notSent, !notSent);
    }
    if (init?.method?.toUpperCase() === 'POST' && !response.ok && !isPidoiImageChannel(c)) {
      const text = await response.text();
      throw submissionFailure(response.status, c.apiKey ? text.split(c.apiKey).join('[REDACTED]') : text, c, false, response.headers);
    }
    if (!isFunAiChannel(c) && init?.method?.toUpperCase() !== 'POST' && response.ok && /json/.test(response.headers.get('content-type') || '')) {
      const task = await response.clone().json().catch(() => null) as any;
      if (task?.status === 'failed') throw new SpecificationUpstreamError(upstreamDiagnostic(c.type || 'OpenAI-compatible', '图片任务失败', task, c.apiKey, response.status), false, false, false, 0, true);
    }
    return response;
  };
  if (isFunAiChannel(c)) {
    try { return await generateFunAiImage(c, model, request, trackedFetch, onSubmitted); }
    catch (error: any) {
      if (error instanceof SpecificationUpstreamError) throw error;
      if (error instanceof FunAiApiError) throw new SpecificationUpstreamError(error.message, false, error.uncertain, false, error.status, error.confirmedFailure);
      throw new SpecificationUpstreamError(error.message || 'FunAI 图片生成失败', !started, started);
    }
  }
  if (isMjChannel(c)) {
    let payload: ReturnType<typeof buildMjImagePayload>;
    try {
      payload = buildMjImagePayload({ model, prompt: request.prompt, resolution: i.resolution, ratio: i.ratio,
        images: request.images, videos: request.videos, audios: request.audios, firstFrame: request.firstFrame,
        lastFrame: request.lastFrame, outputs: i.outputs, size: request.body.size, quality: i.quality || request.body.quality });
    } catch (error: any) { throw new SpecificationUpstreamError(error.message, true); }
    const url = mjBaseUrl(c.baseUrl) + '/v1/images/' + (payload instanceof FormData ? 'edits' : 'generations');
    let taskId = '';
    const submittedAt = Date.now();
    const raw = await post(url, c, payload, onStarting, (body, headers) => {
      taskId = mjResponseEvidence(body, headers, 200, 'response_without_id').id;
      if (taskId) onSubmitted(taskId);
    }, onResponse, mjResponseEvidence).catch((error: Error) => { error.message = error.message.replace(/kmai/gi, 'MJ'); throw error; });
    const status = String(raw?.status || '').toLowerCase();
    if (status === 'failed') {
      const detail = String(raw?.error?.message || raw?.error || raw?.message || 'MJ 图片生成失败');
      throw new SpecificationUpstreamError(upstreamDiagnostic('MJ', '图片提交失败', raw, c.apiKey, 200), false, false, false, 200, true);
    }
    if (status === 'completed' || !status && Array.isArray(raw?.data) && raw.data.length) return mjImageResult(raw, taskId);
    const handle = typeof raw?.id === 'string' ? raw.id.trim() : '';
    if (!handle || status && !mjPendingStatuses.includes(status)) throw new SpecificationUpstreamError('MJ 未返回有效查询句柄，请核实原请求', false, true);
    const state: MjAsyncImageState = { handle, status: status || 'queued', submittedAt, deadlineAt: submittedAt + MJ_ASYNC_TIMEOUT_MS };
    onMjAsyncState(state); // Persist before the very first GET or any waiting.
    return pollMjSpecificationImage(c, state, onSubmitted, onResponse, onMjAsyncState, checkMjReservation);
  }
  const options = { baseUrl: c.baseUrl, apiKey: c.apiKey, prompt: request.prompt, aspectRatio: i.ratio, resolution: i.resolution,
    referenceImages: request.images.map(s => publishSpecificationAsset(s, request.publicBaseUrl)), quality: i.quality,
    fetchImpl: trackedFetch, onSubmitted };
  if (isMingFeiImageChannel(c) || isSiYueTianImageChannel(c, target.route.executionModel)) {
    if (isMingFeiImageChannel(c) && request.images.length > 16) throw new SpecificationUpstreamError('MingFei 线路最多支持 16 张参考图', true);
    try { return await (isMingFeiImageChannel(c) ? generateMingFeiImage(options) : generateSiYueTianImage({ ...options, model: target.route.executionModel as any, maxAttempts: 1 })); }
    catch (e: any) { if (e instanceof SpecificationUpstreamError || !started) throw e; throw new SpecificationUpstreamError(e.message, false, true); }
  }
  if (c.type === 'hmstudio') {
    if (request.images.length > 10) throw new SpecificationUpstreamError('HM 图片线路最多支持 10 张参考图', true);
    const form = buildHmStudioImageForm({ model, prompt: request.prompt, ratio: i.ratio, resolution: i.resolution.toLowerCase(), imageSources: options.referenceImages, localMediaBaseUrl: request.publicBaseUrl });
    const task = await post(hmStudioCreateUrl(c.baseUrl, 'image'), c, form, onStarting);
    const id = String(task.task_id || task.id || task.data?.task_id || task.data?.id || '');
    if (!id) throw new SpecificationUpstreamError('上游未返回图片任务 ID', false, true);
    onSubmitted(id);
    const deadline = Date.now() + 20 * 60_000;
    while (Date.now() < deadline) {
      const response = await trackedFetch(hmStudioTaskUrl(c.baseUrl, id), { headers: { Authorization: 'Bearer ' + c.apiKey } });
      if (!response.ok) throw new SpecificationUpstreamError(await responseDiagnostic('HM Studio', '图片任务查询', response, c.apiKey), false, true);
      const raw = await diagnosticJson('HM Studio', '图片查询 task_id=' + id, response, c.apiKey), result = normalizeHmStudioTask(raw, c.baseUrl);
      if (['failed','error','cancelled'].includes(result.status)) throw new SpecificationUpstreamError(result.error || '图片生成失败', false, false, false, 0, true);
      if (['completed','success','succeeded','done'].includes(result.status) && result.resultUrl) return { imageUrl: result.resultUrl, reportedImageUrl: result.resultUrl, taskId: id, raw };
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    throw new SpecificationUpstreamError('图片任务仍在处理中', false, true);
  }
  const base = apiBase(c.baseUrl);
  if (/gemini|banana/.test(target.route.executionModel) && !request.images.length) {
    const response = await trackedFetch(base + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + c.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: request.prompt }], stream: true, image_config: { n: 1, size: request.body.size || imageSize(i.ratio), response_format: 'url' } }) });
    let content = '';
    try {
      const text = await response.text();
      if (/event-stream/.test(response.headers.get('content-type') || '')) {
        for (const line of text.split('\n')) {
          if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
          const part = JSON.parse(line.slice(5));
          if (part.error) throw new Error(upstreamDiagnostic(c.type || 'OpenAI-compatible', '图片流事件', part, c.apiKey, response.status));
          const message = part.choices?.[0]?.delta || part.choices?.[0]?.message;
          if (typeof message?.content === 'string') content += message.content;
        }
      } else {
        const json = JSON.parse(text);
        if (json.error) throw new Error(upstreamDiagnostic(c.type || 'OpenAI-compatible', '图片响应', json, c.apiKey, response.status));
        content = json.data?.[0]?.url || json.choices?.[0]?.message?.content || '';
      }
      const source = content.match(/!\[[^\]]*\]\(([^)]+)\)/)?.[1] || content.match(/(?:https?:\/\/|data:image\/)[^\s"'<>]+/)?.[0] || content.match(/\/v1\/files\/image[^\s"'<>]*/)?.[0];
      if (!source) throw new Error('未返回图片');
      const imageUrl = source.startsWith('/') ? base + source : source;
      return { imageUrl, reportedImageUrl: imageUrl, taskId: '', raw: {} };
    } catch (error: any) { throw new SpecificationUpstreamError(transportDiagnostic(c.type || 'OpenAI-compatible', '流式图片结果待核实，请勿重复提交', error, c.apiKey), false, true); }
  }
  let payload: any = { model, prompt: request.prompt, n: 1, size: request.body.size || imageSize(i.ratio), response_format: 'url' };
  if (target.route.executionModel === 'gpt-image-2') {
    if (!['1k', '4k'].includes(i.resolution.toLowerCase())) throw new SpecificationUpstreamError('Pidoi 原生图片线路仅支持 1K / 4K', true);
    payload.quality = i.resolution.toLowerCase() === '1k' ? 'low' : 'high';
    if (i.quality && i.quality !== payload.quality) throw new SpecificationUpstreamError('质量档位与输出分辨率不匹配', true);
  }
  for (const key of ['quality', 'output_format', 'background', 'output_compression']) if (request.body[key] !== undefined) payload[key] = request.body[key];
  if (isPidoiImageChannel(c)) {
    try {
      return await generatePidoiImage(c, { ...payload, images: options.referenceImages,
        resolution: i.resolution, aspect_ratio: i.ratio }, onSubmitted, trackedFetch, { referenceImages: request.images,
          onFallback: onPidoiFallback,
          onResponse: (response, payload) => onResponse?.(imageResponseEvidence(payload, response.headers, response.status, 'response_without_id')) });
    } catch (e: any) {
      if (e.imageRequestStage) logImageRequestFailure({ stage: e.imageRequestStage, channelId: c.id, taskId: e.upstreamTaskId }, e);
      throw new SpecificationUpstreamError(e.message, false, !e.confirmedFailure, false, Number(e.status) || 0, e instanceof PidoiImageError && e.confirmedFailure);
    }
  }
  let url = base + '/v1/images/generations';
  if (request.images.length) {
    const form = new FormData();
    for (const [key, value] of Object.entries(payload)) form.append(key, String(value));
    for (let index = 0; index < request.images.length; index++) {
      const source = request.images[index], match = source.match(/^data:([^;]+);base64,(.+)$/s);
      if (!match) throw new Error('参考图必须先完成本站图片校验');
      form.append('image[]', new Blob([Buffer.from(match[2], 'base64')], { type: match[1] }), 'ref_' + index + '.jpg');
    }
    payload = form; url = base + '/v1/images/edits';
  }
  let taskId = '';
  const result = await post(url, c, payload, onStarting, (body, headers) => {
    taskId = extractImageUpstreamTaskId(body, headers);
    if (taskId) onSubmitted(taskId);
  }, onResponse);
  const item = result.data?.[0], imageUrl = item?.url || (item?.b64_json ? 'data:image/png;base64,' + item.b64_json : '');
  if (!imageUrl) throw new SpecificationUpstreamError('上游已受理但未返回图片，请核实原请求', false, true);
  return { imageUrl, reportedImageUrl: imageUrl, taskId, raw: result };
}
export function imageSize(ratio: string) {
  const sizes: Record<string, string> = { '1:1': '1024x1024', '16:9': '1536x864', '9:16': '864x1536', '4:3': '1536x1152', '3:4': '1152x1536', '3:2': '1536x1024', '2:3': '1024x1536' };
  return sizes[ratio] || '1024x1024';
}


/** Resume a previously accepted image job; this function never submits a POST. */
export async function pollSpecificationImage(channel: any, taskId: string) {
  if (isPidoiImageChannel(channel)) return pollPidoiImage(channel, taskId);
  if (isFunAiChannel(channel)) {
    const task = await pollFunAiTask(channel, taskId, fetch, 'image');
    return { status: task.status === 'cancelled' ? 'failed' : task.status, imageUrl: task.resultUrl, error: task.error };
  }
  const base = apiBase(channel.baseUrl), hm = channel.type === 'hmstudio', mf = isMingFeiImageChannel(channel), sy = isSiYueTianImageChannel(channel);
  if (!hm && !mf && !sy) throw new Error('此线路没有异步图片查询协议');
  const url = hm ? hmStudioTaskUrl(channel.baseUrl, taskId) : mf ? base + '/v1/videos/' + encodeURIComponent(taskId) : base + '/v1/images/generations/' + encodeURIComponent(taskId);
  const response = await fetch(url, { headers: { Authorization: 'Bearer ' + channel.apiKey }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!response.ok) throw new Error(await responseDiagnostic(channel.type || 'custom', '图片查询 task_id=' + taskId, response, channel.apiKey));
  const task = await diagnosticJson(channel.type || (mf ? 'MingFei' : sy ? '四月天' : 'HM Studio'), '图片查询 task_id=' + taskId, response, channel.apiKey);
  if (hm) { const result = normalizeHmStudioTask(task, channel.baseUrl); return { status: ['success','succeeded','done'].includes(result.status) ? 'completed' : result.status, imageUrl: result.resultUrl, error: result.error }; }
  const status = String(task.status || '').toLowerCase();
  return { status: status === 'succeeded' ? 'completed' : status, imageUrl: ['completed','succeeded'].includes(status) ? (mf ? mingFeiImageContentUrl(channel.baseUrl, taskId) : siYueTianImageContentUrl(taskId)) : '', error: ['failed', 'error', 'cancelled'].includes(status) ? upstreamDiagnostic(mf ? 'MingFei' : '四月天', '图片任务失败 task_id=' + taskId, task, channel.apiKey, response.status) : '' };
}
import { isPidoiImageChannel, generatePidoiImage, pollPidoiImage, PidoiImageError } from './pidoiImageAdapter.js';
import { logImageRequestFailure } from './imageRequestDiagnostics.js';
import { responseDiagnostic, upstreamDiagnostic, transportDiagnostic, diagnosticJson } from './upstreamDiagnostic.js';
