import { isAsyncVideoChannel, asyncVideoTaskUrl, normalizeAsyncVideoTask, resolveAsyncVideoUrl } from './asyncVideoAdapter.js';
import { isZonghengChannel, zonghengTaskUrl, normalizeZonghengTask } from './zonghengAdapter.js';
import { isHayaChannel, hayaTaskUrl, normalizeHayaTask } from './hayaVideoAdapter.js';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { findVideoSubmissionReceipt } from './videoSubmissionReceiptService.js';
import { withFundContext } from '../db/fundLedger.js';
import { fetchVideoTaskResponse, withVideoPollDeadline } from './videoPollDeadline.js';
import { apiTokens, contents, users, organizations } from '../db/schema.js';
import { isBatchQueryUncertain } from './videoBatchStore.js';
import { ChannelService } from './channelService.js';
import { TokenService } from './tokenService.js';
import { downloadAndLocalizeVideo } from './videoLocalizationService.js';
import { hmStudioTaskUrl, isHmStudioChannel, normalizeHmStudioTask } from './hmStudioAdapter.js';
import {
  isMiaowuChannel,
  miaowuVideoTaskUrl,
  normalizeMiaowuVideoTask,
} from './miaowuVideoAdapter.js';
import { isLongxiaChannel, longxiaVideoTaskUrl, normalizeLongxiaVideoTask } from './longxiaVideoAdapter.js';
import { isSnumomWanChannel, normalizeSnumomWanTask, snumomContentUrl } from './snumomWanAdapter.js';
import {
  isWxHaidiYueChannel,
  normalizeWxHaidiYueTask,
  wxHaidiYueTaskUrl,
  WX_HAIDIYUE_FACE_SPLIT_MODEL,
} from './wxHaidiYueAdapter.js';
import {
  extractVideoFailureMessage,
  formatVideoPollHttpFailure,
  isVideoFailurePayload,
  isVideoFailureStatus,
  isVideoQueryErrorPayload,
} from './videoFailureService.js';

type RecoveryInspection = {
  status: 'processing' | 'failed' | 'completed';
  message: string;
  progress?: number;
  upstreamResultUrl?: string;
  videoId: string;
  channelId: number;
  channelApiKeyId: number | null;
};

type RecentFailedRecoveryPreview = {
  days: number;
  since: string;
  failedCount: number;
  eligibleCount: number;
  missingTaskIdCount: number;
  alreadyRecoveredCount: number;
  candidateIds: number[];
};

type RecentFailedRecoveryItem = {
  id: number;
  status: 'recovered' | 'processing' | 'failed' | 'insufficient_balance' | 'skipped' | 'error';
  message: string;
  chargedAmount?: number;
};

// Concurrent recovery clicks share the file transfer, but settle independently
// in the transaction below so only the first caller can charge a refund.
const recoveryDownloads = new Map<string, Promise<string>>();
let pollerModule: Promise<typeof import('../routes/video.js')> | undefined;
function loadVideoPoller() {
  // Share initialization when multiple administrators restore concurrently.
  return pollerModule ??= import('../routes/video.js').catch(error => {
    pollerModule = undefined;
    throw error;
  });
}

function parseMetadata(value: unknown): Record<string, any> {
  if (value && typeof value === 'object') return value as Record<string, any>;
  try { return JSON.parse(String(value || '{}')); } catch { return {}; }
}

function upstreamTaskId(metadata: Record<string, any>): string {
  return String(metadata.videoId || metadata.upstreamTaskId || metadata.requestId || metadata.request_id || metadata.taskId || metadata.task_id || '').trim();
}

/** Must run inside the same transaction as the content transition. Never move a
 * recovered charge to another balance just because the user changed organization. */
function chargeRefundedVideo(record: any, metadata: Record<string, any>, amount: number) {
  return withFundContext(sqlite, { kind: 'charge', contentId: record.id, operation: 'generate_video_recovery' },
    () => chargeOriginalRefundSource(record, metadata, amount));
}

