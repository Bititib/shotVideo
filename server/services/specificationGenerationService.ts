import { isSiYueTianManagedVideoModel, siYueTianManagedVideoInputErrors } from '../../shared/siYueTianManagedVideo.js';
import { isZhiyingVideoModel } from '../../shared/zhiyingVideo.js';
import { normalizeZhiyingRequest, assertZhiyingOriginalChannel, zhiyingPayloadHash } from './zhiyingVideoExecution.js';
import { createZhiyingVideo } from './zhiyingVideoAdapter.js';
import { findVideoSubmissionReceipt } from './videoSubmissionReceiptService.js';
import { HUSS_MJ_MODEL, hussMjOptions } from '../../shared/hussMidjourney.js';
import { submitHussImage, queryHussImage, HussImageError } from './hussImageAdapter.js';
import { isHussPersistentVideoModel } from '../../shared/hussBbVideo.js';
import { bbHssKkManaged } from './bbHssKkMigration.js';
import { isBbHssKkEntry } from '../../shared/bbHssKk.js';
import { HAYA_MO_MODEL } from '../../shared/hayaMoVideo.js';
import { isHayaChannel } from './hayaVideoAdapter.js';
import { validateHayaMedia } from './hayaMediaService.js';
import { isRetiredVideoModel, RETIRED_VIDEO_MODEL_MESSAGE } from '../../shared/retiredVideoModels.js';
import { activeSpecificationTasks } from './videoRecoveryAction.js';
import { normalizeSiYueTianMinimaxTask } from './siYueTianMinimaxAdapter.js';
import { isMegabyChannel, normalizeMegabyTask, validateMegabyVideoInput, validateMegabyReferenceDurations } from './megabyVideoAdapter.js';
import { isHussChannel, recoverHussSubmission, normalizeHussTask } from './hussVideoAdapter.js';
import { publicApiModelId } from '../../shared/funAi.js';
import { videoCapabilities, normalizeVideoParameters } from './videoCapabilities.js';
import { isZonghengChannel, normalizeZonghengTask } from './zonghengAdapter.js';
import { acceptZonghengVideoReceipt } from './zonghengTaskService.js';
import { recordV6kDeliveryUnavailable } from './v6kDeliveryState.js';
import { zonghengProtocol, zonghengTaskChannel, isRetiredZonghengTask, RETIRED_ZONGHENG_MESSAGE, v6kQueryRetryDelay } from './zonghengProtocol.js';
import { modelAvailabilityMessage } from '../../shared/upstreamAvailability.js';
import { startSseHeartbeat } from './sseHeartbeat.js';
import { publicGenerationError, publicGenerationEvent } from '../../shared/generationMessages.js';
import { isFunAiChannel } from './funAiAdapter.js';
import { validateSpecificationVideoParameters } from './specificationAdapters.js';
import { SNUMOM_MUSE_MODEL } from '../../shared/snumomMuse.js';
import { KK_VIDEO_MODEL } from '../../shared/kkVideoRouting.js';
import { V6K_FULL_720_MODEL, normalizeFull720VideoInput } from '../../shared/v6kFullReferenceVideo.js';
import { randomUUID } from 'node:crypto';
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
import { ContentService, publicZhiyingDiagnostic } from './contentService.js';
import { ChannelService } from './channelService.js';
import { PricingService } from './pricingService.js';
import { BalanceService } from './balanceService.js';
import { TokenService } from './tokenService.js';
import { reserveUserCharge, linkReservationContent } from './billingReservation.js';
import { linkApiVideoRequest } from './apiVideoIdempotency.js';
import { withFundContext } from '../db/fundLedger.js';
import { getModelSpecification, specificationAvailability, selectModelRoutes, routeStillEnabled, routeUnavailableReason, claimRouteProbe, noteRouteResult, type RouteCandidate } from './modelRoutingService.js';
import { submitSpecificationVideo, pollSpecificationVideo, pollSpecificationImage, pollMjSpecificationImage, generateSpecificationImage, SpecificationUpstreamError, type SpecificationRequest } from './specificationAdapters.js';
import { validateAndNormalizeImageReferences } from './imageReferenceValidationService.js';
import { prepareHmReferenceImages } from './hmStudioReferenceService.js';
import { isHmStudioChannel } from './hmStudioAdapter.js';
import { hmStudioQueue, hmStudioPoolKey, HmStudioQueueFullError } from './hmStudioQueueService.js';
import { recordCanvasEvent } from '../middleware/canvasRequest.js';
import { logUsage } from '../middleware/quota.js';
import { routingMismatches, type MediaKind } from '../../shared/modelRouting.js';
import { issueUploadUrl, mediaOwnerContext } from './uploadAccess.js';
import { isMjChannel, mjBaseUrl, canResumeMjAsync, type MjAsyncImageState } from './mjAdapter.js';
import { MJ_MODEL_ID } from '../../shared/mj.js';
import { saveMjImageBatch, restoreCachedMjOriginal, type MjImageBatch } from './mjImageResults.js';
import { resolvePublicModelId } from './publicModelNameService.js';
import { batchContextForRequest, batchStore, markBatchSubmitting, recordBatchFailure } from './videoBatchService.js';
import { claimVideoSubmission, acceptVideoSubmission, endVideoSubmission, releaseVideoSubmission, videoSubmissionPending, videoSubmissionPreparation } from './videoSubmissionGuard.js';
import { isSnumomWanChannel, normalizeSnumomWanTask } from './snumomWanAdapter.js';
import { canCancelVideoContent } from './videoCancellationEligibility.js';

