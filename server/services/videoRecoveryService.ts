import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { apiTokens, contents } from '../db/schema.js';
import { BalanceService } from './balanceService.js';
import { ChannelService } from './channelService.js';
import { PricingService } from './pricingService.js';
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

function parseMetadata(value: unknown): Record<string, any> {
  if (value && typeof value === 'object') return value as Record<string, any>;
  try { return JSON.parse(String(value || '{}')); } catch { return {}; }
}

function upstreamTaskId(metadata: Record<string, any>): string {
  return String(metadata.videoId || metadata.requestId || metadata.request_id || metadata.taskId || metadata.task_id || '').trim();
}

function normalizeRecoveryDays(value: unknown): number {
  const days = Math.floor(Number(value) || 3);
  return Math.min(30, Math.max(1, days));
}

function recoveryChargeAmount(record: any, metadata: Record<string, any>): number {
  const refundedAmount = Number(metadata.refundAmount);
  if (Number.isFinite(refundedAmount) && refundedAmount > 0) return refundedAmount;
  const existingCost = Number(record.cost);
  if (Number.isFinite(existingCost) && existingCost > 0) return existingCost;
  return PricingService.calculateUsageCost(record.modelId || metadata.model || WX_HAIDIYUE_FACE_SPLIT_MODEL, {
    resolution: metadata.resolution || '720p',
    seconds: Number(metadata.seconds) || 30,
    count: 1,
  });
}