function chargeOriginalRefundSource(record: any, metadata: Record<string, any>, amount: number) {
  if (!Number.isFinite(amount) || amount < 0) throw { status: 409, message: '原退款金额无效，停止恢复' };
  const tokenId = Number(metadata.tokenId) || 0;
  const target = metadata.refundTarget || (metadata.billingSource === 'token' ? 'api_token'
    : metadata.billingBalanceSource === 'org' ? 'organization_balance' : 'user_balance');
  if (target === 'api_token') {
    const token = db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get();
    if (!token || token.userId !== record.userId) throw { status: 409, message: '原 API Token 不存在或归属不一致' };
    TokenService.deductBalance(tokenId, amount);
    metadata.billingSource = 'token';
  } else {
    let changes = 0;
    if (target === 'organization_balance') {
      const orgId = Number(metadata.billingOrgId || record.orgId);
      if (!orgId) throw { status: 409, message: '原退款组织不明确，停止恢复' };
      changes = db.update(organizations).set({ balance: sql`balance - ${amount}` })
        .where(and(eq(organizations.id, orgId), sql`balance >= ${amount}`)).run().changes;
      metadata.billingBalanceSource = 'org'; metadata.billingOrgId = orgId;
    } else if (target === 'user_balance') {
      changes = db.update(users).set({ balance: sql`balance - ${amount}` })
        .where(and(eq(users.id, record.userId), sql`balance >= ${amount}`)).run().changes;
      metadata.billingBalanceSource = 'user'; delete metadata.billingOrgId;
    } else throw { status: 409, message: '原退款来源不明确，停止恢复' };
    if (!changes) throw { status: 402, message: `原退款账户余额不足 ¥${amount.toFixed(2)}，未扣费、未恢复` };
    if (tokenId) {
      const token = db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get();
      if (!token || token.userId !== record.userId || token.balance !== -1) throw { status: 409, message: '关联 API Token 账务不一致，停止恢复' };
      TokenService.deductBalance(tokenId, amount);
    }
  }
}

function normalizeRecoveryDays(value: unknown): number {
  const days = Math.floor(Number(value) || 3);
  return Math.min(30, Math.max(1, days));
}

function recoveryChargeAmount(record: any, metadata: Record<string, any>): number {
  if (metadata.queueRefunded !== true && metadata.billingStatus !== 'refunded')
    throw { status: 409, message: '缺少明确退款凭据，停止补扣；请核实原任务账务' };
  const refundedAmount = Number(metadata.refundAmount);
  if (metadata.refundAmount === null || metadata.refundAmount === undefined || metadata.refundAmount === ''
    || !Number.isFinite(refundedAmount) || refundedAmount < 0)
    throw { status: 409, message: '缺少有效原退款金额，停止恢复' };
  return refundedAmount; // A zero-price original must not be repriced on recovery.
}

export class VideoRecoveryService {
  static supplementTaskId(contentId: number, actorId: number, taskIdValue: unknown) {
    if (!Number.isSafeInteger(contentId) || contentId <= 0) throw { status: 400, message: '记录 ID 无效' };
    const record = db.select().from(contents).where(eq(contents.id, contentId)).get();
    if (!record) throw { status: 404, message: '任务记录不存在' };
    if (record.type !== 'video') throw { status: 400, message: '仅支持视频任务补录' };
    if (!['failed', 'error', 'review'].includes(record.status)) throw { status: 409, message: '当前任务状态不允许补录' };

    const taskId = typeof taskIdValue === 'string' ? taskIdValue.trim() : '';
    if (!taskId || taskId.length > 256 || /[\x00-\x1f\x7f]/.test(taskId)) {
      throw { status: 400, message: '请填写有效的上游任务 ID' };
    }

    const metadata = parseMetadata(record.metadata);
    const now = new Date().toISOString();
    const audit = Array.isArray(metadata.recoveryAudit) ? metadata.recoveryAudit : [];
    metadata.recoveryAudit = [...audit, {
      at: now,
      actorId,
      action: 'supplement_task_id',
      previousTaskId: upstreamTaskId(metadata),
      taskId,
    }].slice(-20);
    Object.assign(metadata, {
      videoId: taskId,
      upstreamTaskId: taskId,
      recoveryTaskIdSupplemented: true,
      recoverySupplementedAt: now,
      recoverySupplementedBy: actorId,
    });
    db.update(contents).set({ metadata: JSON.stringify(metadata) }).where(eq(contents.id, contentId)).run();
    return { message: '上游任务 ID 已补录', taskId };
  }

