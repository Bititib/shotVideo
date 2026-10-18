import { modelAvailabilityMessage } from '../../shared/upstreamAvailability.js';
import { startSseHeartbeat } from './sseHeartbeat.js';
import { publicGenerationError, publicGenerationEvent } from '../../shared/generationMessages.js';
import { isBlobDrawChannel } from './blobDrawAdapter.js';
import { isFunAiChannel } from './funAiAdapter.js';
import { createVideoAliasChecker } from './modelSaleService.js';
import { assertExpectedVideoCost } from './videoQuoteService.js';
import { assertUserModelAccess } from './userModelAccessService.js';
import type { PricingSnapshot } from './pricingService.js';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { eq, inArray } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { contents, models, apiLogs } from '../db/schema.js';
import { ContentService } from './contentService.js';
import { ChannelService } from './channelService.js';
import { PricingService } from './pricingService.js';
import { BalanceService } from './balanceService.js';
import { TokenService } from './tokenService.js';
import { reserveUserCharge } from './billingReservation.js';
import { getModelSpecification, specificationAvailability, selectModelRoutes, routeStillEnabled, claimRouteProbe, noteRouteResult, type RouteCandidate } from './modelRoutingService.js';
import { submitSpecificationVideo, pollSpecificationVideo, pollSpecificationImage, generateSpecificationImage, SpecificationUpstreamError, type SpecificationRequest } from './specificationAdapters.js';
import { validateAndNormalizeImageReferences } from './imageReferenceValidationService.js';
import { hmStudioQueue, hmStudioPoolKey, HmStudioQueueFullError } from './hmStudioQueueService.js';
import { recordCanvasEvent } from '../middleware/canvasRequest.js';
import { logUsage } from '../middleware/quota.js';
import { routingMismatches, type MediaKind } from '../../shared/modelRouting.js';
import { issueUploadUrl, mediaOwnerContext } from './uploadAccess.js';
import { isMjChannel, mjBaseUrl } from './mjAdapter.js';
import { MJ_MODEL_ID } from '../../shared/mj.js';
import { saveMjImageBatch, type MjImageBatch } from './mjImageResults.js';
import { resolvePublicModelId } from './publicModelNameService.js';
import { batchContextForRequest, batchStore, markBatchSubmitting, recordBatchFailure } from './videoBatchService.js';