const active = activeSpecificationTasks;
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
  if (kind === 'video' && isZhiyingVideoModel(body.model)) {
    try { normalizeZhiyingRequest(body); } catch (error: any) { throw fail(error.message); }
  }
  if (kind === 'video') { try { normalizeFull720VideoInput(body); } catch (error: any) { throw fail(error.message); } }
  const siYueTianMinimax = kind === 'video' && isSiYueTianManagedVideoModel(body.model);
  if (siYueTianMinimax || body.model === SNUMOM_WAN_NSFW_MODEL) {
    const seconds = [body.seconds, body.duration, body.video_length, ...(body.model === SNUMOM_WAN_NSFW_MODEL ? [body.parameters?.duration,body.duration_seconds] : [])].filter(value => value !== undefined).map(Number);
    if (seconds.some(value => !Number.isFinite(value)) || new Set(seconds).size > 1) throw fail('seconds、duration、video_length 必须一致且为有效数字');
  }
  if (body.resolution && body.output_resolution && String(body.resolution).toLowerCase() !== String(body.output_resolution).toLowerCase()) throw fail('resolution 与 output_resolution 不一致');
  if (body.mask !== undefined) throw fail('当前统一规格未配置蒙版编辑，请使用支持蒙版的独立入口');
  if (body.response_format && !['url', 'b64_json'].includes(body.response_format)) throw fail('response_format 仅支持 url 或 b64_json');
  const images = list(body, ['reference_images', 'image_urls', 'image_url', 'images', ...(body.model === V6K_FULL_720_MODEL ? ['image_refs','reference_image_urls','Ingredients_images'] : siYueTianMinimax ? ['image_refs'] : [])]);
  const videos = list(body, ['reference_videos', 'reference_video', 'video_urls', 'video_url', ...(isBbHssKkEntry(body.model) ? ['videos'] : []), ...(body.model === V6K_FULL_720_MODEL ? ['videos','video','video_refs','reference_video_urls'] : siYueTianMinimax ? ['video_refs'] : [])]);
  const audios = list(body, ['audio_urls', 'audio_url', 'reference_audios', 'audios', ...(body.model === V6K_FULL_720_MODEL ? ['audio','reference_audio','audio_refs','reference_audio_urls'] : siYueTianMinimax ? ['audio_refs'] : [])]);
  const firstFrame = body.first_frame || body.first_frame_url || '';
  const lastFrame = body.last_frame || body.last_frame_url || body.end_frame_url || '';
  const outputs = Number(body.n ?? 1), seconds = Number(body.video_length ?? body.seconds ?? body.duration ?? (body.model === SNUMOM_WAN_NSFW_MODEL ? body.parameters?.duration ?? body.duration_seconds : undefined) ?? 6);
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw fail('请输入描述');
  if (!Number.isInteger(outputs) || outputs < 1 || outputs > 4) throw fail('输出数量必须为 1–4');
  if (kind === 'video' && (!Number.isFinite(seconds) || seconds <= 0 && !(body.model === SNUMOM_WAN_NSFW_MODEL && seconds === -1) || outputs !== 1)) throw fail('视频时长或输出数量无效');
  if (typeof firstFrame !== 'string' || typeof lastFrame !== 'string') throw fail('首尾帧必须是图片 URL 或 Base64');
  if (kind === 'image' && (videos.length || audios.length || firstFrame || lastFrame)) throw fail('图片生成不能传入视频、音频或独立首尾帧');
  const sizeRatios: Record<string,string> = { '1024x1024': '1:1', '1536x864': '16:9', '864x1536': '9:16', '1536x1152': '4:3', '1152x1536': '3:4', '1536x1024': '3:2', '1024x1536': '2:3', '1280x720': '16:9', '720x1280': '9:16', '1024x768': '4:3', '768x1024': '3:4' };
  const resolution = String(body.output_resolution || body.resolution || (kind === 'image' ? '2K' : '720p'));
  if (kind === 'image' && body.size && !sizeRatios[body.size]) throw fail('此规格不支持该 size，请使用 aspect_ratio 和 resolution');
  if (kind === 'image' && body.size && (body.aspect_ratio || body.ratio) && sizeRatios[body.size] !== (body.aspect_ratio || body.ratio)) throw fail('size 与宽高比不一致');
  const ratio = String(body.aspect_ratio || body.ratio || (sizeRatios[body.size] ? sizeRatios[body.size] : kind === 'image' ? '1:1' : '16:9'));
  return { prompt: body.prompt.trim(), images, videos, audios, firstFrame, lastFrame, body, publicBaseUrl,
    input: { images: images.length, videos: videos.length, audios: audios.length, outputs, seconds,
      resolution, ratio,
      firstFrame: Boolean(firstFrame), lastFrame: Boolean(lastFrame), quality: body.quality } };
}
export async function prepareSpecificationReferenceImages(request: SpecificationRequest, candidates: RouteCandidate[], trustedOrigins: string[]) {
  // Upload the original bytes through the dedicated files endpoint. The generic
  // image normalizer recompresses references as JPEG before submission.
  if (candidates.length && candidates.every(t => t.channel.type === 'zhiying')) return;
  if (candidates.length && candidates.every(t => isHayaChannel(t.channel) && t.route.upstreamModel === HAYA_MO_MODEL)) {
    const options = { baseUrl: candidates[0].channel.baseUrl, apiKey: candidates[0].channel.apiKey,
      publicBaseUrl: request.publicBaseUrl, maxFileBytes: 30 * 1024 * 1024, imageDimensions: false };
    await validateHayaMedia(request.images, 'image', options);
    await validateHayaMedia(request.videos, 'video', options);
    await validateHayaMedia(request.audios, 'audio', options);
    return;
  }
  const count = request.images.length;
  const sources = [...request.images, ...(request.firstFrame ? [request.firstFrame] : []), ...(request.lastFrame ? [request.lastFrame] : [])];
  const normalized = candidates.some(target => isHmStudioChannel(target.channel))
    ? await prepareHmReferenceImages(sources, request.publicBaseUrl, trustedOrigins)
    : await validateAndNormalizeImageReferences(sources, { trustedOrigins,
      trustedRemoteOrigins: (process.env.REFERENCE_IMAGE_REMOTE_ORIGINS || 'https://filer2.fdai.xyz').split(/[\s,]+/).filter(Boolean) });
  request.images = normalized.slice(0, count);
  if (request.lastFrame) request.lastFrame = normalized[count + Number(Boolean(request.firstFrame))];
  if (request.firstFrame) request.firstFrame = normalized[count];
}
function patch(id: number, values: Record<string, any>, status?: string) {
  const row = db.select().from(contents).where(eq(contents.id, id)).get();
  if (!row) return;
  if (row.type === 'video' && ['completed', 'failed'].includes(row.status || '') && status !== row.status) return;
  db.update(contents).set({ metadata: JSON.stringify({ ...JSON.parse(row.metadata || '{}'), ...values }), ...(status ? { status } : {}) }).where(eq(contents.id, id)).run();
}
function metadata(id: number) {
  const row = db.select().from(contents).where(eq(contents.id, id)).get();
  return row ? JSON.parse(row.metadata || '{}') : {};
}
/** Idempotent finalization, including accepted tasks resumed after a process restart. */
function finalizeReservation(id: string | undefined, actual: number, contentId: number): number {
  if (!id) return actual;
  return sqlite.transaction(() => {
    const row = sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(id) as any;
    if (!row) return 0;
    if (!['reserved', 'review'].includes(row.state)) return Number(row.actual) || 0;
    if (!Number.isFinite(actual) || actual < 0) throw new Error('结算金额无效');
    if (actual > row.amount) {
      if (!metadata(contentId).snumomReferenceBilling) throw new Error('结算金额无效');
      const context = JSON.parse(row.context);
      const extra = Math.round((actual-row.amount)*1e6)/1e6;
      withFundContext(sqlite, {contentId,kind:'charge'}, () => {
        if (!context.tokenId || context.unlimitedToken) {
          const supplement = BalanceService.deductWithSource(context.userId,extra,'snumom_actual_supplement',{contentId});
          if (!supplement) throw new Error('实际费用高于预扣且余额不足，结算待核实');
          const receipt = JSON.parse(row.receipt);
          const originalSource = context.tokenId ? receipt.balanceDeduction : receipt;
          if (originalSource && (supplement.source !== originalSource.source || (supplement.orgId || null) !== (originalSource.orgId || null))) throw new Error('原扣款账户已变化，实际费用结算待核实');
        }
        if (context.tokenId) TokenService.deductBalance(context.tokenId,extra);
      });
    }
    const refund = Math.max(0, Math.round((row.amount - actual) * 1e6) / 1e6);
    const receipt = JSON.parse(row.receipt), context = JSON.parse(row.context);
    if (refund > 0) {
      withFundContext(sqlite, { contentId, kind: 'refund' }, () => {
      if (context.tokenId) {
        if (context.unlimitedToken && context.userId) {
          BalanceService.refundToSource(context.userId, refund, receipt.balanceDeduction?.source || 'user', receipt.balanceDeduction?.orgId, 'specification_refund');
        }
        TokenService.refundBalance(context.tokenId, refund);
      } else {
        BalanceService.refundToSource(context.userId, refund, receipt.source, receipt.orgId, 'specification_refund');
      }
      });
    }
    sqlite.prepare("UPDATE billing_reservations SET actual=?,state=?,settled_at=datetime('now') WHERE id=?").run(actual, actual ? 'settled' : 'refunded', id);
    return actual;
  })();
}
function holdForReview(id: number, message: string, reviewKind: 'submission' | 'query' | 'settlement' | 'local' = 'submission') {
  const record = db.select().from(contents).where(eq(contents.id, id)).get();
  if (record?.type === 'video' && ['completed', 'failed'].includes(record.status || '')) return;
  const meta = metadata(id);
  if (meta.billingReservationId && reviewKind !== 'query') sqlite.prepare("UPDATE billing_reservations SET state='review' WHERE id=? AND state='reserved'").run(meta.billingReservationId);
  patch(id, { requiresReview: true, reviewKind, progressText: message, error: message,
    ...(reviewKind !== 'query' ? { billingStatus: 'review' } : {}) }, record?.type === 'video' && reviewKind !== 'submission' ? 'review' : undefined);
  if (meta.batchItemId) recordBatchFailure(id, message, false);
}
function handleUnexpectedGenerationError(id: number, message: string) {
  const record = db.select().from(contents).where(eq(contents.id, id)).get();
  if (!record || ['completed', 'failed'].includes(record.status || '')) return;
  if (record.type !== 'video') { holdForReview(id, message); return; }
  const meta = metadata(id);
  if (meta.reviewKind === 'settlement' || meta.upstreamStatus === 'completed') holdForReview(id, message, 'settlement');
  else if (meta.videoId || meta.upstreamTaskId) holdForReview(id, message, 'query');
  else if (meta.submissionStartedAt || meta.videoRequestStartedAt || ['unknown', 'accepted'].includes(meta.videoSubmissionState)) holdForReview(id, message, 'submission');
  else failTask(id, message);
}
function complete(id: number, urls: string[]) {
  sqlite.transaction(() => {
    const record = db.select().from(contents).where(eq(contents.id, id)).get();
    if (!record || record.type === 'video' && ['completed', 'failed'].includes(record.status || '')) return;
    completeContent(id, urls);
  })();
}
function completeContent(id: number, urls: string[]) {
  const meta = metadata(id), record = db.select().from(contents).where(eq(contents.id, id)).get()!;
  let actual = meta.batchItemId ? record.cost : meta.nativeImageOutputs ? meta.reservedCost || 0
    : Math.round((meta.reservedCost || 0) * urls.length / (meta.count || 1) * 1e6) / 1e6;
  if (record.type === 'video' && meta.snumomReferenceBilling) {
    actual = meta.upstreamBillingUsage ? PricingService.quoteSnapshot(meta.pricingSnapshot, {
      resolution:meta.upstreamBillingUsage.resolution || meta.resolution,seconds:meta.upstreamBillingUsage.billableSeconds,count:1,
    }).cost : meta.reservedCost ?? meta.batchReservedAmount;
    if (meta.batchItemId && Math.abs(actual-Number(meta.batchReservedAmount))>0.000001) throw new Error('批量原任务实际用量与预扣不同，保留结果和原预扣，结算待核实');
  }
  actual = finalizeReservation(meta.billingReservationId, actual, id);
  patch(id, { imageUrls: record.type === 'image' ? urls : undefined, ...(meta.nativeImageOutputs ? { count: urls.length } : {}), progress: 100, progresses: urls.map(() => 100),
    completedAt: new Date().toISOString(), billingStatus: 'settled', requiresReview: false, reviewKind: null, upstreamQueryError: null,
    resultSaveError: null, upstreamDeliveryPending: false,
    ...(meta.videoDeliveryUnavailable ? { videoDeliveryUnavailable: false, v6kDeliveryDiagnostics: undefined } : {}), progressText: '生成完成' }, 'completed');
  db.update(contents).set({ resultUrl: urls[0], cost: actual }).where(eq(contents.id, id)).run();
  if (record.userId) { try { logUsage(record.userId, record.type === 'video' ? 'video' : 'generate_image', undefined, Date.now() - meta.startedAt); } catch (error: any) { console.warn('[specification] usage log failed', id, error.message); } }
}
function failTask(id: number, message: string) {
  try {
  sqlite.transaction(() => {
    const record = db.select().from(contents).where(eq(contents.id, id)).get();
    if (!record || record.type === 'video' && ['completed', 'failed'].includes(record.status || '')) return;
    failContent(id, message);
  })();
  } catch (error: any) {
    const record = db.select().from(contents).where(eq(contents.id, id)).get();
    if (record?.type === 'video') {
      patch(id, { upstreamStatus: 'failed', refundPending: true });
      holdForReview(id, error.message || '退款处理待核实', 'settlement');
    }
    throw error;
  }
}
export { failTask as finalizeFailedSpecificationTask };