  static previewRecentFailed(daysValue: unknown = 3): RecentFailedRecoveryPreview {
    const days = normalizeRecoveryDays(daysValue);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
    const records = db.select().from(contents).where(and(
      eq(contents.type, 'video'),
      inArray(contents.status, ['failed', 'error']),
      gte(contents.createdAt, since),
    )).orderBy(desc(contents.createdAt)).all().filter(record => !parseMetadata(record.metadata).batchItemId);

    const candidateIds: number[] = [];
    let missingTaskIdCount = 0;
    let alreadyRecoveredCount = 0;
    for (const record of records) {
      const metadata = parseMetadata(record.metadata);
      if (metadata.recoveryCharged && !metadata.queueRefunded) {
        alreadyRecoveredCount += 1;
      } else if (!upstreamTaskId(metadata)) {
        missingTaskIdCount += 1;
      } else {
        candidateIds.push(record.id);
      }
    }

    return {
      days,
      since,
      failedCount: records.length,
      eligibleCount: candidateIds.length,
      missingTaskIdCount,
      alreadyRecoveredCount,
      candidateIds,
    };
  }

  static async recoverRecentFailed(daysValue: unknown = 3) {
    const preview = this.previewRecentFailed(daysValue);
    const results: RecentFailedRecoveryItem[] = [];
    let nextIndex = 0;

    const worker = async () => {
      while (nextIndex < preview.candidateIds.length) {
        const id = preview.candidateIds[nextIndex++];
        try {
          const result = await this.recover(id);
          if (result.status === 'completed') {
            const alreadyRecovered = 'alreadyRecovered' in result && Boolean(result.alreadyRecovered);
            const chargedAmount = 'chargedAmount' in result ? Number(result.chargedAmount) || 0 : undefined;
            results.push({
              id,
              status: alreadyRecovered ? 'skipped' : 'recovered',
              message: result.message,
              chargedAmount,
            });
          } else if (result.status === 'processing') {
            results.push({ id, status: 'processing', message: result.message, chargedAmount: 'chargedAmount' in result ? Number(result.chargedAmount) || 0 : 0 });
          } else {
            results.push({ id, status: 'failed', message: result.message });
          }
        } catch (error: any) {
          results.push({
            id,
            status: Number(error?.status) === 402 ? 'insufficient_balance' : 'error',
            message: error?.message || '重新获取上游结果失败',
          });
        }
      }
    };

    const concurrency = Math.min(3, preview.candidateIds.length);
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    const count = (status: RecentFailedRecoveryItem['status']) => results.filter(item => item.status === status).length;
    return {
      ...preview,
      checkedCount: results.length,
      recoveredCount: count('recovered'),
      processingCount: count('processing'),
      upstreamFailedCount: count('failed'),
      insufficientBalanceCount: count('insufficient_balance'),
      skippedCount: count('skipped'),
      errorCount: count('error'),
      chargedAmount: results.reduce((sum, item) => sum + (Number(item.chargedAmount) || 0), 0),
      results,
    };
  }