const active = new Set<number>();
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
function list(body: any, keys: string[]): string[] {
  const supplied = keys.filter(k => body[k] !== undefined && body[k] !== '' && (!Array.isArray(body[k]) || body[k].length));
  if (!supplied.length) return [];
  if (supplied.length > 1) throw fail('请只使用一个素材字段：' + supplied.join(' / '));
  let value = body[supplied[0]];
  if (typeof value === 'string' && value.trim().startsWith('[')) { try { value = JSON.parse(value); } catch { throw fail('素材数组格式无效'); } }
  if (typeof value === 'string') value = [value];
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.trim())) throw fail('素材必须为有效 URL 或 Base64 数组');
  return value;
}
export function specificationRequest(body: any, kind: MediaKind, publicBaseUrl: string): SpecificationRequest {
  if (body.resolution && body.output_resolution && String(body.resolution).toLowerCase() !== String(body.output_resolution).toLowerCase()) throw fail('resolution 与 output_resolution 不一致');
  if (body.mask !== undefined) throw fail('当前统一规格未配置蒙版编辑，请使用支持蒙版的独立入口');
  if (body.response_format && !['url', 'b64_json'].includes(body.response_format)) throw fail('response_format 仅支持 url 或 b64_json');
  const images = list(body, ['reference_images', 'image_urls', 'image_url', 'images']);
  const videos = list(body, ['reference_videos', 'reference_video', 'video_urls', 'video_url']);
  const audios = list(body, ['audio_urls', 'audio_url', 'reference_audios', 'audios']);
  const firstFrame = body.first_frame || body.first_frame_url || '';
  const lastFrame = body.last_frame || body.last_frame_url || body.end_frame_url || '';
  const outputs = Number(body.n ?? 1), seconds = Number(body.video_length ?? body.seconds ?? body.duration ?? 6);
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw fail('请输入描述');
  if (kind === 'image' && body.prompt.length > 10000) throw fail('图片描述必须是 1–10000 字符的文本');
  if (!Number.isInteger(outputs) || outputs < 1 || outputs > 4) throw fail('输出数量必须为 1–4');
  if (kind === 'video' && (!Number.isFinite(seconds) || seconds <= 0 || outputs !== 1)) throw fail('视频时长或输出数量无效');
  if (typeof firstFrame !== 'string' || typeof lastFrame !== 'string') throw fail('首尾帧必须是图片 URL 或 Base64');
  if (kind === 'image' && (videos.length || audios.length || firstFrame || lastFrame)) throw fail('图片生成不能传入视频、音频或独立首尾帧');
  const sizeRatios: Record<string,string> = { '1024x1024': '1:1', '1536x864': '16:9', '864x1536': '9:16', '1536x1152': '4:3', '1152x1536': '3:4', '1536x1024': '3:2', '1024x1536': '2:3', '1280x720': '16:9', '720x1280': '9:16', '1024x768': '4:3', '768x1024': '3:4' };
  if (kind === 'image' && body.size && !sizeRatios[body.size]) throw fail('此规格不支持该 size，请使用 aspect_ratio 和 resolution');
  if (kind === 'image' && body.size && (body.aspect_ratio || body.ratio) && sizeRatios[body.size] !== (body.aspect_ratio || body.ratio)) throw fail('size 与宽高比不一致');
  const ratio = String(body.aspect_ratio || body.ratio || (sizeRatios[body.size] ? sizeRatios[body.size] : kind === 'image' ? '1:1' : '16:9'));
  return { prompt: body.prompt.trim(), images, videos, audios, firstFrame, lastFrame, body, publicBaseUrl,
    input: { images: images.length, videos: videos.length, audios: audios.length, outputs, seconds,
      resolution: String(body.output_resolution || body.resolution || (kind === 'image' ? '2K' : '720p')), ratio,
      firstFrame: Boolean(firstFrame), lastFrame: Boolean(lastFrame), quality: body.quality } };
}
function patch(id: number, values: Record<string, any>, status?: string) {
  const row = db.select().from(contents).where(eq(contents.id, id)).get();
  if (!row) return;
  db.update(contents).set({ metadata: JSON.stringify({ ...JSON.parse(row.metadata || '{}'), ...values }), ...(status ? { status } : {}) }).where(eq(contents.id, id)).run();
}
function metadata(id: number) {
  const row = db.select().from(contents).where(eq(contents.id, id)).get();
  return row ? JSON.parse(row.metadata || '{}') : {};
}
/** Idempotent finalization, including accepted tasks resumed after a process restart. */
function finalizeReservation(id: string | undefined, actual: number): number {
  if (!id) return actual;
  return sqlite.transaction(() => {
    const row = sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(id) as any;
    if (!row) return 0;
    if (!['reserved', 'review'].includes(row.state)) return Number(row.actual) || 0;
    if (actual < 0 || actual > row.amount) throw new Error('结算金额无效');
    const refund = Math.max(0, Math.round((row.amount - actual) * 1e6) / 1e6);
    const receipt = JSON.parse(row.receipt), context = JSON.parse(row.context);
    if (refund > 0) {
      if (context.tokenId) {
        if (context.unlimitedToken && context.userId) {
          BalanceService.refundToSource(context.userId, refund, receipt.balanceDeduction?.source || 'user', receipt.balanceDeduction?.orgId, 'specification_refund');
        }
        TokenService.refundBalance(context.tokenId, refund);
      } else {
        BalanceService.refundToSource(context.userId, refund, receipt.source, receipt.orgId, 'specification_refund');
      }
    }
    sqlite.prepare("UPDATE billing_reservations SET actual=?,state=?,settled_at=datetime('now') WHERE id=?").run(actual, actual ? 'settled' : 'refunded', id);
    return actual;
  })();
}
function holdForReview(id: number, message: string) {
  const meta = metadata(id);
  if (meta.billingReservationId) sqlite.prepare("UPDATE billing_reservations SET state='review' WHERE id=? AND state='reserved'").run(meta.billingReservationId);
  patch(id, { requiresReview: true, progressText: message, error: message, billingStatus: 'review' });
  if (meta.batchItemId) recordBatchFailure(id, message, false);
}
function complete(id: number, urls: string[]) {
  const meta = metadata(id), record = db.select().from(contents).where(eq(contents.id, id)).get()!;
  let actual = meta.batchItemId ? record.cost : Math.round((meta.reservedCost || 0) * urls.length / (meta.count || 1) * 1e6) / 1e6;
  actual = finalizeReservation(meta.billingReservationId, actual);
  patch(id, { imageUrls: record.type === 'image' ? urls : undefined, progress: 100, progresses: urls.map(() => 100),
    completedAt: new Date().toISOString(), billingStatus: 'settled', requiresReview: false, progressText: '生成完成' }, 'completed');
  db.update(contents).set({ resultUrl: urls[0], cost: actual }).where(eq(contents.id, id)).run();
  if (record.userId) { try { logUsage(record.userId, record.type === 'video' ? 'video' : 'generate_image', undefined, Date.now() - meta.startedAt); } catch (error: any) { console.warn('[specification] usage log failed', id, error.message); } }
}
function failTask(id: number, message: string) {
  const meta = metadata(id);
  if (meta.batchItemId && recordBatchFailure(id, message, true)) return;
  finalizeReservation(meta.billingReservationId, 0);
  patch(id, { error: message, failureReason: message, billingStatus: 'refunded', refundAmount: meta.reservedCost || 0,
    progressText: message, failedAt: new Date().toISOString() }, 'failed');
  db.update(contents).set({ cost: 0 }).where(eq(contents.id, id)).run();
}
async function pollVideo(id: number, channel: any, taskId: string, onEvent: (data: any) => void) {
  const end = Date.now() + 2 * 60 * 60_000;
  while (Date.now() < end) {
    let task: any;
    try { task = await pollSpecificationVideo(channel, taskId); }
    catch { await wait(12_000); continue; }
    patch(id, { progress: task.progress, upstreamStatus: task.status, progressText: '视频生成中' });
    onEvent({ type: 'progress', progress: task.progress, contentId: id });
    if (['failed', 'error', 'cancelled', 'canceled', 'failure'].includes(task.status)) {
      const meta = metadata(id);
      if (!/content|policy|审核|敏感|违规/i.test(task.error || '')) noteRouteResult(meta.routingHealthKey, false, task.error || '上游生成失败', false, true);
      failTask(id, task.error || '上游生成失败'); onEvent({ type: 'error', message: task.error || '上游生成失败' }); return;
    }
    if (['completed', 'success', 'succeeded', 'done'].includes(task.status) && task.resultUrl) {
      try {
        patch(id, { upstreamResultUrl: task.resultUrl });
        const { downloadAndLocalizeVideo } = await import('./videoLocalizationService.js');
        const url = await downloadAndLocalizeVideo(task.resultUrl, taskId, metadata(id).actualModel, channel.id, channel.apiKeyId);
        complete(id, [url]); noteRouteResult(metadata(id).routingHealthKey, true);
        onEvent({ type: 'complete', videoUrl: url, contentId: id }); return;
      } catch (error: any) { console.warn('[specification] result save failed', id, error.message); patch(id, { progressText: '上游已完成，正在保存结果' }); }
    }
    await wait(isFunAiChannel(channel) ? 5_000 : isBlobDrawChannel(channel) ? 10_000 : 8_000);
  }
  holdForReview(id, '任务仍待核实，保留原线路和费用，请勿重复提交');
  onEvent({ type: 'error', message: '任务仍待核实，请在历史记录查看' });
}
async function runVideo(id: number, candidates: RouteCandidate[], request: SpecificationRequest, onEvent: (data: any) => void) {
  for (const target of candidates) {
    // Re-read manual switches immediately before submission, including queued jobs.
    const stillEnabled = () => routeStillEnabled(metadata(id).requestedModel, target, request.input);
    if (!stillEnabled() || !claimRouteProbe(target.healthKey)) continue;
    const attempt = async () => {
      if (!stillEnabled()) throw new SpecificationUpstreamError('线路已手动禁用', true);
      patch(id, { routingRouteId: target.route.id, routingHealthKey: target.healthKey, channelId: target.channel.id,
        channelApiKeyId: target.channel.apiKeyId, upstreamModel: target.route.upstreamModel, actualModel: target.route.executionModel,
        actualChannel: target.channel.type, progressText: '正在提交生成任务' }, 'processing');
      let taskId = '';
      try {
        if (!markBatchSubmitting(id)) throw fail('任务已停止', 409);
        taskId = await submitSpecificationVideo(target, request, submissionMetadata => patch(id, { ...submissionMetadata, submissionStartedAt: new Date().toISOString() }));
        patch(id, { videoId: taskId, upstreamTaskId: taskId, progressText: '视频生成中', requiresReview: false });
        await pollVideo(id, target.channel, taskId, onEvent);
      } catch (e: any) {
        if (taskId || e instanceof SpecificationUpstreamError && e.uncertain) {
          noteRouteResult(target.healthKey, false, e.message); holdForReview(id, e.message); onEvent({ type: 'error', message: '提交结果待核实，请勿重复提交' }); return;
        }
        throw e;
      }
    };
    try {
      if (target.channel.type === 'hmstudio') {
        await hmStudioQueue.enqueue({ id: 'spec-' + id, userKey: metadata(id).queueUserKey, poolKey: hmStudioPoolKey(target.channel), task: attempt,
          onUpdate: snapshot => { patch(id, { progressText: '等待生成资源', queuePosition: snapshot.position }, snapshot.status === 'queued' ? 'queued' : 'processing'); onEvent({ type: 'queue', ...snapshot }); } }).completion;
      } else await attempt();
      return;
    } catch (e: any) {
      if (e instanceof HmStudioQueueFullError) e = new SpecificationUpstreamError(e.message, true);
      if (e instanceof SpecificationUpstreamError) noteRouteResult(target.healthKey, false, e.message, e.blocked);
      if (e instanceof SpecificationUpstreamError && e.retrySafe) {
        const attempts = metadata(id).routingAttempts || [];
        patch(id, { routingAttempts: [...attempts, { routeId: target.route.id, reason: e.message, at: new Date().toISOString() }], submissionStartedAt: null, batchSubmissionStarted: null });
        onEvent({ type: 'status', message: '当前线路暂不可用，正在切换备用线路' }); continue;
      }
      failTask(id, e.message || '生成失败'); onEvent({ type: 'error', message: e.message || '生成失败' }); return;
    }
  }
  failTask(id, '没有可用且满足参数的线路'); onEvent({ type: 'error', message: '没有可用且满足参数的线路' });
}
async function runImages(id: number, candidates: RouteCandidate[], request: SpecificationRequest, req: Request, onEvent: (data: any) => void) {
  if (metadata(id).nativeImageOutputs === 4) return runMjImages(id, candidates, request, req, onEvent);
  const urls: string[] = [], taskIds: string[] = [], jobs: any[] = [];
  for (let index = 0; index < request.input.outputs; index++) {
    let done = false, uncertain = false;
    for (const target of candidates) {
      if (!routeStillEnabled(metadata(id).requestedModel, target, request.input) || !claimRouteProbe(target.healthKey)) continue;
      let accepted = false;
      try {
        patch(id, { routingRouteId: target.route.id, routingHealthKey: target.healthKey, channelId: target.channel.id, channelApiKeyId: target.channel.apiKeyId, upstreamModel: target.route.upstreamModel, actualModel: target.route.executionModel, actualChannel: target.channel.type });
        const invoke = () => {
          if (!routeStillEnabled(metadata(id).requestedModel, target, request.input)) throw new SpecificationUpstreamError('线路已手动禁用或修改', true);
          return generateSpecificationImage(target, request, () => patch(id, { submissionStartedAt: new Date().toISOString(), imageSubmissionIndex: index }),
            taskId => { accepted = true; taskIds.push(taskId); jobs.push({ index, taskId, channelId: target.channel.id, apiKeyId: target.channel.apiKeyId, healthKey: target.healthKey, status: 'pending' }); patch(id, { upstreamTaskIds: taskIds, upstreamTaskId: taskId, imageJobs: jobs }); },
            evidence => {
              const meta = metadata(id), responses = [...(meta.upstreamResponses || [])];
              responses[index] = evidence;
              patch(id, { upstreamResponses: responses,
                ...(evidence.id ? { upstreamTaskId: evidence.id, upstreamTaskIds: [...new Set([...(meta.upstreamTaskIds || []), evidence.id])] } : {}) });
            });
        };
        const result = target.channel.type === 'hmstudio' ? await hmStudioQueue.enqueue({ id: 'spec-image-' + id + '-' + index + '-' + target.route.id,
          userKey: metadata(id).queueUserKey, poolKey: hmStudioPoolKey(target.channel), task: invoke,
          onUpdate: snapshot => { patch(id, { progressText: '等待图片生成资源', queuePosition: snapshot.position }, snapshot.status === 'queued' ? 'queued' : 'processing'); onEvent({ type: 'queue', ...snapshot }); } }).completion : await invoke();
        accepted = true;
        const job = jobs.find(j => j.index === index) || { index, channelId: target.channel.id, apiKeyId: target.channel.apiKeyId, healthKey: target.healthKey, status: 'saving' };
        if (!jobs.includes(job)) jobs.push(job); job.sourceUrl = result.imageUrl;
        patch(id, { imageJobs: jobs, upstreamImageUrls: [...(metadata(id).upstreamImageUrls || []), result.reportedImageUrl] });
        const { localizeGeneratedImage } = await import('../routes/imageGen.js');
        const url = await localizeGeneratedImage(result.imageUrl, 'spec_image_' + id + '_' + index, req, target.channel, { relative: true });
        urls.push(url); job.status = 'completed'; job.localUrl = url; patch(id, { imageJobs: jobs, imageUrls: urls, upstreamTaskIds: taskIds, submissionStartedAt: null });
        noteRouteResult(target.healthKey, true);
        onEvent({ type: 'image_ready', imageUrl: url, index, total: request.input.outputs, contentId: id }); done = true; break;
      } catch (e: any) {
        if (e instanceof HmStudioQueueFullError) e = new SpecificationUpstreamError(e.message, true);
        if ((accepted && !(e instanceof SpecificationUpstreamError && e.confirmedFailure)) || e instanceof SpecificationUpstreamError && e.uncertain) { noteRouteResult(target.healthKey, false, e.message); holdForReview(id, '图片提交或结果待核实，请勿重复提交：' + e.message); uncertain = true; break; }
        if (e instanceof SpecificationUpstreamError) noteRouteResult(target.healthKey, false, e.message, e.blocked);
        const job = jobs.find(j => j.index === index); if (job) job.status = 'failed'; patch(id, { imageJobs: jobs, submissionStartedAt: null, failureReason: e.message || '图片生成失败' });
        if (!(e instanceof SpecificationUpstreamError && e.retrySafe)) { onEvent({ type: 'image_error', index, message: e.message }); break; }
        const attempts = metadata(id).routingAttempts || [];
        patch(id, { routingAttempts: [...attempts, { routeId: target.route.id, index, reason: e.message }], submissionStartedAt: null });
      }
    }
    if (uncertain) { onEvent({ type: 'error', message: '部分图片任务待核实，已生成的图片保留，请勿重提' }); return; }
    if (!done) onEvent({ type: 'image_error', index, message: '当前图片没有可用线路或生成失败' });
  }
  if (urls.length) { complete(id, urls); onEvent({ type: 'complete', imageUrls: urls, contentId: id }); }
  else { const reason = metadata(id).failureReason || '图片生成失败'; failTask(id, reason); onEvent({ type: 'error', message: reason }); }
}
async function saveMjResults(id: number, channel: any, req: Request, onEvent: (data: any) => void) {
  const batch = metadata(id).nativeImageBatch as MjImageBatch;
  const persist = () => patch(id, { nativeImageBatch: batch, imageJobs: batch.jobs,
    imageUrls: batch.jobs.map(job => job.localUrl).filter(Boolean) });
  const urls = await saveMjImageBatch(batch, id, req, channel, persist,
    (imageUrl, index) => onEvent({ type: 'image_ready', imageUrl, index, total: 4, contentId: id }));
  if (urls.length !== 4) throw new Error('MJ 返回的图片不足 4 张，需要核实原任务');
  patch(id, { submissionStartedAt: null });
  complete(id, urls);
  onEvent({ type: 'complete', imageUrls: urls, contentId: id });
}