function failContent(id: number, message: string) {
  const meta = metadata(id);
  if (meta.batchItemId && recordBatchFailure(id, message, true)) return;
  finalizeReservation(meta.billingReservationId, 0, id);
  patch(id, { error: message, failureReason: message, billingStatus: 'refunded', requiresReview: false, reviewKind: null, upstreamQueryError: null, refundAmount: meta.reservedCost || 0,
    progressText: message, failedAt: new Date().toISOString() }, 'failed');
  db.update(contents).set({ cost: 0 }).where(eq(contents.id, id)).run();
}
async function pollVideo(id: number, channel: any, taskId: string, onEvent: (data: any) => void) {
  const zhiying = channel.type === 'zhiying';
  if (zhiying || metadata(id).zhiyingOrder) assertZhiyingOriginalChannel(channel, metadata(id));
  if (isZonghengChannel(channel) && isRetiredZonghengTask(metadata(id))) { holdForReview(id, RETIRED_ZONGHENG_MESSAGE, 'query'); return; }
  if (isZonghengChannel(channel)) channel = zonghengTaskChannel(channel, metadata(id));
  if (isZonghengChannel(channel)) patch(id, { v6kQueryResumeAt: null });
  const end = Date.now() + 2 * 60 * 60_000;
  let queryFailures = 0;
  if (isHussChannel(channel)) patch(id, { hussQueryResumeAt: null });
  while (Date.now() < end) {
    let task: any;
    let saveRetryMs = 0;
    let localCompletion = false;
    try {
      const hussInitial = isHussChannel(channel) ? metadata(id).hussInitialTask : null;
      const hussMeta = metadata(id);
      const hussReceipt = isHussChannel(channel) ? hussMeta.hussCompletedReceipt ||
        (hussMeta.upstreamStatus === 'completed' && hussMeta.upstreamResultUrl && (hussMeta.videoId || hussMeta.upstreamTaskId) === taskId
          ? { taskId, resultUrl: hussMeta.upstreamResultUrl } : null) : null;
      const siYueTianReceipt = isSiYueTianManagedVideoModel(metadata(id).actualModel) ? metadata(id).siYueTianMinimaxCompletedReceipt : null;
      const completedReceipt = hussReceipt || metadata(id).megabyCompletedReceipt || siYueTianReceipt;
      if (zhiying && hussMeta.zhiyingInitialTask) {
        task = hussMeta.zhiyingInitialTask;
        if (task.taskId !== taskId) throw new Error('智赢原创建回执编号与已保存任务不符');
        // A completed job may publish its signed result later. Requery the original ID.
        if (!['failed','cancelled','canceled'].includes(task.status) && !(task.status === 'completed' && task.resultUrl)) {
          patch(id, { zhiyingInitialTask: null, ...(task.status === 'completed' ? { upstreamGenerated:true, upstreamDeliveryPending:true } : {}) });
        }
      } else if (zhiying && hussMeta.zhiyingCompletedReceipt?.taskId === taskId) {
        task = { status: 'completed', progress: 100, resultUrl: hussMeta.zhiyingCompletedReceipt.resultUrl };
      } else if (hussInitial && ['completed','failed','cancelled','canceled'].includes(hussInitial.status)) {
        localCompletion = true;
        task = normalizeHussTask(hussInitial, channel.baseUrl, taskId);
        patch(id, { hussInitialTask: null });
      } else if ((isMegabyChannel(channel) || hussReceipt || siYueTianReceipt) && completedReceipt?.taskId === taskId && completedReceipt.resultUrl) {
        localCompletion = Boolean(hussReceipt || siYueTianReceipt);
        task = { status: 'completed', progress: 100, resultUrl: completedReceipt.resultUrl };
      } else {
        const megabyInitial = metadata(id).megabyInitialTask;
        if (isMegabyChannel(channel) && megabyInitial) { task = normalizeMegabyTask(megabyInitial, channel.baseUrl, taskId, channel.apiKey); patch(id, { megabyInitialTask: undefined }); }
        else {
          const initial = metadata(id).zonghengInitialTask;
          if (isZonghengChannel(channel) && initial) { task = normalizeZonghengTask(initial, channel.baseUrl, 'v6k', taskId); patch(id, { zonghengInitialTask: undefined }); }
          else {
            const meta = metadata(id);
            if (isSiYueTianManagedVideoModel(meta.actualModel) && meta.siYueTianMinimaxInitialTask) {
              task = normalizeSiYueTianMinimaxTask(meta.siYueTianMinimaxInitialTask, channel, taskId);
              patch(id, { siYueTianMinimaxInitialTask: null });
              } else if ((meta.snumomReferenceBilling || meta.actualModel === SNUMOM_MUSE_MODEL) && isSnumomWanChannel(channel)) {
              if (meta.snumomInitialTask) { task=normalizeSnumomWanTask(meta.snumomInitialTask,meta.referenceVideoSeconds || 0,meta.actualModel);patch(id,{snumomInitialTask:null}); }
              else task = await pollSpecificationVideo(channel,taskId,meta.actualModel,meta.referenceVideoSeconds || 0);
            }
            else task = zhiying || isSiYueTianManagedVideoModel(meta.actualModel)
              ? await pollSpecificationVideo(channel, taskId, meta.actualModel) : await pollSpecificationVideo(channel, taskId);
          }
        }
      }
    }
    catch (error: any) {
      const status = Number(error?.status) || null;
      const message = transportDiagnostic(channel.type || 'OpenAI-compatible', '任务查询 task_id=' + taskId + '；正在重试，请勿重复提交', error, channel.apiKey);
      patch(id, { progressText: message, upstreamQueryError: message, lastQueryAt: new Date().toISOString(), lastQueryStatus: status, queryFailures: ++queryFailures });
      onEvent({ type: 'status', message, contentId: id });
      await wait(zhiying ? Math.max(8_000, Number(error?.retryAfterMs) || 0) : isZonghengChannel(channel) ? v6kQueryRetryDelay(queryFailures, error?.retryAfter) : isHussChannel(channel) ? Math.max(12_000, Number(error?.retryAfterMs) || 0) : 12_000); continue;
    }
    queryFailures = 0;
    if (zhiying) {
      const points = Object.fromEntries(['costPoints','chargedPoints','refundedPoints','refunded'].filter(key => task[key] !== undefined).map(key => [key, task[key]]));
      if (Object.keys(points).length) patch(id, { zhiyingUpstreamBilling: { ...metadata(id).zhiyingUpstreamBilling, ...points } });
    }
    if (zhiying && task.status === 'completed') patch(id, { upstreamGenerated: true, upstreamDeliveryPending: true });
    if (zhiying && metadata(id).upstreamGenerated && task.status !== 'completed') {
      patch(id, { upstreamQueryError: '智赢已确认生成，后续查询状态为 ' + task.upstreamStatus + '；继续核对原任务交付',
        progressText: '原视频已生成，正在核对成品地址' });
      await wait(8_000); continue;
    }
    patch(id, { upstreamQueryError: null });
    const progressKnown = task.progressKnown ?? (typeof task.progress === 'number' && Number.isFinite(task.progress));
    const message = zhiying && task.status === 'completed' && !task.resultUrl ? '上游已生成，正在等待原任务的成品地址'
      : zhiying && task.upstreamStatus === 'review' ? '上游正在核对原任务，继续查询'
      : zhiying && task.error ? task.error
      : (isZonghengChannel(channel) || isHussChannel(channel)) && task.progressText ? task.progressText : isHussChannel(channel) && task.storagePending ? 'HUSS 已生成，正在保存成品；继续查询原任务' : task.status === 'queued' ? '渠道已受理，正在排队'
      : ['completed', 'success', 'succeeded', 'done'].includes(task.status) ? '视频已生成，正在保存到本站存储'
      : progressKnown ? '视频生成中' : '视频生成中，渠道暂未提供百分比';
    patch(id, { progress: task.progress, progressKnown, upstreamStatus: isZonghengChannel(channel) || zhiying ? task.upstreamStatus || task.status : task.status, progressText: message,
      ...(!localCompletion ? { lastQueryAt: new Date().toISOString(), lastQueryStatus: 200, queryFailures: 0 } : {}) });
    onEvent({ type: 'progress', progress: task.progress, progressKnown, message, contentId: id });
    if (['failed', 'error', 'cancelled', 'canceled', 'failure'].includes(task.status)) {
      const meta = metadata(id);
      if (zhiying) patch(id, { zhiyingFailure: { taskId, message: task.error || '智赢未提供任务失败详情' } });
      if (!/content|policy|审核|敏感|违规/i.test(task.error || '')) noteRouteResult(meta.routingHealthKey, false, task.error || '上游生成失败', false, true);
      failTask(id, task.error || '上游生成失败'); onEvent({ type: 'error', message: task.error || '上游生成失败' }); return;
    }
    if (['completed', 'success', 'succeeded', 'done'].includes(task.status) && task.resultUrl) {
      let localized = '';
      try {
        patch(id, { upstreamResultUrl: task.resultUrl,
          ...(zhiying ? { zhiyingCompletedReceipt: { taskId, resultUrl: task.resultUrl }, zhiyingInitialTask: null, upstreamGenerated: true, upstreamDeliveryPending: true } : {}),
          ...(metadata(id).snumomReferenceBilling && task.billingUsage ? { upstreamBillingUsage:task.billingUsage } : {}),
          ...(isSiYueTianManagedVideoModel(metadata(id).actualModel) ? { siYueTianMinimaxCompletedReceipt: { taskId, resultUrl: task.resultUrl } } : {}),
          ...(isHussChannel(channel) ? { hussCompletedReceipt: { taskId, resultUrl: task.resultUrl }, upstreamGenerated: true, upstreamDeliveryPending: true } : {}),
          ...(isMegabyChannel(channel) ? { megabyCompletedReceipt: { taskId, resultUrl: task.resultUrl } } : {}) });
        const { downloadAndLocalizeVideo } = await import('./videoLocalizationService.js');
        localized = await downloadAndLocalizeVideo(task.resultUrl, taskId, metadata(id).actualModel, channel.id, channel.apiKeyId, progress => {
          const mb = (n: number) => (n / 1048576).toFixed(2);
          const message = progress.phase === 'validating' ? '视频已下载，正在校验或转换播放格式'
            : progress.phase === 'retrying' ? `下载中断，已保留 ${mb(progress.bytes)} MB；等待恢复原任务`
            : `视频下载中：${mb(progress.bytes)}${progress.total ? ' / ' + mb(progress.total) : ''} MB${progress.resumable ? '（支持安全续传）' : ''}`;
          patch(id, { downloadProgress: { ...progress, updatedAt: new Date().toISOString() }, progressText: message });
        }, ...(zhiying ? [metadata(id).zhiyingCredential] : []));
      } catch (error: any) {
        if (recordV6kDeliveryUnavailable(id, error)) {
          onEvent({ type: 'status', message: publicGenerationError(error.message, ['V6K']), contentId: id }); return;
        }
        console.warn('[specification] result save failed', id, error.message);
        const detail = transportDiagnostic(channel.type, '上游已完成，结果保存失败；正在重试保存', error, channel.apiKey);
        patch(id, zhiying || isMegabyChannel(channel) || isHussChannel(channel) ? { progressText: detail, resultSaveError: detail } : { progressText: '上游已完成，正在保存结果' });
        if (isHussChannel(channel)) {
          saveRetryMs = Math.max(60_000, Number(error?.retryAfterMs) || 0);
          onEvent({ type: 'status', message: detail, contentId: id });
          if (error?.status === 410) {
            patch(id, { hussDeliveryExpired: true });
            holdForReview(id, detail + '；成品保存期限已结束，请联系上游核对原任务', 'local');
            return;
          }
        }
      }
      if (localized) {
        try { complete(id, [localized]); if (isMegabyChannel(channel) || isHussChannel(channel)) patch(id, { resultSaveError: null, upstreamDeliveryPending:false }); }
        catch (error: any) {
          db.update(contents).set({ resultUrl: localized }).where(eq(contents.id, id)).run();
          holdForReview(id, error.message || '生成结果已保留，费用结算待核实', 'settlement');
          onEvent({ type: 'status', message: '生成结果已保留，费用结算待核实，请勿重复提交' }); return;
        }
        noteRouteResult(metadata(id).routingHealthKey, true);
        onEvent({ type: 'complete', videoUrl: localized, contentId: id }); return;
      }
    }
    await wait(saveRetryMs || (isZonghengChannel(channel) ? 20_000 : isFunAiChannel(channel) ? 5_000 : isHussChannel(channel) ? 15_000 : 8_000));
  }
  if (zhiying) {
    patch(id, { zhiyingResumeAt: Date.now() + 8_000, progressText: '正在后台继续查询或保存智赢原任务' });
    return;
  }
  if (isHussChannel(channel)) {
    patch(id, { hussQueryResumeAt: Date.now() + 60_000 });
    return; // Resume the original ID/download in the next worker cycle, not a permanent review.
  }
  if (isSiYueTianManagedVideoModel(metadata(id).actualModel)) {
    patch(id, { siYueTianMinimaxResumeAt: Date.now() + 60_000, progressText: '原任务尚未结束，将在后台继续查询，请勿重复提交' });
    return;
  }
  if (isZonghengChannel(channel)) {
    const message = '原任务尚未结束，将在后台继续查询，请勿重复提交';
    patch(id, { progressText: message, v6kQueryResumeAt: Date.now() + v6kQueryRetryDelay(Math.max(1, queryFailures)) });
    onEvent({ type: 'status', message }); return;
  }
  const reviewMessage = (metadata(id).upstreamQueryError || '') + '；原任务查询达到时限，费用保留，请核查原任务，请勿重复提交';
  holdForReview(id, reviewMessage, 'query');
  onEvent({ type: 'status', message: reviewMessage });
}
async function runVideo(id: number, candidates: RouteCandidate[], request: SpecificationRequest, onEvent: (data: any) => void) {
  for (const target of candidates) {
    // Re-read manual switches immediately before submission, including queued jobs.
    const unavailable = () => routeUnavailableReason(metadata(id).requestedModel, target, request.input);
    const skippedReason = unavailable();
    if (skippedReason) {
      patch(id, { routingAttempts: [...(metadata(id).routingAttempts || []), { routeId: target.route.id, reason: skippedReason, stage: 'pre_submit', at: new Date().toISOString() }] });
      continue;
    }
    if (!claimRouteProbe(target.healthKey)) continue;
    const attempt = async () => {
      const current = db.select().from(contents).where(eq(contents.id, id)).get();
      if (!current || ['completed', 'failed'].includes(current.status || '')) return;
      const changed = unavailable();
      if (changed) throw new SpecificationUpstreamError(changed, true);
      patch(id, { routingRouteId: target.route.id, routingHealthKey: target.healthKey, channelId: target.channel.id,
        channelApiKeyId: target.channel.apiKeyId, upstreamModel: target.route.upstreamModel, actualModel: target.route.executionModel,
        actualChannel: target.channel.type, progressText: '正在提交生成任务' }, 'processing');
      onEvent({ type: 'status', message: '正在提交生成任务', contentId: id });
      let taskId = '';
      let claimed = false;
      let dispatchPrepared = false;
      let pollingStarted = false;
      try {
        if (target.channel.type !== 'zhiying' && !markBatchSubmitting(id)) throw fail('任务已停止', 409);
        taskId = await submitSpecificationVideo(target, metadata(id).kkLogicalRequestId ? { ...request, submissionKey: metadata(id).kkLogicalRequestId } : request, submissionMetadata => {
          if (target.channel.type === 'zhiying') {
            if (submissionMetadata?.zhiyingInitialTask) {
              const task = submissionMetadata.zhiyingInitialTask as { taskId: string };
              taskId = task.taskId;
              sqlite.transaction(() => {
                acceptVideoSubmission(id, taskId, { provider: 'zhiying', channelId: target.channel.id, channelApiKeyId: target.channel.apiKeyId });
                patch(id, submissionMetadata);
              }).immediate();
              return;
            }
            const changedRoute = unavailable();
            if (changedRoute) throw new SpecificationUpstreamError(changedRoute, false, false, false, 0, true);
            if (metadata(id).cancelledBeforeSubmission) throw new SpecificationUpstreamError('任务已取消，尚未向智赢发送生成请求', false, false, false, 0, true);
            try {
              assertZhiyingOriginalChannel(ChannelService.getChannelRaw(target.channel.id), { ...submissionMetadata, channelId: target.channel.id });
            } catch (error: any) { throw new SpecificationUpstreamError(error.message, false, false, false, 0, true); }
            try {
              sqlite.transaction(() => {
                if (!markBatchSubmitting(id)) throw fail('批量任务已提交或停止', 409);
                claimVideoSubmission(id, target.channel.timeout || 120_000);
                claimed = true;
                patch(id, { ...submissionMetadata, submissionStartedAt: new Date().toISOString() });
              }).immediate();
            } catch (error: any) {
              if (claimed) { releaseVideoSubmission(id); claimed = false; }
              throw new SpecificationUpstreamError(error.message, false, true);
            }
            dispatchPrepared = true;
            return;
          }
          if (!claimed) {
            try { claimVideoSubmission(id, target.channel.timeout || 120_000); claimed = true; }
            catch (error: any) { throw new SpecificationUpstreamError(error.message, false, true); }
          }
          if (isZonghengChannel(target.channel) && typeof submissionMetadata?.videoId === 'string') {
            taskId = submissionMetadata.videoId;
            acceptZonghengVideoReceipt(id, taskId, { channelId: target.channel.id, channelApiKeyId: target.channel.apiKeyId });
          }
          patch(id, { ...submissionMetadata, submissionStartedAt: new Date().toISOString() });
          dispatchPrepared = true;
        });
        acceptVideoSubmission(id, taskId, { provider: isSnumomWanChannel(target.channel) ? 'snumom' : target.channel.type || '',
          channelId: target.channel.id, channelApiKeyId: target.channel.apiKeyId });
        patch(id, { videoId: taskId, upstreamTaskId: taskId, progressKnown: false, progressText: '渠道已受理，正在查询任务状态', requiresReview: false });
        onEvent({ type: 'progress', progress: 0, progressKnown: false, message: '渠道已受理，正在查询任务状态', contentId: id });
        pollingStarted = true;
        await pollVideo(id, target.channel, taskId, onEvent);
      } catch (e: any) {
        const uncertain = Boolean(taskId) || e instanceof SpecificationUpstreamError && e.uncertain
          || dispatchPrepared && !(e instanceof SpecificationUpstreamError && (e.retrySafe || e.confirmedFailure));
        if (claimed && target.channel.type === 'zhiying' && !uncertain && e instanceof SpecificationUpstreamError && e.confirmedFailure) {
          // A crash between evidence and refund must never turn a rejected POST into a new generation.
          sqlite.transaction(() => {
            endVideoSubmission(id, 'rejected');
            patch(id, { zhiyingFailure: { message:e.message, httpStatus:e.upstreamStatus } });
          }).immediate();
        } else if (claimed) endVideoSubmission(id, uncertain ? 'unknown' : 'rejected');
        if (uncertain) {
          if (target.channel.type === 'zhiying' && !taskId) {
            patch(id, { zhiyingResumeAt: Date.now() + 8_000,
              ...(e instanceof SpecificationUpstreamError && e.upstreamStatus === 409 ? { zhiyingReplayStopped: true } : {}) });
          }
          const message = e.message + '；' + (taskId ? '原任务处理异常，请勿重复提交' : '提交结果待核实，请勿重复提交');
          noteRouteResult(target.healthKey, false, e.message); holdForReview(id, message, taskId ? pollingStarted ? 'query' : 'local' : 'submission'); onEvent({ type: 'status', message }); return;
        }
        throw e;
      } finally {
        if (claimed) releaseVideoSubmission(id);
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
  // Preserve the original per-route diagnostics for administrators. Public
  // response/event boundaries are responsible for projecting safe messages.
  const reasons = [...new Set<string>((metadata(id).routingAttempts || []).map((attempt: any) => attempt.reason).filter(Boolean))];
  const reason = reasons.length ? '所有候选线路均未完成提交：' + reasons.join('；') : '没有可用且满足参数的线路（未记录到提交尝试，请检查规格及渠道配置）';
  failTask(id, reason); onEvent({ type: 'error', message: reason });
}
async function runImages(id: number, candidates: RouteCandidate[], request: SpecificationRequest, req: Request, onEvent: (data: any) => void) {
  if (metadata(id).requestedModel === HUSS_MJ_MODEL) return runHussImages(id, candidates, request, req, onEvent);
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
            }, undefined, undefined, state => {
              const fallbacks = { ...(metadata(id).pidoiFallbacks || {}) };
              if (state.status === 'submitting' && fallbacks[index]) throw new SpecificationUpstreamError('备用已执行，请核对原任务', false, true);
              fallbacks[index] = { ...fallbacks[index], ...state, updatedAt: new Date().toISOString() };
              patch(id, { pidoiFallbacks: fallbacks, progressText: '正在使用异步备用生成' });
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
    if (uncertain) { onEvent({ type: 'error', message: (metadata(id).error || '') + '；部分图片任务待核实，已生成的图片保留，请勿重复提交' }); return; }
    if (!done) onEvent({ type: 'image_error', index, message: metadata(id).failureReason || '当前图片没有可用线路或生成失败' });
  }
  if (urls.length) { complete(id, urls); onEvent({ type: 'complete', imageUrls: urls, contentId: id }); }
  else { const reason = metadata(id).failureReason || '图片生成失败'; failTask(id, reason); onEvent({ type: 'error', message: reason }); }
}
function assertMjReservation(id: number) {
  const record = db.select().from(contents).where(eq(contents.id, id)).get();
  const meta = metadata(id);
  const reservation = sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(meta.billingReservationId) as any;
  if (!record || !reservation || !['reserved', 'review'].includes(reservation.state) || !Number.isFinite(reservation.amount)
    || reservation.amount !== meta.reservedCost) throw fail('原预扣费用已变更，请人工核对；本次未扣费', 409);
  const context = JSON.parse(reservation.context);
  if (context.contentId && context.contentId !== id || context.userId !== record.userId
    && !(meta.tokenId && context.tokenId === meta.tokenId)) throw fail('原预扣记录不匹配', 409);
  return record;
}

async function saveMjResults(id: number, channel: any, req: Request, onEvent: (data: any) => void) {
  assertMjReservation(id);
  const batch = metadata(id).nativeImageBatch as MjImageBatch;
  const persist = () => patch(id, { nativeImageBatch: batch, imageJobs: batch.jobs,
    imageUrls: batch.jobs.map(job => job.localUrl).filter(Boolean) });
  const urls = await saveMjImageBatch(batch, id, req, channel, persist,
    (imageUrl, index) => onEvent({ type: 'image_ready', imageUrl, index, total: batch.sourceUrls.length, contentId: id }));
  if (urls.length !== batch.sourceUrls.length) throw new Error('MJ 原图片尚未完整保存，需要核实原任务');
  sqlite.transaction(() => {
    // An administrator may resolve the held funds while a download is running.
    assertMjReservation(id);
    patch(id, { submissionStartedAt: null, error: null, failureReason: null });
    complete(id, urls);
  })();
  onEvent({ type: 'complete', imageUrls: urls, contentId: id });
}

/** Admin recovery of a verified original MJ result; never creates a task or a new charge. */
export async function recoverMjSpecificationImages(id: number, resultUrls: unknown, actorId: number, req: Request) {
  if (!Number.isSafeInteger(id) || id <= 0) throw fail('记录 ID 无效');
  const record = db.select().from(contents).where(eq(contents.id, id)).get();
  if (!record) throw fail('任务记录不存在', 404);
  const meta = metadata(id);
  if (record.type !== 'image' || meta.nativeImageOutputs !== 4) throw fail('仅支持 MJ 原任务');
  if (record.status === 'completed' && record.resultUrl) return { status: 'completed', alreadyRecovered: true, message: '原任务已经恢复，未重复扣费' };
  if (active.has(id) || !meta.requiresReview || !['queued', 'processing', 'review'].includes(record.status)) throw fail('原任务不处于待核实状态', 409);
  const channel = ChannelService.getChannelRaw(meta.channelId, meta.channelApiKeyId);
  if (!channel || !isMjChannel(channel)) throw fail('原 MJ 渠道不存在', 409);
  if (!Array.isArray(resultUrls) || !resultUrls.length || resultUrls.length > 4) throw fail('请填写原任务实际返回的图片下载地址（1–4 个）');
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
  const checkReservation = () => assertMjReservation(id);
  checkReservation();
  const batch = meta.nativeImageBatch as MjImageBatch | undefined;
  if (batch && JSON.stringify(batch.sourceUrls) !== JSON.stringify(sources)) throw fail('已记录原结果地址，请使用相同地址继续恢复', 409);
  active.add(id);
  try {
    patch(id, { nativeImageBatch: batch || { sourceUrls: sources, jobs: [] }, upstreamImageUrls: sources,
      mjRecovery: { actorId, startedAt: new Date().toISOString(), previousError: meta.error || null } });
    // Downloads may fail; settle only after every original image is available.
    const currentBatch = metadata(id).nativeImageBatch as MjImageBatch;
    await mediaOwnerContext.run(record.userId, () => saveMjImageBatch(currentBatch, id, req, channel, () => {
      patch(id, { nativeImageBatch: currentBatch, imageJobs: currentBatch.jobs });
    }, () => {}));
    const urls = currentBatch.jobs.map(job => job.localUrl).filter((url): url is string => Boolean(url));
    if (urls.length !== sources.length || urls.some(url => !url.startsWith('/api/uploads/'))) throw fail('原任务图片尚未完整保存，请使用相同地址重试', 502);
    sqlite.transaction(() => {
      checkReservation();
      complete(id, urls);
      patch(id, { error: null, failureReason: null, submissionStartedAt: null,
        mjRecovery: { ...metadata(id).mjRecovery, completedAt: new Date().toISOString() } });
    })();
    return { status: 'completed', message: '原任务完整图片已恢复，使用原预扣费用结算，未重复扣费' };
  } finally { active.delete(id); }
}

function recordMjAsyncState(id: number, state: MjAsyncImageState, onEvent: (data: any) => void) {
  patch(id, { mjAsyncImage: state, upstreamStatus: state.status,
    ...(state.progress !== undefined ? { progress: Math.min(99, state.progress) } : {}), progressText: '图片生成中' });
  onEvent({ type: 'progress', progress: Math.min(99, state.progress || 0), contentId: id });
}
function recordMjReceipt(id: number, evidence: import('./imageTaskMetadataService.js').ImageResponseEvidence) {
  patch(id, { upstreamResponses: [evidence],
    ...(evidence.id ? { upstreamTaskId: evidence.id, upstreamTaskIds: [evidence.id] } : {}) });
}
async function runMjImages(id: number, candidates: RouteCandidate[], request: SpecificationRequest, req: Request, onEvent: (data: any) => void) {
  let failureReason = 'MJ 图片生成失败';
  for (const target of candidates) {
    if (!isMjChannel(target.channel) || !routeStillEnabled(metadata(id).requestedModel, target, request.input) || !claimRouteProbe(target.healthKey)) continue;
    let accepted = false;
    let phase: 'submit' | 'save' = 'submit';
    const startedAt = Date.now();
    try {
      patch(id, { routingRouteId: target.route.id, routingHealthKey: target.healthKey, channelId: target.channel.id,
        channelApiKeyId: target.channel.apiKeyId, upstreamModel: target.route.upstreamModel, actualModel: target.route.executionModel,
        actualChannel: target.channel.type, upstreamTaskId: '', upstreamTaskIds: [], mjAsyncImage: null,
        upstreamResponses: [{ id: '', state: 'awaiting_response' }] });
      const result = await generateSpecificationImage(target, request,
        () => patch(id, { submissionStartedAt: new Date().toISOString() }),
        upstreamTaskId => { accepted = true; patch(id, { upstreamTaskId }); },
        evidence => recordMjReceipt(id, evidence),
        state => { accepted = true; recordMjAsyncState(id, state, onEvent); },
        () => { assertMjReservation(id); });
      accepted = true;
      const sourceUrls = 'imageUrls' in result && Array.isArray(result.imageUrls) ? result.imageUrls : [result.imageUrl];
      patch(id, { nativeImageBatch: { sourceUrls, jobs: [] }, upstreamImageUrls: sourceUrls });
      phase = 'save';
      await saveMjResults(id, target.channel, req, onEvent);
      noteRouteResult(target.healthKey, true); return;
    } catch (error: any) {
      // Never undo an administrator's reconciliation during a long-running query/save.
      try { assertMjReservation(id); } catch { return; }
      const httpStatus = error instanceof SpecificationUpstreamError ? error.upstreamStatus : 0;
      const diagnosticPhase = phase === 'submit' && metadata(id).mjAsyncImage ? 'poll' : phase;
      patch(id, { mjSubmissionDiagnostics: { phase: diagnosticPhase, elapsedMs: Math.max(0, Date.now() - startedAt), finishedAt: new Date().toISOString(),
        ...(httpStatus ? { httpStatus } : {}),
        reason: diagnosticPhase === 'save' ? 'result_save' : diagnosticPhase === 'poll' ? 'async_query' : [502, 504, 524].includes(httpStatus) ? 'gateway_timeout'
          : error instanceof SpecificationUpstreamError && error.uncertain ? 'response_uncertain' : 'submission_rejected' } });
      if (accepted && error instanceof SpecificationUpstreamError && error.confirmedFailure) {
        patch(id, { requiresReview: false, submissionStartedAt: null });
        failTask(id, error.message); onEvent({ type: 'error', message: error.message }); return;
      }
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
/** Image receipts have their own protocol: never replay an ambiguous image POST. */
async function runHussImages(id: number, candidates: RouteCandidate[], request: SpecificationRequest, req: Request, emit: (data: any) => void) {
  const target = candidates.find(t => isHussChannel(t.channel) && t.route.upstreamModel === HUSS_MJ_MODEL && routeStillEnabled(HUSS_MJ_MODEL, t, request.input));
  if (!target) { failTask(id, 'Midjourney V8.2 没有可用 HUSS 线路'); return; }
  patch(id, { hussImage: true, channelId: target.channel.id, channelApiKeyId: target.channel.apiKeyId,
    upstreamModel: target.route.upstreamModel, actualModel: HUSS_MJ_MODEL, actualChannel: 'huss',
    submissionStartedAt: new Date().toISOString(), hussImageOptions: hussMjOptions(request.body) }, 'processing');
  try {
    const task = await submitHussImage(target.channel, { ...request.body, prompt:request.prompt,
      resolution:request.input.resolution, aspect_ratio:request.input.ratio }, request.images,
      upstreamTaskId => patch(id, { upstreamTaskId, upstreamTaskIds:[upstreamTaskId], submissionStartedAt:null }));
    patch(id, { hussImageInitial: task });
  } catch (error: any) {
    if (metadata(id).upstreamTaskId) {
      patch(id, { upstreamQueryError:error.message, hussImageResumeAt:Date.now()+5000 });
    } else if (error instanceof HussImageError && error.rejected) {
      failTask(id, error.message); emit({type:'error', message:error.message}); return;
    } else { holdForReview(id, error.message, 'submission'); emit({type:'error', message:error.message}); return; }
  }
  await continueHussImages(id, req, emit);
  if (db.select().from(contents).where(eq(contents.id,id)).get()?.status === 'processing') emit({type:'status',status:metadata(id).upstreamGenerated ? 'saving' : 'processing',background:true,contentId:id,message:metadata(id).progressText || '图片正在后台处理'});
}
async function continueHussImages(id: number, req: Request, emit: (data: any) => void) {
  const record = assertMjReservation(id);
  const m = metadata(id), channel = ChannelService.getChannelRaw(m.channelId, m.channelApiKeyId || null);
  if (!channel || !isHussChannel(channel)) { holdForReview(id, '原 HUSS 图片渠道不存在', 'query'); return; }
  let phase = 'query';
  try {
    const cached = m.nativeImageBatch as MjImageBatch | undefined;
    // A fully saved batch only needs local settlement. Do not depend on an upstream
    // query remaining available after all original candidates have been delivered.
    if (cached?.sourceUrls.length && cached.jobs.length === cached.sourceUrls.length && cached.jobs.every(job => job.localUrl)) {
      phase = 'save';
      await mediaOwnerContext.run(record.userId, () => saveMjResults(id, channel, req, emit));
      patch(id, {resultSaveError:null,upstreamQueryError:null,hussImageResumeAt:null,hussImageStopped:false});
      return;
    }
    let queryError: string | null = null;
    let task = m.hussImageInitial || await queryHussImage(channel, m.upstreamTaskId).catch(error => {
      if (cached?.sourceUrls?.length) {
        queryError = error.message;
        return {id:m.upstreamTaskId,status:'completed',urls:cached.sourceUrls,delay:30000,generated:true};
      }
      throw error;
    });
    // Once completion is evidenced, a later status regression/expiry must not
    // prevent trying already recorded original result URLs or cause a refund.
    if (cached?.sourceUrls.length && (task.status !== 'completed' || task.resultError)) {
      queryError = task.error || task.resultError || '上游原任务状态变为 ' + task.status + '，继续恢复已生成图片';
      task = {id:m.upstreamTaskId,status:'completed',urls:cached.sourceUrls,delay:30000,generated:true};
    }
    patch(id, { hussImageInitial:null, upstreamStatus:task.generated ? 'completed' : task.status,
      ...(task.generated ? {upstreamGenerated:true} : {}), lastQueryAt:new Date().toISOString(),
      upstreamQueryError:queryError, hussImageResumeAt:Date.now()+task.delay });
    if (task.status === 'expired') {
      patch(id, {hussImageStopped:true});
      holdForReview(id,task.error || '上游图片结果已过期，需要核实原任务交付', 'local');
      return;
    }
    if (['failed','cancelled'].includes(task.status)) {
      if (m.upstreamGenerated) throw new Error(task.error || '上游已生成图片，后续状态不一致，正在查询原结果');
      failTask(id, task.error); emit({type:'error',message:task.error}); return;
    }
    if (task.status !== 'completed') {
      patch(id, { progressText:task.generated || m.upstreamGenerated ? '图片已生成，等待上游保存结果' : '图片生成中' }); return;
    }
    phase = 'save';
    if (task.resultError || !task.urls.length) throw new Error(task.resultError || '上游已生成图片，尚未提供结果地址');
    const previous = m.nativeImageBatch as MjImageBatch | undefined;
    if (previous && previous.sourceUrls.length !== task.urls.length) throw new Error('原图片候选数量发生变化，保留已保存结果等待核实');
    const jobs = previous?.jobs || [];
    // Refresh signed URLs from the original task; retain successfully saved candidates by index.
    const batch = { sourceUrls:task.urls, jobs:task.urls.map((sourceUrl: string,index: number) => ({
      index,sourceUrl,status:jobs[index]?.localUrl ? 'completed' as const : 'saving' as const, localUrl:jobs[index]?.localUrl })) };
    patch(id, { nativeImageBatch:batch, upstreamImageUrls:task.urls, upstreamGenerated:true,
      requiresReview:false, reviewKind:null, error:null, progressText:'图片已生成，正在保存', progress:99 }, 'processing');
    emit({type:'status',status:'saving',message:'图片已生成，正在保存',contentId:id});
    phase = 'save';
    await mediaOwnerContext.run(record.userId, () => saveMjResults(id, channel, req, emit));
    patch(id, { resultSaveError:null, upstreamQueryError:null, hussImageResumeAt:null });
  } catch (error: any) {
    try { assertMjReservation(id); } catch { return; }
    const reason = transportDiagnostic('HUSS Midjourney', phase === 'save' ? '原图片保存' : '原图片查询', error, channel.apiKey);
    patch(id, { [phase === 'save' ? 'resultSaveError' : 'upstreamQueryError']:reason,
      progressText:metadata(id).upstreamGenerated ? '图片已生成，保存暂时失败，正在重试' : '查询暂时失败，正在重试原任务',
      hussImageResumeAt:Date.now()+30000, requiresReview:false, reviewKind:null }, 'processing');
  } finally { scheduleHussImage(id); }
}
const hussImageTimers = new Map<number, ReturnType<typeof setTimeout>>();
function scheduleHussImage(id: number) {
  if (hussImageTimers.has(id)) return;
  const row = db.select().from(contents).where(eq(contents.id,id)).get();
  if (!row || row.status !== 'processing') return;
  const m = metadata(id);
  if (m.hussImageStopped) return;
  const timer = setTimeout(() => {
    hussImageTimers.delete(id);
    const row = db.select().from(contents).where(eq(contents.id,id)).get();
    if (!row || row.status !== 'processing') return;
    if (active.has(id)) { scheduleHussImage(id); return; }
    const meta = metadata(id);
    if (Number(meta.hussImageResumeAt || 0) > Date.now()) { scheduleHussImage(id); return; }
    const req = { protocol:new URL(meta.publicBaseUrl).protocol.slice(0,-1),get:() => new URL(meta.publicBaseUrl).host } as unknown as Request;
    active.add(id);
    void continueHussImages(id,req,() => {}).catch((e:any) => holdForReview(id,e.message,'local')).finally(() => active.delete(id));
  }, Math.max(1000,Number(m.hussImageResumeAt || 0)-Date.now()));
  timer.unref?.(); hussImageTimers.set(id,timer);
}

type ApiContext = { token: any; reserve: (amount: number, model: string, pricingSnapshot?: PricingSnapshot) => any };
export async function handleSpecificationGeneration(req: Request, res: Response, kind: MediaKind, apiContext?: ApiContext): Promise<boolean> {
  let suppliedId: string;
  try { suppliedId = typeof req.body?.model === 'string' ? resolvePublicModelId(req.body.model, req.body) : ''; }
  catch (error: any) { res.status(error.status || 400).json({ error:error.message }); return true; }
  if (isRetiredVideoModel(suppliedId)) { res.status(410).json({ error:RETIRED_VIDEO_MODEL_MESSAGE }); return true; }
  const spec = getModelSpecification(suppliedId);
  if (!spec && isZhiyingVideoModel(suppliedId)) {
    res.status(503).json({ error: '智赢视频缺少模型规格与原渠道映射，请先同步渠道模型' }); return true;
  }
  const modelId = spec?.modelId || suppliedId;
  if (!spec && bbHssKkManaged(sqlite,suppliedId)) {
    res.status(503).json({error:'BB/HSS 的规格配置缺失，请在后台恢复对应规格；未提交或扣费'});return true;
  }
  if (isSiYueTianManagedVideoModel(suppliedId) && !spec) {
    res.status(503).json({ error: '四月天视频尚未关联模型规格与渠道，请在后台同步该渠道模型' }); return true;
  }
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
    const body = { ...req.body };
    if (kind === 'video') normalizeVideoParameters(body, videoCapabilities(modelId, spec).parameterSchema, Boolean(req.is?.('multipart/form-data')));
    if (isZhiyingVideoModel(modelId)) {
      body.model = modelId;
      try { normalizeZhiyingRequest(body, spec.limits.defaultSeconds); } catch (error: any) { throw fail(error.message); }
    }
    body.aspect_ratio = body.aspect_ratio || body.ratio || (spec.limits.ratios.includes(kind === 'image' ? '1:1' : '16:9') ? (kind === 'image' ? '1:1' : '16:9') : spec.limits.ratios[0]);
    const files = Array.isArray(req.files) ? req.files : [];
    const fields: Record<string, string[]> = { reference_images: ['image', 'image[]', 'images', 'input_reference[]', 'reference_images'], reference_videos: ['video', 'video[]', 'videos', 'reference_video', 'reference_videos'], audio_urls: ['audio', 'audio[]', 'audios', 'audio_urls'], first_frame: ['first_frame', 'first_frame_url'], last_frame: ['last_frame', 'last_frame_url'] };
    for (const file of files) {
      const field = Object.keys(fields).find(key => fields[key].includes(file.fieldname));
      if (!field) throw fail('不支持的上传字段：' + file.fieldname);
      if (isZhiyingVideoModel(modelId) && field.endsWith('_frame')) throw fail('该型号不支持独立首尾帧，请使用普通参考图');
      const expected = field === 'reference_videos' ? 'video/' : field === 'audio_urls' ? 'audio/' : 'image/';
      if (!file.mimetype.startsWith(expected)) throw fail('上传素材类型与字段不一致');
      const data = 'data:' + file.mimetype + ';base64,' + (file.buffer || fs.readFileSync(file.path)).toString('base64');
      if (field.endsWith('_frame')) { if (body[field]) throw fail('首尾帧不能重复传入'); body[field] = data; }
      else { const values = list(body, field === 'reference_images' ? ['reference_images', 'image_urls', 'image_url', 'images'] : field === 'reference_videos' ? ['reference_videos', 'reference_video', 'video_urls', 'video_url'] : ['audio_urls', 'audio_url']);
        for (const key of field === 'reference_images' ? ['image_urls','image_url','images'] : field === 'reference_videos' ? ['reference_video','video_urls','video_url'] : ['audio_url','reference_audios','audios']) delete body[key];
        body[field] = [...values, data]; }
    }
    const nativeImageOutputs = kind === 'image' ? modelId === MJ_MODEL_ID ? 4 : modelId === HUSS_MJ_MODEL ? 1 : undefined : undefined;
    if (modelId === HUSS_MJ_MODEL) {
      if (req.is?.('multipart/form-data') && ['true','false'].includes(body.tile)) body.tile = body.tile === 'true';
      if (body.n !== undefined && Number(body.n) !== 1) throw fail('Midjourney V8.2 每次只能提交一次生成');
      try { hussMjOptions(body); } catch (e: any) { throw fail(e.message); }
    }
    if (kind === 'video' && modelId === V6K_FULL_720_MODEL) {
      body.model = modelId;
      try { normalizeFull720VideoInput(body); } catch (error: any) { throw fail(error.message); }
    }
    if (nativeImageOutputs && body.n !== undefined && ![1, 4].includes(Number(body.n))) throw fail('MJ 每次仅提交一次任务，图片数量以上游实际结果为准');
    const request = specificationRequest({ ...body, ...(nativeImageOutputs ? { n: nativeImageOutputs } : {}), resolution: body.resolution || body.output_resolution || spec.limits.resolutions[0], video_length: body.video_length ?? body.seconds ?? body.duration ?? (modelId === SNUMOM_WAN_NSFW_MODEL ? body.parameters?.duration ?? body.duration_seconds : undefined) ?? (model.provider === 'megaby' ? 5 : spec.limits.duration.mode === 'fixed' ? spec.limits.duration.min : spec.limits.duration.mode === 'options' ? spec.limits.duration.values[0] : spec.limits.duration.min) }, kind, process.env.BACKEND_URL || req.protocol + '://' + req.get('host'));
    let snumomBilling: Awaited<ReturnType<typeof prepareSnumomNsfwReferences>> | undefined;
    if (isZhiyingVideoModel(modelId)) request.ownerId = userId;
    try { snumomBilling = kind === 'video' && isSnumomWanVideoModel(modelId) ? await prepareSnumomNsfwReferences(request) : undefined; }
    catch(error:any) { throw fail(error.message); }
    const mismatch = routingMismatches(spec.limits, request.input, kind);
    if (mismatch.length) throw fail(mismatch.join('；'));
    request.input.resolution = spec.limits.resolutions.find(r => r.toLowerCase() === request.input.resolution.toLowerCase()) || request.input.resolution;
    const candidates = selectModelRoutes(spec, request.input);
    if (!candidates.length) throw fail(modelAvailabilityMessage(specificationAvailability(spec)) || '该规格暂时没有满足参数的可用线路', 503);
    if (kind === 'video') { try { validateSpecificationVideoParameters(request, candidates); } catch (error: any) { throw fail(error.message); } }
    if (snumomBilling && !candidates.every(t => isSnumomWanChannel(t.channel) && t.route.upstreamModel === modelId && t.route.executionModel === modelId)) throw fail('Wan 3.0 必须关联对应型号的 snumom 线路，未扣费');
    if (kind === 'video' && candidates.every(target => isMegabyChannel(target.channel))) {
      try {
        if (body.first_image !== undefined || body.last_image !== undefined) throw new Error('Megaby 暂不支持独立首尾帧');
        for (const target of candidates) validateMegabyVideoInput({ ...request, model: target.route.upstreamModel,
          seconds: request.input.seconds, ratio: request.input.ratio, resolution: request.input.resolution });
        await validateMegabyReferenceDurations(request.videos, request.audios);
      }
      catch (error: any) { throw fail(error.message); }
    }
    const trustedOrigins = [request.publicBaseUrl, req.protocol + '://' + req.get('host')];
    await prepareSpecificationReferenceImages(request, kind === 'video' ? candidates : [], trustedOrigins);
    const batch = !apiContext && kind === 'video' ? batchContextForRequest(req as any) : null;
    const usage = { resolution: request.input.resolution, seconds: snumomBilling?.billableSeconds ?? request.input.seconds, count: nativeImageOutputs ? 1 : request.input.outputs };
    const quote = batch?.pricingSnapshot ? { ...PricingService.quoteSnapshot(batch.pricingSnapshot, usage), pricingSnapshot: batch.pricingSnapshot }
      : PricingService.quote(modelId, usage, false, userId || null);
    if (!quote.billingType) throw fail('该规格尚未配置用户售价');
    if ((modelId === SNUMOM_MUSE_MODEL || candidates.some(t=>t.route.upstreamModel===SNUMOM_MUSE_MODEL)) && quote.billingType !== 'per_call') throw fail('Muse Video 需配置按次售价，本次未扣费');
    if (nativeImageOutputs && quote.billingType !== 'per_call') throw fail('MJ 图片任务请配置按次售价，完整保留原结果');
    if (kind === 'video') {
      if (!['per_call', 'per_second'].includes(quote.billingType)) throw fail('视频用户售价必须按条或按秒配置');
      if (!batch) assertExpectedVideoCost(body, quote.cost);
    }
    if (snumomBilling && quote.billingType !== 'per_second') throw fail('Wan 3.0 NSFW 需配置按秒售价，本次未扣费');
    if (req.path === '/validate' && snumomBilling) return res.json({unitCost:quote.cost,resolution:request.input.resolution,reference_images:request.images,first_frame:request.firstFrame,last_frame:request.lastFrame,pricingSnapshot:quote.pricingSnapshot}), true;
    if (snumomBilling && batch && Math.abs(quote.cost-batch.item.unit_cost)>0.000001) throw fail('参考视频或计费用量已变化，请重新预估批次，本次未提交上游');
    const create = () => ContentService.save({ userId, orgId: (req as any).orgId || null, type: kind, modelId,
      title: request.prompt.slice(0, 200), inputText: request.prompt, status: 'queued', cost: batch ? 0 : quote.cost,
      metadata: { managedSpecification: true, requestedModel: modelId, model: modelId, count: request.input.outputs, nativeImageOutputs,
        ...(isZhiyingVideoModel(modelId) ? { zhiyingOrder: true } : {}),
        ...(modelId === KK_VIDEO_MODEL ? { kkLogicalRequestId: randomUUID() } : {}),
        ...snumomBilling,
        ...(kind === 'video' ? videoSubmissionPreparation() : {}),
        pricingSnapshot: quote.pricingSnapshot,
        seconds: request.input.seconds, resolution: request.input.resolution, aspect_ratio: request.input.ratio,
        reference_images: request.images, reference_videos: request.videos, audio_urls: request.audios,
        first_frame: request.firstFrame, last_frame: request.lastFrame, queueUserKey: token ? 'token:' + token.id : 'user:' + userId,
        tokenId: token?.id, billingSource: token ? 'api' : 'user', publicBaseUrl: request.publicBaseUrl, startedAt: Date.now(), imageUrls: [], routingAttempts: [],
        ...(batch ? { batchId: batch.batch.id, batchItemId: batch.item.id, batchAttempt: batch.item.attempts, batchReservedAmount:batch.item.unit_cost, reservedCost:batch.item.unit_cost, billingStatus: 'batch_reserved' } : {}) } });
    let charge: any;
    sqlite.transaction(() => {
      id = batch ? batchStore.attach(batch.item.id, batch.item.attempts, userId, create) : create();
      if (apiContext && kind === 'video') linkApiVideoRequest(req, id!);
      if (!batch) {
        charge = apiContext ? apiContext.reserve(quote.cost, modelId, quote.pricingSnapshot) : reserveUserCharge(userId, quote.cost, 'specification_generate', { contentId: id, model: modelId, pricingSnapshot: quote.pricingSnapshot });
        linkReservationContent(charge.id, id!);
        patch(id!, { billingReservationId: charge.id, reservedCost: quote.cost, billingStatus: 'reserved' });
      }
    })();
    const emit = (data: any) => {
      if (apiContext) return;
      const current = db.select().from(contents).where(eq(contents.id, id!)).get();
      const event = publicGenerationEvent({ ...data, ...(kind === 'video' ? { canCancel: canCancelVideoContent(current) } : {}) });
      if (isZhiyingVideoModel(modelId) && typeof event.message === 'string' && current)
        event.message = publicZhiyingDiagnostic(event.message, JSON.parse(current.metadata || '{}'));
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
      catch (e: any) { handleUnexpectedGenerationError(id!, e.message || '任务处理异常'); emit({ type: kind === 'video' ? 'status' : 'error', message: '请在生成记录查看任务状态' }); }
      finally {
        active.delete(id!);
        if (apiContext) { const record = db.select().from(contents).where(eq(contents.id, id!)).get();
          if (record) { const meta = JSON.parse(record.metadata); try { db.insert(apiLogs).values({ tokenId: token.id, channelId: meta.channelId, model: modelId, upstreamModel: meta.upstreamModel, cost: record.cost, status: record.status === 'completed' ? 'success' : 'error', errorMessage: record.status === 'completed' ? null : meta.error || meta.upstreamQueryError || null, durationMs: Date.now() - meta.startedAt }).run(); } catch (error: any) { console.warn('[specification] api log failed', id, error.message); } }
        }
      }
    };
    if (apiContext && kind === 'video') {
      void run();
      res.json({ id: 'task_' + id, task_id: 'task_' + id, object: 'video', model: publicApiModelId(modelId), status: 'queued', progress: 0,
        status_url: req.protocol + '://' + req.get('host') + '/v1/videos/task_' + id });
    } else {
      await run();
      if (apiContext) {
        const row = db.select().from(contents).where(eq(contents.id, id!)).get()!, meta = JSON.parse(row.metadata);
        if (meta.hussImage && row.status === 'processing' && meta.upstreamTaskId) res.status(202).json({id:'task_'+id, task_id:'task_'+id, status:'processing', status_url:request.publicBaseUrl+'/v1/images/tasks/task_'+id});
        else if (row.status !== 'completed') res.status(meta.requiresReview ? 202 : 502).json({ id: 'task_' + id, status: row.status, requires_review: Boolean(meta.requiresReview), error: publicGenerationError((meta.error || meta.upstreamQueryError || '生成失败') + (meta.requiresReview ? '；提交结果待核实，请勿重复提交' : '')) });
        else res.json({ created: Math.floor(Date.now() / 1000), data: meta.imageUrls.map((url: string) => (request.body.response_format === 'b64_json' ? { b64_json: fs.readFileSync(path.join('data/uploads', path.basename(url))).toString('base64') } : { url: issueUploadUrl(url, request.publicBaseUrl) })) });
      } else if (!res.writableEnded && !res.destroyed) res.end('data: [DONE]\n\n');
    }
    return true;
  } catch (e: any) {
    if (id) handleUnexpectedGenerationError(id, e.message);
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
    const record = assertMjReservation(id);
    const channel = ChannelService.getChannelRaw(initial.channelId, initial.channelApiKeyId || null);
    if (!channel) { holdForReview(id, 'MJ 原渠道已删除，请管理员核实'); return; }
    await mediaOwnerContext.run(record.userId, () => saveMjResults(id, channel, req, () => {})); return;
  }

  if (initial.nativeImageOutputs === 4 && initial.mjAsyncImage) {
    const record = assertMjReservation(id);
    const channel = ChannelService.getChannelRaw(initial.channelId, initial.channelApiKeyId || null);
    if (!channel || !isMjChannel(channel)) { holdForReview(id, 'MJ 原渠道已删除，请管理员核实'); return; }
    try {
      const result = await pollMjSpecificationImage(channel, initial.mjAsyncImage,
        upstreamTaskId => patch(id, { upstreamTaskId, upstreamTaskIds: [upstreamTaskId] }),
        evidence => recordMjReceipt(id, evidence), state => recordMjAsyncState(id, state, () => {}),
        () => { assertMjReservation(id); });
      patch(id, { nativeImageBatch: { sourceUrls: result.imageUrls, jobs: [] }, upstreamImageUrls: result.imageUrls });
      await mediaOwnerContext.run(record.userId, () => saveMjResults(id, channel, req, () => {}));
      noteRouteResult(initial.routingHealthKey, true);
    } catch (error: any) {
      try { assertMjReservation(id); } catch { return; }
      if (error instanceof SpecificationUpstreamError && error.confirmedFailure) {
        patch(id, { requiresReview: false, submissionStartedAt: null }); failTask(id, error.message);
      } else holdForReview(id, error.message || 'MJ 原任务结果待核实');
    }
    return;
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
          if (result.status === 'failed') { job.status = 'failed'; job.error = result.error || '图片生成失败'; noteRouteResult(job.healthKey, false, job.error, false, true); continue; }
          if (result.status !== 'completed' || !result.imageUrl) { pending = true; continue; }
          job.sourceUrl = result.imageUrl; patch(id, { imageJobs: jobs });
        }
        const { localizeGeneratedImage } = await import('../routes/imageGen.js');
        job.localUrl = await localizeGeneratedImage(job.sourceUrl, 'spec_image_' + id + '_' + job.index, req, channel, { relative: true });
        job.status = 'completed'; noteRouteResult(job.healthKey, true);
      } catch (error: any) {
        pending = true;
        const message = transportDiagnostic(channel.type || 'OpenAI-compatible', '图片恢复查询或保存 task_id=' + job.taskId + '；请勿重复提交', error, channel.apiKey);
        job.queryError = message; patch(id, { upstreamQueryError: message, progressText: message });
      }
    }
    const urls = jobs.filter(j => j.status === 'completed').sort((a,b) => a.index - b.index).map(j => j.localUrl);
    patch(id, { imageJobs: jobs, imageUrls: urls });
    if (!pending) {
      if (initial.submissionStartedAt && !jobs.some(j => j.index === initial.imageSubmissionIndex)) { holdForReview(id, '有一张图片的提交结果仍待核实，请勿重提'); return; }
      if (urls.length) complete(id, urls); else failTask(id, jobs.map(j => j.error).filter(Boolean).join('；') || '图片生成失败'); return;
    }
    await wait(8000);
  }
  holdForReview(id, '图片原任务仍在处理中，请勿重复提交');
}

/** Repair only the identifiable old crop when its original local file still exists. */
export function restoreLegacyMjCompletedImages(): number {
  const rows = sqlite.prepare("SELECT id,metadata FROM contents WHERE type='image' AND status='completed' AND CASE WHEN json_valid(metadata) THEN json_array_length(metadata,'$.nativeImageBatch.sourceUrls')=1 AND json_array_length(metadata,'$.nativeImageBatch.jobs')=4 END").all() as { id: number; metadata: string }[];
  let restored = 0;
  for (const row of rows) {
    const meta = JSON.parse(row.metadata), batch = meta.nativeImageBatch as MjImageBatch;
    if (meta.nativeImageOutputs !== 4) continue;
    const original = restoreCachedMjOriginal(batch);
    if (!original) continue;
    const previousImageUrls = meta.imageUrls;
    Object.assign(meta, { nativeImageBatch: batch, imageJobs: batch.jobs, imageUrls: [original], count: 1, progresses: [100],
      mjRecovery: { ...meta.mjRecovery, originalRestoredAt: new Date().toISOString(), previousImageUrls } });
    sqlite.prepare('UPDATE contents SET result_url=?,metadata=? WHERE id=? AND status=\'completed\'').run(original, JSON.stringify(meta), row.id);
    restored++;
  }
  if (restored) console.log('[mj-original-repair] Restored original images for ' + restored + ' tasks; billing unchanged');
  return restored;
}

async function resumeHussReceipt(id: number, channel: any, key: string) {
  const before = metadata(id);
  if (before.videoId || before.upstreamTaskId) return;
  if ([before.upstreamModel, before.actualModel, before.requestedModel].some(isHussPersistentVideoModel) && !isHussPersistentVideoModel(before.hussPayload?.model)) throw new Error('HUSS 异步原请求快照缺失，未发送请求');
  let receipt;
  try { receipt = await recoverHussSubmission(channel, key, before.hussPayload); }
  catch (error: any) {
    patch(id, { hussReceiptRetryAt: Date.now() + Math.max(60_000, Number(error?.retryAfterMs) || 0) });
    throw error;
  }
  const row = db.select().from(contents).where(eq(contents.id, id)).get();
  if (!row || !['queued','processing','review'].includes(row.status)) return;
  const meta = metadata(id);
  if (meta.videoId || meta.hussIdempotencyKey !== key) return;
  if (receipt.state === 'accepted') {
    try { acceptVideoSubmission(id, receipt.taskId, { provider: 'huss', channelId: channel.id, channelApiKeyId: channel.apiKeyId }); }
    catch (error: any) {
      holdForReview(id, transportDiagnostic('HUSS', '已受理任务凭据保存异常，保留原任务核查', error, channel.apiKey), 'local');
      return;
    }
    patch(id, { ...('initialTask' in receipt ? { hussInitialTask: receipt.initialTask } : {}), error: null, progressText: '已从 HUSS 原提交回执找回任务，正在查询结果' });
    await pollVideo(id, channel, receipt.taskId, () => {});
  } else if (receipt.state === 'rejected') {
    endVideoSubmission(id, 'rejected');
    failTask(id, receipt.error);
  } else if (receipt.state === 'pending') {
    patch(id, { requiresReview: false, reviewKind: null, error: null, progressText: 'HUSS 原提交仍在处理，正在自动核对回执，请勿重复提交' }, 'processing');
  } else {
    holdForReview(id, receipt.error);
  }
}

// Never replay against a replaced or already settled reservation, including a batch retry.
function assertZhiyingReservation(id: number, meta: Record<string, any>) {
  const row = db.select().from(contents).where(eq(contents.id, id)).get();
  if (!row || !['processing','review','queued'].includes(row.status) || meta.queueRefunded || meta.refundPending || meta.billingShortfall
    || ['settled','charged','refunded'].includes(meta.billingStatus)) throw new Error('原订单已结束或费用待核对，停止恢复智赢任务');
  if (meta.batchItemId) {
    const item = batchStore.item(meta.batchItemId);
    if (!item || item.content_id !== id || item.user_id !== row.userId || item.attempts !== meta.batchAttempt || item.billing_state !== 'reserved'
      || !['running','review'].includes(item.status) || item.unit_cost !== meta.batchReservedAmount) throw new Error('批量原订单或预扣已改变，停止恢复智赢任务');
  } else {
    const reservation = sqlite.prepare('SELECT state,amount,context FROM billing_reservations WHERE id=?').get(meta.billingReservationId || '') as any;
    const context = reservation && JSON.parse(reservation.context);
    if (!context || !['reserved','review'].includes(reservation.state) || reservation.amount !== meta.reservedCost
      || Number(context.contentId) !== id || Number(context.userId) !== Number(row.userId)
      || Number(context.tokenId || 0) !== Number(meta.tokenId || 0)) throw new Error('智赢原订单、预扣金额或归属不匹配，停止恢复');
  }
}

async function resumeZhiyingOrder(id: number) {
  const meta = metadata(id);
  assertZhiyingReservation(id, meta);
  const receipt = findVideoSubmissionReceipt(id);
  const taskId = meta.videoId || meta.upstreamTaskId || receipt?.upstreamTaskId;
  if (receipt && (receipt.upstreamTaskId !== taskId || receipt.channelId !== meta.channelId || receipt.provider !== 'zhiying')) {
    throw new Error('智赢已保存的任务回执与订单不一致，请核对原记录');
  }
  if (meta.zhiyingFailure?.message && (meta.zhiyingFailure.taskId ? meta.zhiyingFailure.taskId === taskId : !taskId && meta.videoSubmissionState === 'rejected')) {
    failTask(id, meta.zhiyingFailure.message); return;
  }
  if (meta.zhiyingFailure || meta.videoSubmissionState === 'rejected') throw new Error('智赢拒绝回执与原订单不一致，保留原单核对');
  // The claim and frozen payload commit together before the first paid POST.
  if (!taskId && !meta.zhiyingKey && !meta.submissionStartedAt && meta.videoSubmissionState === 'preparing') {
    failTask(id, '服务重启时仍在准备智赢请求，尚未发送生成任务'); return;
  }
  const channel = ChannelService.getChannelRaw(Number(meta.channelId));
  assertZhiyingOriginalChannel(channel, meta);
  if (taskId) {
    patch(id, { videoId: taskId, error: null, requiresReview: false, reviewKind: null }, 'processing');
    await pollVideo(id, channel, taskId, () => {}); return;
  }
  if (!meta.zhiyingKey || !meta.zhiyingPayload || meta.zhiyingPayload.model !== meta.upstreamModel
    || zhiyingPayloadHash(meta.zhiyingKey, meta.zhiyingPayload) !== meta.zhiyingPayloadHash)
    throw new Error('智赢原请求快照或幂等键缺失或不一致，无法安全恢复原提交');
  if (meta.zhiyingReplayStopped) throw new Error(meta.error || '智赢原提交需要核对，已停止自动重放');
  // The upstream documents same-key retries but gives no retention period.
  // Only recent lost acknowledgements get automatic replay; known IDs are GET-only at any age.
  const replayClaim = sqlite.transaction(() => {
    const latest = metadata(id);
    assertZhiyingReservation(id, latest);
    const now = Date.now();
    if (latest.videoId || latest.upstreamTaskId || findVideoSubmissionReceipt(id) || Number(latest.zhiyingReplayLeaseUntil || 0) > now) return false;
    const sentAt = Date.parse(latest.submissionStartedAt || '');
    const count = Number(latest.zhiyingReplayCount || 0);
    if (!Number.isFinite(sentAt) || now < sentAt || now - sentAt > 10 * 60_000 || !Number.isSafeInteger(count) || count < 0 || count >= 3) {
      patch(id, { zhiyingReplayStopped:true });
      return 'stopped';
    }
    patch(id, { zhiyingReplayCount:count + 1, zhiyingReplayLeaseUntil:now + Math.max(120_000, Number(channel!.timeout) || 0) + 30_000 });
    return true;
  }).immediate();
  if (!replayClaim) return;
  if (replayClaim === 'stopped') throw new Error('智赢原提交仍无任务编号，已达到本站自动核对范围（首次发送后10分钟内、最多3次同键恢复）；保留预扣，请核实原单');
  let original;
  try { original = await createZhiyingVideo(channel!, meta.zhiyingPayload, meta.zhiyingKey); }
  finally { patch(id, { zhiyingReplayLeaseUntil: null }); }
  sqlite.transaction(() => {
    assertZhiyingReservation(id, metadata(id));
    acceptVideoSubmission(id, original.taskId, { provider:'zhiying', channelId:channel!.id, channelApiKeyId:channel!.apiKeyId });
    patch(id, { zhiyingInitialTask: original, error: null, reviewKind: null, requiresReview: false });
  }).immediate();
  await pollVideo(id, channel, original.taskId, () => {});
}

function scheduleZhiyingRecovery(id: number) {
  active.add(id);
  patch(id, { zhiyingResumeAt: Date.now() + 60_000 });
  void resumeZhiyingOrder(id).catch((error: any) => {
    const meta = metadata(id);
    // A rejection of the recovery call is not proof that the original POST was rejected.
    const hasId = Boolean(meta.videoId || meta.upstreamTaskId);
    if (!hasId && Number(error?.status) === 409) patch(id, { zhiyingReplayStopped: true });
    holdForReview(id, error.message, hasId ? 'query' : 'submission');
  }).finally(() => active.delete(id));
}

export function resumeSpecificationTasks() {
  restoreLegacyMjCompletedImages();
  for (const row of db.select().from(contents).where(inArray(contents.status, ['processing', 'queued', 'review'])).all()) {
    let meta: any; try { meta = JSON.parse(row.metadata || '{}'); } catch { continue; }
    if (!meta.managedSpecification || active.has(row.id)) continue;
    if (row.type === 'image' && meta.hussImage && meta.upstreamTaskId) {
      if (meta.hussImageStopped && !meta.nativeImageBatch?.sourceUrls?.length) continue;
      if (meta.hussImageStopped) patch(row.id,{hussImageStopped:false});
      if (Number(meta.hussImageResumeAt || 0) > Date.now()) continue;
      try { assertMjReservation(row.id); } catch { continue; }
      const req = { protocol:new URL(meta.publicBaseUrl).protocol.slice(0,-1), get:() => new URL(meta.publicBaseUrl).host } as unknown as Request;
      active.add(row.id);
      void continueHussImages(row.id, req, () => {}).catch((e: any) => holdForReview(row.id,e.message,'local')).finally(() => active.delete(row.id));
      continue;
    }
    if (isSiYueTianManagedVideoModel(meta.actualModel) && Number(meta.siYueTianMinimaxResumeAt) > Date.now()) continue;
    if (meta.zonghengProtocol === 'v6k' && Number(meta.v6kQueryResumeAt) > Date.now()) continue;
    if (row.type === 'video' && videoSubmissionPending(row.id, meta)) continue;
    if (row.type === 'video' && meta.zhiyingOrder) {
      if ((!meta.zhiyingReplayStopped || meta.videoId || meta.upstreamTaskId) && !meta.refundPending && !meta.billingShortfall && meta.reviewKind !== 'settlement' && Number(meta.zhiyingResumeAt || 0) <= Date.now())
        scheduleZhiyingRecovery(row.id);
      continue;
    }
    if (row.type === 'video' && !meta.videoId && !meta.upstreamTaskId && meta.hussIdempotencyKey && !meta.billingShortfall
      && (!meta.reviewKind || meta.reviewKind === 'submission')) {
      const channel = ChannelService.getChannelRaw(Number(meta.channelId), Number(meta.channelApiKeyId) || null);
      if (channel && isHussChannel(channel)) {
        if (Date.now() < Number(meta.hussReceiptRetryAt || 0)) continue;
        active.add(row.id);
        patch(row.id, { hussReceiptRetryAt: Date.now() + 60_000 });
        void resumeHussReceipt(row.id, channel, meta.hussIdempotencyKey)
          .catch((error: any) => holdForReview(row.id, transportDiagnostic('HUSS', '原提交回执查询失败；保留原编号稍后重查', error, channel.apiKey)))
          .finally(() => active.delete(row.id));
        continue;
      }
    }
    const knownMjResult = row.type === 'image' && meta.nativeImageOutputs === 4
      && Array.isArray(meta.nativeImageBatch?.sourceUrls) && meta.nativeImageBatch.sourceUrls.length > 0;
    const resumableMj = row.type === 'image' && meta.nativeImageOutputs === 4 && canResumeMjAsync(meta.mjAsyncImage);
    // Resume only known originals or a saved live query handle, never the paid POST.
    const hussChannel = row.type === 'video' && (meta.videoId || meta.upstreamTaskId)
      ? ChannelService.getChannelRaw(Number(meta.channelId), Number(meta.channelApiKeyId) || null) : null;
    const resumableHuss = isHussChannel(hussChannel) && !meta.hussDeliveryExpired && !meta.refundPending
      && !meta.billingShortfall && meta.billingStatus !== 'refunded' && !meta.queueRefunded
      && (!meta.reviewKind || ['query', 'submission'].includes(meta.reviewKind) || meta.reviewKind === 'local' && meta.hussCompletedReceipt);
    if (resumableHuss && Date.now() < Number(meta.hussQueryResumeAt || 0)) continue;
    if (row.status === 'review' && !knownMjResult && !resumableMj && !resumableHuss) continue;
    if (resumableHuss) {
      meta.videoId = meta.videoId || meta.upstreamTaskId;
      patch(row.id, { videoId: meta.videoId, requiresReview: false, reviewKind: null, error: null }, 'processing');
    }
    if (knownMjResult || resumableMj) { try { assertMjReservation(row.id); } catch { continue; } }
    if (row.type === 'image' && (meta.nativeImageBatch || meta.imageJobs?.length || resumableMj)) {
      active.add(row.id);
      void recoverImages(row.id).catch((error: any) => {
        if (knownMjResult || resumableMj) { try { assertMjReservation(row.id); } catch { return; } }
        holdForReview(row.id, transportDiagnostic('图片原渠道', '图片结果待核实，请勿重复提交', error));
      }).finally(() => active.delete(row.id));
      continue;
    }
    if (!meta.videoId || row.type !== 'video') {
      if (!meta.requiresReview) holdForReview(row.id, '服务重启后提交状态待核实，请勿重复提交');
      continue;
    }
    const channel = ChannelService.getChannelRaw(Number(meta.channelId), Number(meta.channelApiKeyId) || null);
    if (!channel) { holdForReview(row.id, '原任务渠道已删除，需要管理员核实'); continue; }
    active.add(row.id);
    void pollVideo(row.id, channel, meta.videoId, () => {}).catch((error: any) => handleUnexpectedGenerationError(row.id, transportDiagnostic(channel.type, '原任务处理异常', error, channel.apiKey))).finally(() => active.delete(row.id));
  }
}
import { transportDiagnostic } from './upstreamDiagnostic.js';

/** Resume the original specification executor and reservation; never create a new paid task. */
export function recoverSpecificationVideo(id: number) {
  const row = db.select().from(contents).where(eq(contents.id, id)).get();
  if (!row || row.type !== 'video') throw fail('视频任务不存在', 404);
  const meta = metadata(id);
  if (!meta.managedSpecification || meta.batchItemId && !meta.zhiyingOrder) throw fail('该记录不属于单条规格视频任务', 409);
  if (row.status === 'completed') return { status: 'completed', message: '任务已完成，未重复扣费', item: row, chargedAmount: 0 };
  if (active.has(id)) return { status: 'processing', message: '原任务正在查询或保存结果，未重复启动' +
    (meta.upstreamQueryError || meta.resultSaveError || meta.progressText ? '\n' + (meta.upstreamQueryError || meta.resultSaveError || meta.progressText) : ''), chargedAmount: 0 };
  if (['failed', 'cancelled', 'canceled'].includes(row.status) || meta.billingStatus === 'refunded' || meta.queueRefunded)
    throw fail('该任务已结束或退款，不能按原预扣自动恢复，请先核查账单', 409);
  if (meta.zhiyingOrder) {
    try {
      assertZhiyingReservation(id, meta);
      if (meta.zhiyingReplayStopped && !meta.videoId && !meta.upstreamTaskId) throw new Error(meta.error || '智赢原提交存在冲突，请核实原请求');
      if (meta.zhiyingKey || meta.videoId) assertZhiyingOriginalChannel(ChannelService.getChannelRaw(Number(meta.channelId)), meta);
      if (meta.reviewKind === 'settlement') {
        if (!row.resultUrl) throw new Error('智赢原任务费用处理待核对，保留原单');
        complete(id, [row.resultUrl]);
        return { status: 'completed', message: '原视频已保存，已按原预扣完成结算', chargedAmount: 0 };
      }
    } catch (error: any) { throw fail(error.message, 409); }
    if (!videoSubmissionPending(id, meta)) scheduleZhiyingRecovery(id);
    return { status: 'processing', message: '正在核对智赢原提交及任务回执', chargedAmount: 0 };
  }
  const reservation = meta.billingReservationId
    ? sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(meta.billingReservationId) as any : null;
  const context = reservation ? JSON.parse(reservation.context || '{}') : {};
  if (!reservation || !['reserved', 'review'].includes(reservation.state)
    || Number(context.contentId) !== id || Number(context.userId) !== Number(row.userId)
    || (context.tokenId || meta.tokenId) && Number(context.tokenId) !== Number(meta.tokenId)
    || !Number.isFinite(Number(meta.reservedCost)) || Math.abs(Number(reservation.amount) - Number(meta.reservedCost)) > 0.000001
    || Math.abs(Number(reservation.amount) - Number(row.cost)) > 0.000001)
    throw fail('原预扣账本状态、金额或归属不匹配，未恢复也未扣费', 409);
  const channel = ChannelService.getChannelRaw(Number(meta.channelId), Number(meta.channelApiKeyId) || null);
  if (!channel) throw fail('原任务渠道不可用，未重新生成', 409);
  const taskId = String(meta.videoId || meta.upstreamTaskId || '').trim();
  if (!taskId && !(isHussChannel(channel) && meta.hussIdempotencyKey)) throw fail('缺少原任务 ID，请先补录；不会重新提交生成', 409);
  if (videoSubmissionPending(id, meta)) return { status: 'processing', message: '原提交仍在执行，请等待保存任务编号', chargedAmount: 0 };
  active.add(id);
  try {
    patch(id, { ...(taskId ? { videoId: taskId } : {}), requiresReview: false, reviewKind: null,
      error: null, failureReason: null, upstreamQueryError: null, recoveryPreviousError: meta.error || meta.recoveryPreviousError,
      progressText: '正在恢复原任务查询，未重新生成或扣费', recoveryRequestedAt: new Date().toISOString() }, 'processing');
    const pending = taskId ? pollVideo(id, channel, taskId, () => {}) : resumeHussReceipt(id, channel, meta.hussIdempotencyKey);
    void pending.catch((error: any) => handleUnexpectedGenerationError(id, transportDiagnostic(channel.type, '原任务恢复', error, channel.apiKey)))
      .finally(() => active.delete(id));
  } catch (error) { active.delete(id); throw error; }
  return { status: 'processing', message: '已恢复原任务查询和结果保存，未重新生成或扣费', chargedAmount: 0 };
}
import { isSnumomWanVideoModel, snumomOutputOnlySpec, SNUMOM_WAN_NSFW_MODEL } from '../../shared/snumomWanNsfw.js';
import { prepareSnumomNsfwReferences } from './snumomNsfwReferences.js';