  static async inspect(contentId: number): Promise<RecoveryInspection> {
    const record = db.select().from(contents).where(eq(contents.id, contentId)).get();
    if (!record) throw { status: 404, message: '任务记录不存在' };
    if (record.type !== 'video') throw { status: 400, message: '只有视频任务可以重新获取' };

    const metadata = parseMetadata(record.metadata);
    const receipt = findVideoSubmissionReceipt(contentId);
    const videoId = upstreamTaskId(metadata) || receipt?.upstreamTaskId || '';
    if (!metadata.channelId && receipt?.channelId) metadata.channelId = receipt.channelId;
    if (!metadata.channelApiKeyId && receipt?.channelApiKeyId) metadata.channelApiKeyId = receipt.channelApiKeyId;
    if (!videoId) throw { status: 400, message: '该记录没有保存上游任务 ID，无法重新获取' };

    const channel = metadata.channelId
      ? ChannelService.getChannelRaw(Number(metadata.channelId), Number(metadata.channelApiKeyId) || null)
      : ChannelService.findChannelForModel(record.modelId || metadata.model || '');
    if (!channel) {
      throw { status: 503, message: '原任务渠道当前不可用' };
    }

    const baseUrl = String(channel.baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
    const model = String(record.modelId || metadata.model || '');
    const isHmStudio = isHmStudioChannel(channel);
    const isHaidiYue = isWxHaidiYueChannel(channel);
    const isSnumom = isSnumomWanChannel(channel);
    const isLongxia = isLongxiaChannel(channel);
    const isHaya = isHayaChannel(channel);
    const isZongheng = isZonghengChannel(channel);
    const isMiaowu = isMiaowuChannel(channel);
    const isSudaShui = /sudashuiapi\.com/i.test(baseUrl) || metadata.actualChannel === 'sudashui';
    const pollUrl = isAsyncVideoChannel(channel) ? asyncVideoTaskUrl(baseUrl, videoId) : isZongheng ? zonghengTaskUrl(baseUrl, videoId) : isHaya ? hayaTaskUrl(baseUrl, videoId) : isHmStudio
      ? hmStudioTaskUrl(baseUrl, videoId)
      : isHaidiYue
        ? wxHaidiYueTaskUrl(baseUrl, videoId)
        : isLongxia
          ? longxiaVideoTaskUrl(baseUrl, videoId)
        : isMiaowu
          ? miaowuVideoTaskUrl(baseUrl, videoId)
        : isSudaShui
          ? `${baseUrl}/v1/video/generations/${encodeURIComponent(videoId)}`
          : `${baseUrl}/v1/videos/${encodeURIComponent(videoId)}`;
    const headers: Record<string, string> = {};
    if (channel.apiKey) headers.Authorization = `Bearer ${channel.apiKey}`;
    const response = await fetchVideoTaskResponse(pollUrl, { headers });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw { status: 502, message: formatVideoPollHttpFailure(response.status, detail) };
    }

    const payload = await response.json() as any;
    if (isVideoQueryErrorPayload(payload)) throw { status: 502, message: '上游查询异常，未确认任务状态，未恢复或补扣' };
    const returnedId = payload?.task_id || payload?.id || payload?.data?.task_id || payload?.data?.id;
    if (returnedId && String(returnedId) !== videoId) throw { status: 502, message: '上游返回任务 ID 不一致，未恢复或补扣' };
    let normalizedStatus = '';
    let progress = 0;
    let resultUrl = '';
    let error = '';
    if (isAsyncVideoChannel(channel)) {
      const task = normalizeAsyncVideoTask(payload);
      normalizedStatus = task.status; progress = task.progress; error = task.error;
      if (task.status === 'completed') resultUrl = await resolveAsyncVideoUrl(channel, videoId);
    } else if (isZongheng) {
      const task = normalizeZonghengTask(payload);
      normalizedStatus = task.status; progress = task.progress; resultUrl = task.resultUrl; error = task.error;
    } else if (isHaya) {
      const task = normalizeHayaTask(payload, baseUrl, videoId);
      normalizedStatus = task.status; progress = task.progress; resultUrl = task.resultUrl; error = task.error;
    } else if (isHmStudio) {
      const task = normalizeHmStudioTask(payload, baseUrl);
      normalizedStatus = task.status;
      progress = task.progress;
      resultUrl = task.resultUrl;
      error = task.error;
    } else if (isHaidiYue) {
      const task = normalizeWxHaidiYueTask(payload, baseUrl);
      normalizedStatus = task.status;
      progress = task.progress;
      resultUrl = task.resultUrl;
      error = task.error || task.errorCode;
    } else if (isLongxia) {
      const task = normalizeLongxiaVideoTask(payload);
      normalizedStatus = task.status;
      progress = task.progress;
      resultUrl = task.resultUrl;
      error = task.error;
    } else if (isMiaowu) {
      const task = normalizeMiaowuVideoTask(payload, baseUrl, videoId);
      normalizedStatus = task.status;
      progress = task.progress;
      resultUrl = task.resultUrl;
      error = task.error;
    } else if (isSnumom) {
      const task = normalizeSnumomWanTask(payload);
      normalizedStatus = task.status;
      progress = task.progress;
      resultUrl = task.resultUrl;
      error = task.error;
      if ((normalizedStatus === 'completed' || normalizedStatus === 'success') && !resultUrl) {
        resultUrl = snumomContentUrl(baseUrl, videoId);
      }
    } else if (isSudaShui) {
      const data = payload?.data || {};
      normalizedStatus = String(data.status || payload?.status || '').toLowerCase();
      progress = Number.parseInt(String(data.progress || payload?.progress || '0'), 10) || 0;
      resultUrl = String(data.result_url || data.data?.url || payload?.result_url || payload?.url || '');
      error = extractVideoFailureMessage(data.error || data.fail_reason || payload?.error || payload?.fail_reason);
    } else {
      const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
      normalizedStatus = String(data?.status || payload?.status || '').toLowerCase();
      progress = Number.parseInt(String(data?.progress || payload?.progress || '0'), 10) || 0;
      resultUrl = String(
        data?.video_url || data?.url || data?.result_url || data?.result?.url
        || payload?.video_url || payload?.url || payload?.result_url || payload?.result?.url
        || (Array.isArray(payload?.outputs) ? payload.outputs[0]?.url : '')
        || '',
      );
      error = extractVideoFailureMessage(data?.error || payload?.error || data?.failure_reason || payload?.failure_reason);
    }
    if (!isHaya && !isZongheng && isVideoFailurePayload(payload)) {
      if (metadata.batchItemId && isBatchQueryUncertain(payload, normalizedStatus)) {
        throw { status: 502, message: '上游查询返回异常，无法确认原任务失败；保留预扣，不会重复生成' };
      }
      normalizedStatus = 'failed';
    }
    const base = {
      videoId,
      channelId: Number(channel.id),
      channelApiKeyId: Number(channel.apiKeyId) || null,
    };

    if (normalizedStatus === 'completed' || normalizedStatus === 'success') {
      if (!resultUrl && !isZongheng && !isHmStudio && !isHaidiYue && !isMiaowu && !isLongxia && !isSudaShui) {
        const isSiYueTian = /(^|\.)llm\.(chre3\.com|domie\.studio)$/i.test(new URL(baseUrl).hostname);
        resultUrl = isSiYueTian
          ? `${baseUrl}/v1/videos/${encodeURIComponent(videoId)}/content`
          : `${baseUrl}/v1/files/video?id=${encodeURIComponent(videoId)}`;
      }
      if (!resultUrl) throw { status: 502, message: '上游任务已成功，但未返回视频地址' };
      return { ...base, status: 'completed', message: '上游任务已生成成功', upstreamResultUrl: resultUrl };
    }
    if (isVideoFailureStatus(normalizedStatus)) {
      return {
        ...base,
        status: 'failed',
        message: (isHaya ? error : extractVideoFailureMessage(payload)) || error || '上游任务生成失败',
      };
    }
    if (!['processing', 'queued', 'pending', 'submitted', 'generating', 'post_processing', 'finalizing', 'in_progress', 'running'].includes(normalizedStatus))
      throw { status: 502, message: '上游返回未知任务状态，未恢复或补扣' };
    return {
      ...base,
      status: 'processing',
      message: '上游任务仍在生成中，请稍后重新获取',
      progress: Number(progress) || 0,
    };
  }