/** Admin recovery of a verified original MJ result; never creates a task or a new charge. */
export async function recoverMjSpecificationImages(id: number, resultUrls: unknown, actorId: number, req: Request) {
  if (!Number.isSafeInteger(id) || id <= 0) throw fail('记录 ID 无效');
  const record = db.select().from(contents).where(eq(contents.id, id)).get();
  if (!record) throw fail('任务记录不存在', 404);
  const meta = metadata(id);
  if (record.type !== 'image' || meta.nativeImageOutputs !== 4 || meta.count !== 4) throw fail('仅支持原生四张 MJ 任务');
  if (record.status === 'completed' && record.resultUrl) return { status: 'completed', alreadyRecovered: true, message: '原任务已经恢复，未重复扣费' };
  if (active.has(id) || !meta.requiresReview || !['queued', 'processing', 'review'].includes(record.status)) throw fail('原任务不处于待核实状态', 409);
  const channel = ChannelService.getChannelRaw(meta.channelId, meta.channelApiKeyId);
  if (!channel || !isMjChannel(channel)) throw fail('原 MJ 渠道不存在', 409);
  if (!Array.isArray(resultUrls) || ![1, 4].includes(resultUrls.length)) throw fail('请填写一张四宫格或四张原任务图片的下载地址');
  const origin = new URL(mjBaseUrl(channel.baseUrl)).origin;
  const sources = resultUrls.map(source => {
    let url: URL; try { url = new URL(source); } catch { throw fail('图片下载地址无效'); }
    if (typeof source !== 'string' || source.length > 2048 || url.protocol !== 'https:' || url.origin !== origin
      || url.username || url.password || url.search || url.hash || !/^\/v1\/public\/image\/[\w-]+$/.test(url.pathname)) {
      throw fail('请从原渠道日志复制该任务的公开图片下载地址');
    }
    return url.href;
  });
  if (new Set(sources).size !== sources.length) throw fail('图片下载地址不能重复');
  const checkReservation = () => {
    const reservation = sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(meta.billingReservationId) as any;
    if (!reservation || !['reserved', 'review'].includes(reservation.state) || !Number.isFinite(reservation.amount)
      || reservation.amount !== meta.reservedCost) throw fail('原预扣费用已变更，请人工核对；本次未扣费', 409);
    const context = JSON.parse(reservation.context);
    if (context.contentId && context.contentId !== id || context.userId !== record.userId
      && !(meta.tokenId && context.tokenId === meta.tokenId)) throw fail('原预扣记录不匹配', 409);
  };
  checkReservation();
  const batch = meta.nativeImageBatch as MjImageBatch | undefined;
  if (batch && JSON.stringify(batch.sourceUrls) !== JSON.stringify(sources)) throw fail('已记录原结果地址，请使用相同地址继续恢复', 409);
  active.add(id);
  try {
    patch(id, { nativeImageBatch: batch || { sourceUrls: sources, jobs: [] }, upstreamImageUrls: sources,
      mjRecovery: { actorId, startedAt: new Date().toISOString(), previousError: meta.error || null } });
    // Downloads may fail; settle only after all four local images are available.
    const currentBatch = metadata(id).nativeImageBatch as MjImageBatch;
    await mediaOwnerContext.run(record.userId, () => saveMjImageBatch(currentBatch, id, req, channel, () => {
      patch(id, { nativeImageBatch: currentBatch, imageJobs: currentBatch.jobs });
    }, () => {}));
    const urls = currentBatch.jobs.map(job => job.localUrl).filter((url): url is string => Boolean(url));
    if (urls.length !== 4 || urls.some(url => !url.startsWith('/api/uploads/'))) throw fail('原任务四张图片尚未完整保存，请使用相同地址重试', 502);
    sqlite.transaction(() => {
      checkReservation();
      complete(id, urls);
      patch(id, { error: null, failureReason: null, submissionStartedAt: null,
        mjRecovery: { ...metadata(id).mjRecovery, completedAt: new Date().toISOString() } });
    })();
    return { status: 'completed', message: '原任务四张图片已恢复，使用原预扣费用结算，未重复扣费' };
  } finally { active.delete(id); }
}