export class VideoRecoveryService {
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
    )).orderBy(desc(contents.createdAt)).all();

    const candidateIds: number[] = [];
    let missingTaskIdCount = 0;
    let alreadyRecoveredCount = 0;
    for (const record of records) {
      const metadata = parseMetadata(record.metadata);
      if (metadata.recoveryCharged) {
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
            results.push({ id, status: 'processing', message: result.message });
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
      chargedAmount: results.reduce((sum, item) => sum + (item.status === 'recovered' ? Number(item.chargedAmount) || 0 : 0), 0),
      results,
    };
  }

  static async inspect(contentId: number): Promise<RecoveryInspection> {
    const record = db.select().from(contents).where(eq(contents.id, contentId)).get();
    if (!record) throw { status: 404, message: '任务记录不存在' };
    if (record.type !== 'video') throw { status: 400, message: '只有视频任务可以重新获取' };

    const metadata = parseMetadata(record.metadata);
    const videoId = upstreamTaskId(metadata);
    if (!videoId) throw { status: 400, message: '该记录没有保存上游任务 ID，无法重新获取' };

    const channel = metadata.channelId
      ? ChannelService.getChannelRaw(Number(metadata.channelId), Number(metadata.channelApiKeyId) || null)
      : ChannelService.findChannelForModel(record.modelId || metadata.model || '');
    if (!channel) {
      throw { status: 503, message: '原任务渠道当前不可用' };
    }

    const baseUrl = String(channel.baseUrl || '').replace(/\/+$/, '');
    const model = String(record.modelId || metadata.model || '');
    const isHmStudio = isHmStudioChannel(channel);
    const isHaidiYue = isWxHaidiYueChannel(channel);
    const isSnumom = isSnumomWanChannel(channel);
    const isLongxia = isLongxiaChannel(channel);
    const isMiaowu = isMiaowuChannel(channel);
    const isSudaShui = /sudashuiapi\.com/i.test(baseUrl) || metadata.actualChannel === 'sudashui';
    const pollUrl = isHmStudio
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
    const response = await fetch(pollUrl, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw { status: 502, message: formatVideoPollHttpFailure(response.status, detail) };
    }

    const payload = await response.json() as any;
    let normalizedStatus = '';
    let progress = 0;
    let resultUrl = '';
    let error = '';
    if (isHmStudio) {
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
    if (isVideoFailurePayload(payload)) normalizedStatus = 'failed';
    const base = {
      videoId,
      channelId: Number(channel.id),
      channelApiKeyId: Number(channel.apiKeyId) || null,
    };

    if (normalizedStatus === 'completed' || normalizedStatus === 'success') {
      if (!resultUrl && !isHmStudio && !isHaidiYue && !isMiaowu && !isLongxia && !isSudaShui) {
        resultUrl = `${baseUrl}/v1/files/video?id=${encodeURIComponent(videoId)}`;
      }
      if (!resultUrl) throw { status: 502, message: '上游任务已成功，但未返回视频地址' };
      return { ...base, status: 'completed', message: '上游任务已生成成功', upstreamResultUrl: resultUrl };
    }
    if (isVideoFailureStatus(normalizedStatus)) {
      return {
        ...base,
        status: 'failed',
        message: extractVideoFailureMessage(payload) || error || '上游任务生成失败',
      };
    }
    return {
      ...base,
      status: 'processing',
      message: '上游任务仍在生成中，请稍后重新获取',
      progress: Number(progress) || 0,
    };
  }

  static async recover(contentId: number) {
    const inspection = await this.inspect(contentId);
    if (inspection.status !== 'completed' || !inspection.upstreamResultUrl) return inspection;

    const beforeDownload = db.select().from(contents).where(eq(contents.id, contentId)).get();
    if (!beforeDownload) throw { status: 404, message: '任务记录不存在' };
    const beforeMetadata = parseMetadata(beforeDownload.metadata);
    if (beforeDownload.status === 'completed' && beforeDownload.resultUrl) {
      return { status: 'completed', message: '该任务已经恢复，无需重复扣费', item: beforeDownload, alreadyRecovered: true };
    }

    const localizedUrl = await downloadAndLocalizeVideo(
      inspection.upstreamResultUrl,
      inspection.videoId,
      beforeDownload.modelId || WX_HAIDIYUE_FACE_SPLIT_MODEL,
      inspection.channelId,
      inspection.channelApiKeyId,
    );
    if (!localizedUrl) throw { status: 502, message: '上游视频下载失败，尚未扣费' };

    return db.transaction(() => {
      const record = db.select().from(contents).where(eq(contents.id, contentId)).get();
      if (!record) throw { status: 404, message: '任务记录不存在' };
      const metadata = parseMetadata(record.metadata);
      if (record.status === 'completed' || metadata.recoveryCharged) {
        return { status: 'completed', message: '该任务已经恢复，无需重复扣费', item: record, alreadyRecovered: true };
      }

      const chargeAmount = recoveryChargeAmount(record, metadata);
      const tokenId = Number(metadata.tokenId) || 0;
      if (metadata.refundTarget === 'api_token' && tokenId) {
        const token = db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get();
        if (!token) throw { status: 409, message: '原 API Token 不存在，无法补扣费用' };
        if (token.balance !== -1 && token.balance < chargeAmount) {
          throw { status: 402, message: `上游已生成成功，但 API Token 余额不足 ¥${chargeAmount.toFixed(2)}，尚未恢复` };
        }
        TokenService.deductBalance(tokenId, chargeAmount);
      } else {
        const remainingBalance = BalanceService.deduct(record.userId, chargeAmount, 'generate_video_recovery', { contentId });
        if (remainingBalance === null) {
          throw { status: 402, message: `上游已生成成功，但用户余额不足 ¥${chargeAmount.toFixed(2)}，尚未恢复` };
        }
        if (tokenId) TokenService.deductBalance(tokenId, chargeAmount);
      }

      const recoveredAt = new Date().toISOString();
      metadata.recoveryCharged = true;
      metadata.recoveryChargeAmount = chargeAmount;
      metadata.recoveredAt = recoveredAt;
      metadata.refundReversedAt = recoveredAt;
      metadata.billingStatus = 'charged_after_recovery';
      metadata.queueRefunded = false;
      metadata.queueStatus = 'completed';
      metadata.progress = 100;
      metadata.completedAt = recoveredAt;
      metadata.localizedAt = recoveredAt;
      metadata.upstreamResultUrl = inspection.upstreamResultUrl;
      metadata.recoveryPreviousError = metadata.error || null;
      delete metadata.error;
      delete metadata.failedAt;

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