  static async recover(contentId: number) {
    const inspection = await this.inspect(contentId);
    const batchRecord = db.select().from(contents).where(eq(contents.id, contentId)).get();
    const batchMetadata = parseMetadata(batchRecord?.metadata);
    if (batchRecord && !batchMetadata.batchItemId && batchMetadata.recoveryPollingProtected && inspection.status === 'failed') {
      const { failHmQueuedVideo } = await loadVideoPoller();
      await failHmQueuedVideo(contentId, new Error(inspection.message), true);
      return inspection;
    }
    if (batchRecord && !batchMetadata.batchItemId && inspection.status === 'processing') {
      const taskChannel = ChannelService.getChannelRaw(inspection.channelId, inspection.channelApiKeyId);
      if (batchMetadata.managedSpecification || (taskChannel && isAsyncVideoChannel(taskChannel)))
        throw { status: 409, message: '该任务使用独立账本，请在对应任务入口恢复' };
      if (batchMetadata.billingReservationId) {
        const reservation = sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(batchMetadata.billingReservationId) as any;
        const context = reservation ? parseMetadata(reservation.context) : {};
        if (!reservation || !['reserved', 'review'].includes(reservation.state)
          || context.contentId && Number(context.contentId) !== contentId
          || context.userId != null && Number(context.userId) !== Number(batchRecord.userId)
          || Math.abs(Number(reservation.amount) - Number(batchRecord.cost)) > 0.000001
          || batchMetadata.queueRefunded || batchMetadata.billingStatus === 'refunded') {
          throw { status: 409, message: '原预扣账本状态或归属不匹配，请到异常账单核查' };
        }
      }
      // Load the poller before taking money. Charge + status change are atomic;
      // concurrent clicks re-read the paid marker inside the transaction.
      const { resumePollForTask } = await loadVideoPoller();
      const result = db.transaction(() => {
        const record = db.select().from(contents).where(eq(contents.id, contentId)).get();
        if (!record) throw { status: 404, message: '任务记录不存在' };
        const metadata = parseMetadata(record.metadata);
        if (upstreamTaskId(metadata) !== inspection.videoId || Number(metadata.channelId) !== inspection.channelId)
          throw { status: 409, message: '原任务关联已变更，请刷新后重新核查' };
        if (metadata.billingReservationId) {
          const reservation = sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(metadata.billingReservationId) as any;
          const context = reservation ? parseMetadata(reservation.context) : {};
          if (!reservation || !['reserved', 'review'].includes(reservation.state)
            || context.contentId && Number(context.contentId) !== contentId
            || context.userId != null && Number(context.userId) !== Number(record.userId)
            || Math.abs(Number(reservation.amount) - Number(record.cost)) > 0.000001
            || metadata.queueRefunded || metadata.billingStatus === 'refunded') {
            throw { status: 409, message: '原预扣账本状态或归属不匹配，请到异常账单核查' };
          }
        }
        if (record.status === 'completed') return { record, chargedAmount: 0, alreadyRecovered: true };
        const refunded = metadata.queueRefunded === true || metadata.billingStatus === 'refunded';
        if (['failed', 'error'].includes(record.status) && !refunded)
          throw { status: 409, message: '失败记录缺少退款凭据，停止恢复以避免重复扣费' };
        const amount = refunded ? recoveryChargeAmount(record, metadata) : 0;
        if (refunded) chargeRefundedVideo(record, metadata, amount);
        const at = new Date().toISOString();
        if (refunded) {
          metadata.recoveryCharges = [...(Array.isArray(metadata.recoveryCharges) ? metadata.recoveryCharges : []), { at, amount, refundTarget: metadata.refundTarget }];
          Object.assign(metadata, { recoveryCharged: true, recoveryChargeAmount: amount, recoveryPrecharged: true,
            refundReversedAt: at, billingStatus: 'recovery_precharged', queueRefunded: false });
        }
        if (record.status !== 'processing' || refunded || !metadata.recoveryPollingStartedAt) metadata.recoveryPollingStartedAt = at;
        Object.assign(metadata, { videoId: inspection.videoId, upstreamStatus: 'in_progress', progress: inspection.progress || 0,
          queueStatus: 'processing', requiresReview: false, recoveryPollingProtected: true,
          progressText: '已恢复原任务轮询，不会重新生成', recoveryPreviousError: metadata.error || metadata.recoveryPreviousError });
        delete metadata.error; delete metadata.failedAt; delete metadata.recoveryPollPausedAt; delete metadata.upstreamQueryError;
        db.update(contents).set({ status: 'processing', cost: refunded ? amount : record.cost, metadata: JSON.stringify(metadata) }).where(eq(contents.id, contentId)).run();
        return { record: db.select().from(contents).where(eq(contents.id, contentId)).get()!, chargedAmount: amount, alreadyRecovered: !refunded };
      });
      if (result.record.status === 'processing') void resumePollForTask(contentId, result.record).catch(error => console.error('[video-recovery] 恢复轮询异常:', error?.message));
      return { ...inspection, status: result.record.status === 'completed' ? 'completed' : 'processing',
        chargedAmount: result.chargedAmount, alreadyRecovered: result.alreadyRecovered,
        message: result.record.status === 'completed' ? '任务已完成，未重复扣费' : result.chargedAmount > 0
          ? `已补扣 ¥${result.chargedAmount.toFixed(2)}，恢复原任务轮询` : '原任务已恢复轮询，未重复扣费', item: result.record };
    }
    if (batchRecord && !batchMetadata.batchItemId && batchMetadata.billingReservationId && inspection.status === 'failed') {
      const { failHmQueuedVideo } = await loadVideoPoller();
      await failHmQueuedVideo(contentId, new Error(inspection.message || '上游任务生成失败'), true);
      return inspection;
    }
    if (batchRecord && batchMetadata.batchItemId && inspection.status !== 'completed') {
      const { batchStore, recordBatchFailure, tickVideoBatches } = await import('./videoBatchService.js');
      const item = batchStore.item(Number(batchMetadata.batchItemId));
      if (!item || item.content_id !== contentId || item.billing_state !== 'reserved' || !['running', 'review'].includes(item.status)) {
        throw { status: 409, message: '此批量尝试已结束或已替换，请查看当前批次任务' };
      }
      if (inspection.status === 'failed') {
        recordBatchFailure(contentId, inspection.message || '上游确认失败', true);
        tickVideoBatches();
      } else if (inspection.status === 'processing') {
        db.update(contents).set({ status: 'processing' }).where(eq(contents.id, contentId)).run();
        const { resumePollForTask } = await loadVideoPoller();
        void resumePollForTask(contentId, { ...batchRecord, status: 'processing' });
      }
    }
    if (!batchMetadata.batchItemId && (batchMetadata.hayaSubmissionStarted || batchMetadata.zonghengSubmissionStarted) && batchRecord?.status === 'review') {
      if (inspection.status === 'failed') {
        const { failHmQueuedVideo } = await loadVideoPoller();
        await failHmQueuedVideo(contentId, new Error(inspection.message), true);
      } else if (inspection.status === 'processing') {
        db.update(contents).set({ status: 'processing' }).where(eq(contents.id, contentId)).run();
        const { resumePollForTask } = await loadVideoPoller();
        void resumePollForTask(contentId, { ...batchRecord, status: 'processing' });
      }
    }
    if (inspection.status !== 'completed' || !inspection.upstreamResultUrl) return inspection;

    const beforeDownload = db.select().from(contents).where(eq(contents.id, contentId)).get();
    if (!beforeDownload) throw { status: 404, message: '任务记录不存在' };
    const beforeMetadata = parseMetadata(beforeDownload.metadata);
    if (beforeDownload.status === 'completed' && beforeDownload.resultUrl) {
      return { status: 'completed', message: '该任务已经恢复，无需重复扣费', item: beforeDownload, alreadyRecovered: true };
    }
    if (!beforeMetadata.batchItemId && beforeMetadata.managedSpecification)
      throw { status: 409, message: '该任务使用独立账本，请在对应任务入口恢复' };

    const downloadKey = `${contentId}:${inspection.channelId}:${inspection.videoId}`;
    let download = recoveryDownloads.get(downloadKey);
    if (!download) {
      download = withVideoPollDeadline(() => downloadAndLocalizeVideo(
        inspection.upstreamResultUrl,
        inspection.videoId,
        beforeDownload.modelId || WX_HAIDIYUE_FACE_SPLIT_MODEL,
        inspection.channelId,
        inspection.channelApiKeyId,
      ), 360_000, 'Video result storage');
      recoveryDownloads.set(downloadKey, download);
    }
    let localizedUrl: string;
    try { localizedUrl = await download; }
    finally { if (recoveryDownloads.get(downloadKey) === download) recoveryDownloads.delete(downloadKey); }
    if (!localizedUrl) throw { status: 502, message: '上游视频下载失败，本次未新增扣费' };

    if (beforeMetadata.batchItemId) {
      const { settleRecoveredBatch } = await import('./videoBatchService.js');
      settleRecoveredBatch(contentId, localizedUrl);
      return { status: 'completed', message: '批量任务已恢复，使用原预扣费用结算，未重复扣费', chargedAmount: 0 };
    }

    if (beforeMetadata.billingReservationId) {
      const reservation = sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(beforeMetadata.billingReservationId) as any;
      const context = reservation ? parseMetadata(reservation.context) : {};
      if (!reservation || !['reserved', 'review'].includes(reservation.state)
        || context.contentId && Number(context.contentId) !== contentId
        || context.userId != null && Number(context.userId) !== Number(beforeDownload.userId)
        || Math.abs(Number(reservation.amount) - Number(beforeDownload.cost)) > 0.000001) {
        throw { status: 409, message: '原预扣账本状态或归属不匹配，请到异常账单核查' };
      }
      const { finalizeReservedContent } = await import('./contentBillingService.js');
      const completedAt = new Date().toISOString();
      finalizeReservedContent(contentId, 'completed', {
        progress: 100, upstreamStatus: 'completed', upstreamResultUrl: inspection.upstreamResultUrl,
        queueStatus: 'completed', completedAt, localizedAt: completedAt,
      }, localizedUrl);
      return { status: 'completed', message: '任务已恢复，使用原预扣费用结算，未重复扣费', chargedAmount: 0,
        item: db.select().from(contents).where(eq(contents.id, contentId)).get() };
    }

    return db.transaction(() => {
      const record = db.select().from(contents).where(eq(contents.id, contentId)).get();
      if (!record) throw { status: 404, message: '任务记录不存在' };
      const metadata = parseMetadata(record.metadata);
      if (record.status === 'completed') {
        return { status: 'completed', message: '该任务已经恢复，无需重复扣费', item: record, alreadyRecovered: true };
      }
      if (upstreamTaskId(metadata) !== inspection.videoId || Number(metadata.channelId) !== inspection.channelId)
        throw { status: 409, message: '原任务关联已变更，请刷新后重新核查' };

      // Ordinary website videos are prepaid before submission, even old records
      // without billingStatus/recovery markers. Never charge these a second time.
      if (['processing', 'queued', 'review'].includes(record.status)
        && !metadata.queueRefunded && metadata.billingStatus !== 'refunded') {
        delete metadata.error; delete metadata.progressText; delete metadata.hayaNeedsReview; delete metadata.requiresReview;
        const recoveredAt = new Date().toISOString();
        Object.assign(metadata, { progress: 100, queueStatus: 'completed', completedAt: recoveredAt,
          recoveredAt, localizedAt: recoveredAt, upstreamStatus: 'completed',
          billingStatus: metadata.recoveryPrecharged ? 'charged_after_recovery' : 'charged',
          upstreamResultUrl: inspection.upstreamResultUrl });
        delete metadata.upstreamQueryError; delete metadata.recoveryPollPausedAt; delete metadata.failedAt;
        db.update(contents).set({ status: 'completed', resultUrl: localizedUrl, metadata: JSON.stringify(metadata) }).where(eq(contents.id, contentId)).run();
        return { status: 'completed', message: '任务已恢复，使用原预扣费用结算', chargedAmount: 0, item: db.select().from(contents).where(eq(contents.id, contentId)).get() };
      }
      const chargeAmount = recoveryChargeAmount(record, metadata);
      chargeRefundedVideo(record, metadata, chargeAmount);

      const recoveredAt = new Date().toISOString();
      metadata.recoveryCharged = true;
      metadata.recoveryChargeAmount = chargeAmount;
      metadata.recoveredAt = recoveredAt;
      metadata.refundReversedAt = recoveredAt;
      metadata.billingStatus = 'charged_after_recovery';
      metadata.queueRefunded = false;
      metadata.queueStatus = 'completed';
      metadata.upstreamStatus = 'completed';
      metadata.progress = 100;
      metadata.completedAt = recoveredAt;
      metadata.localizedAt = recoveredAt;
      metadata.upstreamResultUrl = inspection.upstreamResultUrl;
      metadata.recoveryPreviousError = metadata.error || null;
      delete metadata.error;
      delete metadata.failedAt;
      delete metadata.progressText; delete metadata.upstreamQueryError;
      delete metadata.requiresReview; delete metadata.recoveryPollPausedAt;

      db.update(contents).set({
        status: 'completed',
        resultUrl: localizedUrl,
        cost: chargeAmount,
        metadata: JSON.stringify(metadata),
      }).where(eq(contents.id, contentId)).run();

      const item = db.select().from(contents).where(eq(contents.id, contentId)).get();
      return {
        status: 'completed',
        message: `任务已恢复并补扣 ¥${chargeAmount.toFixed(2)}`,
        chargedAmount: chargeAmount,
        item,
      };
    });
  }
}