async function runMjImages(id: number, candidates: RouteCandidate[], request: SpecificationRequest, req: Request, onEvent: (data: any) => void) {
  let failureReason = 'MJ 图片生成失败';
  for (const target of candidates) {
    if (!isMjChannel(target.channel) || !routeStillEnabled(metadata(id).requestedModel, target, request.input) || !claimRouteProbe(target.healthKey)) continue;
    let accepted = false;
    try {
      patch(id, { routingRouteId: target.route.id, routingHealthKey: target.healthKey, channelId: target.channel.id,
        channelApiKeyId: target.channel.apiKeyId, upstreamModel: target.route.upstreamModel, actualModel: target.route.executionModel,
        actualChannel: target.channel.type });
      const result = await generateSpecificationImage(target, request,
        () => patch(id, { submissionStartedAt: new Date().toISOString() }),
        upstreamTaskId => { accepted = true; patch(id, { upstreamTaskId }); });
      accepted = true;
      const sourceUrls = 'imageUrls' in result && Array.isArray(result.imageUrls) ? result.imageUrls : [result.imageUrl];
      patch(id, { nativeImageBatch: { sourceUrls, jobs: [] }, upstreamImageUrls: sourceUrls });
      await saveMjResults(id, target.channel, req, onEvent);
      noteRouteResult(target.healthKey, true); return;
    } catch (error: any) {
      if (accepted || error instanceof SpecificationUpstreamError && error.uncertain) {
        holdForReview(id, error.message || 'MJ 原任务结果待核实，请勿重复提交');
        onEvent({ type: 'error', message: 'MJ 原任务结果待核实，已保存图片保留，请勿重复提交' }); return;
      }
      failureReason = error.message || 'MJ 图片生成失败';
      patch(id, { routingAttempts: [...(metadata(id).routingAttempts || []), {
        routeId: target.route.id, reason: failureReason, at: new Date().toISOString(),
        ...(error instanceof SpecificationUpstreamError ? { upstreamStatus: error.upstreamStatus } : {}),
      }], submissionStartedAt: null });
      if (error instanceof SpecificationUpstreamError) noteRouteResult(target.healthKey, false, error.message, error.blocked);
      if (!(error instanceof SpecificationUpstreamError && error.retrySafe)) break;
    }
  }
  failTask(id, failureReason); onEvent({ type: 'error', message: failureReason });
}
type ApiContext = { token: any; reserve: (amount: number, model: string, pricingSnapshot?: PricingSnapshot) => any };
export async function handleSpecificationGeneration(req: Request, res: Response, kind: MediaKind, apiContext?: ApiContext): Promise<boolean> {
  let suppliedId: string;
  try { suppliedId = typeof req.body?.model === 'string' ? resolvePublicModelId(req.body.model, req.body) : ''; }
  catch (error: any) { res.status(error.status || 400).json({ error:error.message }); return true; }
  const spec = getModelSpecification(suppliedId);
  const modelId = spec?.modelId || suppliedId;
  if (!spec) return false;
  let id: number | undefined;
  let stopHeartbeat = () => {};
  try {
    if (spec.kind !== kind) throw fail('模型类型与接口不匹配');
    const model = db.select().from(models).where(eq(models.modelId, modelId)).get();
    if (!spec.enabled || !model?.isActive) throw fail('该模型规格已禁用', 403);
    const token = apiContext?.token, checkAlias = createVideoAliasChecker();
    const userId = token?.userId ?? (req as any).userId ?? 0;
    assertUserModelAccess(userId, modelId);
    if (token?.allowedModels?.length && !token.allowedModels.includes(modelId) && !spec.aliases.some(alias => token.allowedModels.includes(alias) && !checkAlias(spec, alias))) throw fail('Token 无权调用此模型', 403);
    const body = { ...req.body, aspect_ratio: req.body.aspect_ratio || req.body.ratio || (spec.limits.ratios.includes(kind === 'image' ? '1:1' : '16:9') ? (kind === 'image' ? '1:1' : '16:9') : spec.limits.ratios[0]) };
    const files = Array.isArray(req.files) ? req.files : [];
    const fields: Record<string, string[]> = { reference_images: ['image', 'image[]', 'images', 'input_reference[]', 'reference_images'], reference_videos: ['video', 'video[]', 'videos', 'reference_video', 'reference_videos'], audio_urls: ['audio', 'audio[]', 'audios', 'audio_urls'], first_frame: ['first_frame', 'first_frame_url'], last_frame: ['last_frame', 'last_frame_url'] };
    for (const file of files) {
      const field = Object.keys(fields).find(key => fields[key].includes(file.fieldname));
      if (!field) throw fail('不支持的上传字段：' + file.fieldname);
      const expected = field === 'reference_videos' ? 'video/' : field === 'audio_urls' ? 'audio/' : 'image/';
      if (!file.mimetype.startsWith(expected)) throw fail('上传素材类型与字段不一致');
      const data = 'data:' + file.mimetype + ';base64,' + (file.buffer || fs.readFileSync(file.path)).toString('base64');
      if (field.endsWith('_frame')) { if (body[field]) throw fail('首尾帧不能重复传入'); body[field] = data; }
      else { const values = list(body, field === 'reference_images' ? ['reference_images', 'image_urls', 'image_url', 'images'] : field === 'reference_videos' ? ['reference_videos', 'reference_video', 'video_urls', 'video_url'] : ['audio_urls', 'audio_url']);
        for (const key of field === 'reference_images' ? ['image_urls','image_url','images'] : field === 'reference_videos' ? ['reference_video','video_urls','video_url'] : ['audio_url','reference_audios','audios']) delete body[key];
        body[field] = [...values, data]; }
    }
    const nativeImageOutputs = kind === 'image' && modelId === MJ_MODEL_ID ? 4 : undefined;
    if (nativeImageOutputs && body.n !== undefined && ![1, 4].includes(Number(body.n))) throw fail('MJ 每次任务固定返回 4 张图片');
    const request = specificationRequest({ ...body, ...(nativeImageOutputs ? { n: nativeImageOutputs } : {}), resolution: body.resolution || body.output_resolution || spec.limits.resolutions[0], video_length: body.video_length ?? body.seconds ?? body.duration ?? (spec.limits.duration.mode === 'fixed' ? spec.limits.duration.min : spec.limits.duration.mode === 'options' ? spec.limits.duration.values[0] : spec.limits.duration.min) }, kind, process.env.BACKEND_URL || req.protocol + '://' + req.get('host'));
    const mismatch = routingMismatches(spec.limits, request.input, kind);
    if (mismatch.length) throw fail(mismatch.join('；'));
    request.input.resolution = spec.limits.resolutions.find(r => r.toLowerCase() === request.input.resolution.toLowerCase()) || request.input.resolution;
    const candidates = selectModelRoutes(spec, request.input);
    if (!candidates.length) throw fail(modelAvailabilityMessage(specificationAvailability(spec)) || '该规格暂时没有健康且满足参数的线路', 503);
    const trustedOrigins = [request.publicBaseUrl, req.protocol + '://' + req.get('host')];
    const imageSources = [...request.images, ...(request.firstFrame ? [request.firstFrame] : []), ...(request.lastFrame ? [request.lastFrame] : [])];
    const normalized = await validateAndNormalizeImageReferences(imageSources, { trustedOrigins, trustedRemoteOrigins: (process.env.REFERENCE_IMAGE_REMOTE_ORIGINS || 'https://filer2.fdai.xyz').split(/[\s,]+/).filter(Boolean) });
    request.images = normalized.slice(0, request.images.length);
    if (request.firstFrame) request.firstFrame = normalized[request.images.length];
    if (request.lastFrame) request.lastFrame = normalized[request.images.length + Number(Boolean(request.firstFrame))];
    const batch = !apiContext && kind === 'video' ? batchContextForRequest(req as any) : null;
    const usage = { resolution: request.input.resolution, seconds: request.input.seconds, count: nativeImageOutputs ? 1 : request.input.outputs };
    const quote = batch?.pricingSnapshot ? { ...PricingService.quoteSnapshot(batch.pricingSnapshot, usage), pricingSnapshot: batch.pricingSnapshot }
      : PricingService.quote(modelId, usage, false, userId || null);
    if (!quote.billingType) throw fail('该规格尚未配置用户售价');
    if (nativeImageOutputs && quote.billingType !== 'per_call') throw fail('MJ 图片任务请配置按次售价，每次返回 4 张图片');
    if (kind === 'video') {
      if (!['per_call', 'per_second'].includes(quote.billingType)) throw fail('视频用户售价必须按条或按秒配置');
      if (!batch) assertExpectedVideoCost(body, quote.cost);
    }
    const create = () => ContentService.save({ userId, orgId: (req as any).orgId || null, type: kind, modelId,
      title: request.prompt.slice(0, 200), inputText: request.prompt, status: 'queued', cost: batch ? 0 : quote.cost,
      metadata: { managedSpecification: true, requestedModel: modelId, model: modelId, count: request.input.outputs, nativeImageOutputs,
        pricingSnapshot: quote.pricingSnapshot,
        seconds: request.input.seconds, resolution: request.input.resolution, aspect_ratio: request.input.ratio,
        reference_images: request.images, reference_videos: request.videos, audio_urls: request.audios,
        first_frame: request.firstFrame, last_frame: request.lastFrame, queueUserKey: token ? 'token:' + token.id : 'user:' + userId,
        tokenId: token?.id, billingSource: token ? 'api' : 'user', publicBaseUrl: request.publicBaseUrl, startedAt: Date.now(), imageUrls: [], routingAttempts: [],
        ...(batch ? { batchId: batch.batch.id, batchItemId: batch.item.id, batchAttempt: batch.item.attempts, billingStatus: 'batch_reserved' } : {}) } });
    let charge: any;
    sqlite.transaction(() => {
      id = batch ? batchStore.attach(batch.item.id, batch.item.attempts, userId, create) : create();
      if (!batch) {
        charge = apiContext ? apiContext.reserve(quote.cost, modelId, quote.pricingSnapshot) : reserveUserCharge(userId, quote.cost, 'specification_generate', { contentId: id, model: modelId, pricingSnapshot: quote.pricingSnapshot });
        patch(id!, { billingReservationId: charge.id, reservedCost: quote.cost, billingStatus: 'reserved' });
      }
    })();
    const emit = (data: any) => {
      if (apiContext) return;
      const event = publicGenerationEvent(data);
      recordCanvasEvent(req, event);
      if (!res.writableEnded && !res.destroyed) res.write('data: ' + JSON.stringify(event) + '\n\n');
    };
    if (!apiContext) {
      res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive'); res.setHeader('X-Accel-Buffering', 'no'); res.flushHeaders();
      stopHeartbeat = startSseHeartbeat(res);
      emit({ type: 'content_id', contentId: id }); emit({ type: 'status', message: '任务已保存，正在选择可用线路', contentId: id, total: request.input.outputs });
    }
    active.add(id!);
    const run = async () => {
      try { if (kind === 'video') await runVideo(id!, candidates, request, emit); else await runImages(id!, candidates, request, req, emit); }
      catch (e: any) { holdForReview(id!, e.message || '任务待核实'); emit({ type: 'error', message: '任务待核实，请勿重复提交' }); }
      finally {
        active.delete(id!);
        if (apiContext) { const record = db.select().from(contents).where(eq(contents.id, id!)).get();
          if (record) { const meta = JSON.parse(record.metadata); try { db.insert(apiLogs).values({ tokenId: token.id, channelId: meta.channelId, model: modelId, upstreamModel: meta.upstreamModel, cost: record.cost, status: record.status === 'completed' ? 'success' : 'error', durationMs: Date.now() - meta.startedAt }).run(); } catch (error: any) { console.warn('[specification] api log failed', id, error.message); } }
        }
      }
    };
    if (apiContext && kind === 'video') {
      void run();
      res.json({ id: 'task_' + id, task_id: 'task_' + id, object: 'video', model: modelId, status: 'queued', progress: 0,
        status_url: req.protocol + '://' + req.get('host') + '/v1/videos/task_' + id });
    } else {
      await run();
      if (apiContext) {
        const row = db.select().from(contents).where(eq(contents.id, id!)).get()!, meta = JSON.parse(row.metadata);
        if (row.status !== 'completed') res.status(meta.requiresReview ? 202 : 502).json({ id: 'task_' + id, status: row.status, requires_review: Boolean(meta.requiresReview), error: publicGenerationError(meta.requiresReview ? '提交结果待核实，请勿重复提交' : meta.error || '生成失败') });
        else res.json({ created: Math.floor(Date.now() / 1000), data: meta.imageUrls.map((url: string) => (request.body.response_format === 'b64_json' ? { b64_json: fs.readFileSync(path.join('data/uploads', path.basename(url))).toString('base64') } : { url: issueUploadUrl(url, request.publicBaseUrl) })) });
      } else if (!res.writableEnded && !res.destroyed) res.end('data: [DONE]\n\n');
    }
    return true;
  } catch (e: any) {
    if (id) holdForReview(id, e.message);
    if (!res.headersSent) res.status(e.status || 500).json({ error: e.message || '生成失败' });
    else if (!res.writableEnded) res.end();
    return true;
  } finally {
    stopHeartbeat();
    for (const file of Array.isArray(req.files) ? req.files : []) { if (file.path) { try { fs.unlinkSync(file.path); } catch {} } }
  }
}
async function recoverImages(id: number) {
  const initial = metadata(id), jobs = initial.imageJobs as any[];
  const req = { protocol: new URL(initial.publicBaseUrl).protocol.slice(0,-1), get: () => new URL(initial.publicBaseUrl).host } as unknown as Request;
  if (initial.nativeImageBatch) {
    const channel = ChannelService.getChannelRaw(initial.channelId, initial.channelApiKeyId || null);
    if (!channel) { holdForReview(id, 'MJ 原渠道已删除，请管理员核实'); return; }
    await saveMjResults(id, channel, req, () => {}); return;
  }

  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    let pending = false;
    for (const job of jobs) {
      if (['completed','failed'].includes(job.status)) continue;
      const channel = ChannelService.getChannelRaw(job.channelId, job.apiKeyId || null);
      if (!channel) { holdForReview(id, '图片原渠道已删除，请管理员核实'); return; }
      try {
        if (!job.sourceUrl) {
          const result = await pollSpecificationImage(channel, job.taskId);
          if (result.status === 'failed') { job.status = 'failed'; noteRouteResult(job.healthKey, false, result.error || '图片生成失败', false, true); continue; }
          if (result.status !== 'completed' || !result.imageUrl) { pending = true; continue; }
          job.sourceUrl = result.imageUrl; patch(id, { imageJobs: jobs });
        }
        const { localizeGeneratedImage } = await import('../routes/imageGen.js');
        job.localUrl = await localizeGeneratedImage(job.sourceUrl, 'spec_image_' + id + '_' + job.index, req, channel, { relative: true });
        job.status = 'completed'; noteRouteResult(job.healthKey, true);
      } catch { pending = true; }
    }
    const urls = jobs.filter(j => j.status === 'completed').sort((a,b) => a.index - b.index).map(j => j.localUrl);
    patch(id, { imageJobs: jobs, imageUrls: urls });
    if (!pending) {
      if (initial.submissionStartedAt && !jobs.some(j => j.index === initial.imageSubmissionIndex)) { holdForReview(id, '有一张图片的提交结果仍待核实，请勿重提'); return; }
      if (urls.length) complete(id, urls); else failTask(id, '图片生成失败'); return;
    }
    await wait(8000);
  }
  holdForReview(id, '图片原任务仍在处理中，请勿重复提交');
}

export function resumeSpecificationTasks() {
  for (const row of db.select().from(contents).where(inArray(contents.status, ['processing', 'queued'])).all()) {
    let meta: any; try { meta = JSON.parse(row.metadata || '{}'); } catch { continue; }
    if (!meta.managedSpecification || active.has(row.id)) continue;
    if (row.type === 'image' && (meta.nativeImageBatch || meta.imageJobs?.length)) { active.add(row.id); void recoverImages(row.id).catch(() => holdForReview(row.id, '图片结果待核实')).finally(() => active.delete(row.id)); continue; }
    if (!meta.videoId || row.type !== 'video') {
      if (!meta.requiresReview) holdForReview(row.id, '服务重启后提交状态待核实，请勿重复提交');
      continue;
    }
    const channel = ChannelService.getChannelRaw(Number(meta.channelId), Number(meta.channelApiKeyId) || null);
    if (!channel) { holdForReview(row.id, '原任务渠道已删除，需要管理员核实'); continue; }
    active.add(row.id);
    void pollVideo(row.id, channel, meta.videoId, () => {}).catch(() => holdForReview(row.id, '任务结果待核实')).finally(() => active.delete(row.id));
  }
}
