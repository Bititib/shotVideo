import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db, sqlite } from '../db/index.js';
import { contents } from '../db/schema.js';
import { canDownloadV6kOriginal, canRestoreOriginalVideo, recordedVideoTaskIds } from '../../shared/videoTaskSupplement.js';
import { isTaskIdPlaceholder } from '../../shared/upstreamTaskId.js';
import { ChannelService } from './channelService.js';
import { fetchVideoTaskResponse } from './videoPollDeadline.js';
import { normalizeZonghengTask, readZonghengTaskResponse, zonghengTaskMetadata, zonghengTaskUrl } from './zonghengAdapter.js';
import { zonghengTaskChannel, V6K_CHANNEL_TYPE } from './zonghengProtocol.js';
import { responseDiagnostic, transportDiagnostic } from './upstreamDiagnostic.js';
import { findVideoSubmissionReceipt, persistVideoSubmissionReceipt } from './videoSubmissionReceiptService.js';
import { videoSubmissionPending } from './videoSubmissionGuard.js';
import { pollSpecificationVideo } from './specificationAdapters.js';
import { assertZhiyingOriginalChannel } from './zhiyingVideoExecution.js';
import { downloadAndLocalizeVideo } from './videoLocalizationService.js';
import { isSnumomWanChannel, snumomContentUrl } from './snumomWanAdapter.js';
import { isJulunChannel } from './julunMinimaxAdapter.js';
import { activeSpecificationTasks, beginTaskIdVerification } from './videoRecoveryAction.js';
import { settleOriginalVideoBilling } from './originalVideoBilling.js';

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

function originalTaskId(contentId: number, candidate: unknown) {
  const taskId = typeof candidate === 'string' ? candidate.trim() : '';
  if (!Number.isSafeInteger(contentId) || contentId <= 0 || !/^task_[A-Za-z0-9_-]{1,250}$/.test(taskId))
    throw fail(400, '请输入 V6K 确认对应原订单的完整 task_ 编号');
  return taskId;
}

function originalOrder(contentId: number) {
  const row = db.select().from(contents).where(eq(contents.id, contentId)).get();
  if (!row) throw fail(404, '订单不存在');
  const meta: Record<string, any> = JSON.parse(row.metadata || '{}') || {};
  return { row, meta };
}

function assertEligible({ row, meta }: ReturnType<typeof originalOrder>) {
  if (!canDownloadV6kOriginal(row, meta) || !meta.upstreamModel || !meta.zonghengBaseUrl)
    throw fail(409, '该订单缺少原 V6K 渠道、接口地址或模型记录');
}

function originalChannel(contentId: number, meta: Record<string, any>) {
  const receipt = findVideoSubmissionReceipt(contentId);
  const channelId = Number(receipt?.channelId ?? meta.channelId);
  const keyId = Number(receipt?.channelApiKeyId ?? meta.channelApiKeyId) || null;
  if ((meta.channelId && Number(meta.channelId) !== channelId)
    || (meta.channelApiKeyId && Number(meta.channelApiKeyId) !== keyId))
    throw fail(409, '原订单与回执的渠道或密钥记录不一致');
  const channel = ChannelService.getChannelRaw(channelId, keyId);
  if (!channel?.apiKey || (channel.type === 'hmstudio' && !keyId)
    || (keyId && channel.apiKeyId !== keyId))
    throw fail(409, '缺少可核验的原渠道或执行密钥');
  if (meta.actualChannel && meta.actualChannel !== channel.type && !(meta.actualChannel === 'julun' && isJulunChannel(channel)))
    throw fail(409, '原订单的渠道协议与当前配置不一致');
  if (channel.type === 'zhiying' || meta.zhiyingOrder) assertZhiyingOriginalChannel(channel, meta);
  return { channel, receipt };
}

function currentBatchItem(order: ReturnType<typeof originalOrder>) {
  if (!order.meta.batchItemId) return null;
  const item = sqlite.prepare('SELECT content_id,user_id,status,result_url FROM video_batch_items WHERE id=?')
    .get(order.meta.batchItemId) as { content_id: number; user_id: number; status: string; result_url: string | null } | undefined;
  if (!item || item.content_id !== order.row.id || item.user_id !== order.row.userId
    || !['review', 'failed'].includes(item.status) || item.result_url)
    throw fail(409, '批量子任务仍在运行、已有成品或已被新尝试替换，请核对当前订单');
  return item;
}

async function saveChannelOriginal(order: ReturnType<typeof originalOrder>,
  channel: NonNullable<ReturnType<typeof ChannelService.getChannelRaw>>, taskId: string, fileId: string) {
  const { row, meta } = order;
  const model = meta.actualModel || row.modelId || '';
  try {
    const task = await pollSpecificationVideo(channel, taskId, model, meta.referenceVideoSeconds || 0,
      { upstreamModel: meta.upstreamModel, legacy: !meta.managedSpecification });
    if (!['completed', 'success', 'succeeded', 'done'].includes(task.status))
      throw fail(409, '上游原任务尚无已完成成品' + (task.error ? '：' + task.error : '（' + (task.status || '状态未知') + '）'));
    const source = task.resultUrl || (isSnumomWanChannel(channel) ? snumomContentUrl(channel.baseUrl, taskId) : '');
    if (!source) throw fail(409, '上游已完成，但尚未返回原视频地址');
    return await downloadAndLocalizeVideo(source, taskId, model, channel.id, channel.apiKeyId, undefined, meta.zhiyingCredential, { channel, fileId });
  } catch (error: any) {
    throw fail(error?.status === 409 ? 409 : 502, transportDiagnostic(channel.type, '查询并取回原视频', error, channel.apiKey));
  }
}

function assertOwnership(contentId: number, taskId: string, meta: Record<string, any>) {
  if (sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='video_submission_receipts'").get()) {
    const receipts = sqlite.prepare(
      'SELECT content_id,upstream_task_id FROM video_submission_receipts WHERE content_id=? OR upstream_task_id=?'
    ).all(contentId, taskId) as { content_id: number; upstream_task_id: string }[];
    const owner = receipts.find(r => r.upstream_task_id === taskId && r.content_id !== contentId);
    if (owner) throw fail(409, `编号与本站已有回执冲突：该任务已登记在订单 #${owner.content_id}，不能恢复到 #${contentId}。请打开 #${owner.content_id} 查看原视频，或核对本单的正确任务编号。`);
    const existing = receipts.find(r => r.content_id === contentId && r.upstream_task_id !== taskId);
    if (existing) throw fail(409, `订单 #${contentId} 已保存另一任务编号 ${existing.upstream_task_id}，不能覆盖原回执。请使用已保存的编号恢复。`);
  }
  if (recordedVideoTaskIds(meta).some(value => value !== taskId))
    throw fail(409, '该订单已有不同的上游任务编号');

  // Older orders may only have the ID in their metadata.
  const other = sqlite.prepare(`
    WITH video_metadata AS (
      SELECT id, CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END AS meta
      FROM contents WHERE id <> @contentId AND type = 'video'
    )
    SELECT id FROM video_metadata WHERE @taskId IN (
      trim(json_extract(meta, '$.videoId')), trim(json_extract(meta, '$.upstreamTaskId')),
      trim(json_extract(meta, '$.upstream_task_id')), trim(json_extract(meta, '$.taskId')),
      trim(json_extract(meta, '$.task_id'))
    ) OR (json_type(meta, '$.upstreamTaskIds') = 'array' AND EXISTS (
      SELECT 1 FROM json_each(meta, '$.upstreamTaskIds') WHERE type IN ('text', 'integer') AND trim(value) = @taskId
    )) LIMIT 1
  `).get({ contentId, taskId }) as { id: number } | undefined;
  if (other) throw fail(409, '该编号已登记在本站订单 #' + other.id + '，请核对任务归属');
}

async function requestCompletedOriginal(meta: Record<string, any>, taskId: string, configured = ChannelService.getChannelRaw(Number(meta.channelId))) {
  if (configured?.type !== V6K_CHANNEL_TYPE || !configured.apiKey) throw fail(409, '原 V6K 渠道或密钥不可用');
  const channel = zonghengTaskChannel(configured, meta);
  const base = new URL(channel.baseUrl);
  if (!['https://www.v6k.top', 'https://v6k.top'].includes(base.origin) || base.username || base.password
    || base.pathname !== '/' || base.search || base.hash) throw fail(409, '原接口地址不是已核验的 V6K 地址');

  const url = zonghengTaskUrl(base.origin, taskId);
  const headers = { Authorization: 'Bearer ' + channel.apiKey, 'Cache-Control': 'no-cache, no-store' };
  const receipt = await fetchVideoTaskResponse(url, { method: 'GET', headers, redirect: 'error' })
    .catch(error => { throw fail(502, transportDiagnostic('V6K', '查询原任务', error, channel.apiKey)); });
  const payload = await readZonghengTaskResponse(receipt, base.origin, taskId, channel.apiKey)
    .catch(error => { throw fail(502, error.message); });
  if (payload.model !== meta.upstreamModel) throw fail(409, '候选任务的上游模型与原订单不一致，请核对编号');
  if (payload.status !== 'completed') {
    const task = normalizeZonghengTask(payload, base.origin, 'v6k', taskId);
    throw fail(409, '上游任务状态为 ' + task.upstreamStatus + (task.error ? '：' + task.error : '，暂无已完成成品'));
  }

  const response = await fetch(url + '/content', { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(300_000) })
    .catch(error => { throw fail(502, transportDiagnostic('V6K', '下载原视频', error, channel.apiKey)); });
  if (!response.ok) throw fail(502, await responseDiagnostic('V6K', '下载原视频', response, channel.apiKey));
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (response.status !== 200 || !response.body || !/^(?:video\/[a-z0-9.+-]+|application\/octet-stream)$/.test(contentType)) {
    await response.body?.cancel();
    throw fail(502, 'V6K 成品接口未返回完整的视频文件');
  }
  return { body: response.body, contentType, taskMetadata: zonghengTaskMetadata(payload, base.origin, 'v6k', taskId) };
}

/** The existing download action returns bytes without writing to the order. */
export async function downloadV6kAdminOriginalVideo(contentId: number, candidate: unknown) {
  const taskId = originalTaskId(contentId, candidate);
  const order = originalOrder(contentId);
  assertEligible(order);
  assertOwnership(contentId, taskId, order.meta);
  const { body, contentType } = await requestCompletedOriginal(order.meta, taskId);
  return { body, contentType };
}

function videoExtension(file: string): 'mp4' | 'webm' {
  const header = Buffer.alloc(12);
  const fd = fs.openSync(file, 'r');
  let length: number;
  try { length = fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
  if (length === 12 && header.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  if (length === 12 && header.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  throw fail(502, 'V6K 成品文件为空或格式无效');
}

function settleDeliveredOriginal(row: ReturnType<typeof originalOrder>['row'], updated: Record<string, any>, resultUrl: string) {
  let cost = row.cost, chargedAmount = 0;
  try {
    const settled = settleOriginalVideoBilling(row, updated);
    updated = settled.metadata; cost = settled.cost; chargedAmount = settled.chargedAmount;
    Object.assign(updated, { originalVideoBillingPending: false, originalVideoBillingError: null, requiresReview: false, reviewKind: null });
  } catch (error: any) {
    // Keep the completed file and receipt; an accounting problem must not lose the video.
    Object.assign(updated, { originalVideoBillingPending: true, originalVideoBillingError: error.message || '原订单结算失败',
      requiresReview: true, reviewKind: 'settlement', progressText: '原视频已恢复，费用待结算' });
  }
  db.update(contents).set({ status: 'completed', cost, resultUrl, metadata: JSON.stringify(updated) }).where(eq(contents.id, row.id)).run();
  if (updated.batchItemId) sqlite.prepare("UPDATE video_batch_items SET status='completed',result_url=?,error=NULL,finished_at=datetime('now') WHERE id=?")
    .run(resultUrl, updated.batchItemId);
  return { billingPending: updated.originalVideoBillingPending === true, chargedAmount, cost,
    billingError: updated.originalVideoBillingError || null };
}

/** Restore only the original, then settle its original ledger once the file is available. */
export async function restoreAdminOriginalVideo(contentId: number, actorId: number, candidate: unknown, confirmed: unknown, v6kOnly = false) {
  if (!Number.isSafeInteger(contentId) || contentId <= 0) throw fail(400, '订单编号无效');
  if (!Number.isSafeInteger(actorId) || actorId <= 0 || confirmed !== true)
    throw fail(400, '请先确认该上游编号确实属于原订单');
  const order = originalOrder(contentId);
  const { row, meta } = order;
  const entered = typeof candidate === 'string' ? candidate.trim() : '';
  const taskId = entered || recordedVideoTaskIds(meta)[0] || findVideoSubmissionReceipt(contentId)?.upstreamTaskId || '';
  if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(taskId) || ['.', '..'].includes(taskId) || isTaskIdPlaceholder(taskId))
    throw fail(400, '请输入上游核实过的原任务编号');
  const result = (resultUrl: string, alreadyRestored: boolean, billing?: ReturnType<typeof settleDeliveredOriginal>) => ({
    id: contentId, status: 'completed' as const, taskId, resultUrl, alreadyRestored,
    ...billing,
    message: billing?.billingPending ? '视频已恢复到用户订单，费用待结算：' + billing.billingError
      : alreadyRestored ? '原视频已恢复并结算，无需重复扣费'
      : '原视频已恢复到用户订单，' + (billing?.chargedAmount ? `已按原金额补扣 ¥${billing.chargedAmount.toFixed(2)}` : '已使用原扣款结算，未重复扣费'),
  });
  assertOwnership(contentId, taskId, meta);
  if (row.status === 'completed' && row.resultUrl && (meta.originalVideoRestoration || meta.v6kOriginalRestoration)?.taskId === taskId) {
    const release = beginTaskIdVerification(contentId);
    try {
      return sqlite.transaction(() => {
        const current = originalOrder(contentId);
        assertOwnership(contentId, taskId, current.meta);
        if (current.meta.originalVideoBilling && !current.meta.originalVideoBillingPending) return result(row.resultUrl!, true);
        if (!/^\/uploads\/videos\/(?:zongheng_restore_|video_original_restore_)\w[\w.-]*\.(?:mp4|webm)$/.test(row.resultUrl!)
          || !fs.existsSync(path.resolve('data', row.resultUrl!.slice(1)))) throw fail(409, '已恢复的本地原视频文件不存在，请先核对文件');
        return result(row.resultUrl!, false, settleDeliveredOriginal(current.row, current.meta, row.resultUrl!));
      }).immediate();
    } finally { release(); }
  }
  if (!canRestoreOriginalVideo({ ...row, status: row.status || '' }, meta)
    || videoSubmissionPending(contentId, meta) || activeSpecificationTasks.has(contentId))
    throw fail(409, '该订单已有成品、仍在处理或当前状态不可恢复');
  currentBatchItem(order);
  const { channel, receipt } = originalChannel(contentId, meta);
  const v6k = channel.type === V6K_CHANNEL_TYPE;
  if (v6kOnly && !v6k) throw fail(409, '该订单不属于 V6K 渠道');
  if (v6k) {
    originalTaskId(contentId, taskId);
    if (meta.zonghengProtocol !== 'v6k' || !meta.upstreamModel || !meta.zonghengBaseUrl)
      throw fail(409, '该订单缺少原 V6K 接口地址或模型记录');
  }

  const release = beginTaskIdVerification(contentId);
  const fileBase = (v6k ? 'zongheng_restore_' : 'original_restore_') + contentId + '_' + randomUUID();
  const directory = path.resolve('data/uploads/videos');
  const temp = path.join(directory, fileBase + '.part');
  let published = '';
  let committed = false;
  try {
    const { activePolls } = await import('../routes/video.js');
    if (activePolls.has(contentId)) throw fail(409, '后台仍在查询或保存此任务，请稍后刷新');
    await fs.promises.mkdir(directory, { recursive: true });
    let taskMetadata = {};
    let resultUrl: string;
    if (v6k) {
      const original = await requestCompletedOriginal(meta, taskId, channel);
      taskMetadata = original.taskMetadata;
      try {
        await pipeline(Readable.fromWeb(original.body as any), fs.createWriteStream(temp, { flags: 'wx' }));
      } catch (error: any) {
        throw fail(502, '原视频未完整保存' + (typeof error?.code === 'string' ? '（' + error.code + '）' : ''));
      }
      resultUrl = '/uploads/videos/' + fileBase + '.' + videoExtension(temp);
    } else {
      resultUrl = await saveChannelOriginal(order, channel, taskId, fileBase);
      const name = path.posix.basename(resultUrl);
      if (!resultUrl.startsWith('/uploads/videos/video_' + fileBase + '.') || resultUrl !== '/uploads/videos/' + name)
        throw fail(502, '原视频未保存到独立的成品文件');
      published = path.join(directory, name);
      videoExtension(published);
    }
    const restored = sqlite.transaction(() => {
      const current = originalOrder(contentId);
      assertOwnership(contentId, taskId, current.meta);
      if (current.row.status === 'completed' && current.row.resultUrl && (current.meta.originalVideoRestoration || current.meta.v6kOriginalRestoration)?.taskId === taskId)
        return result(current.row.resultUrl, true);
      if (current.row.metadata !== row.metadata || current.row.status !== row.status
        || current.row.cost !== row.cost || current.row.resultUrl !== row.resultUrl || videoSubmissionPending(contentId, current.meta))
        throw fail(409, '保存期间原订单已变化，请刷新后核对');
      currentBatchItem(current);
      const liveChannel = originalChannel(contentId, current.meta).channel;
      if (liveChannel.id !== channel.id || liveChannel.type !== channel.type || liveChannel.baseUrl !== channel.baseUrl
        || liveChannel.apiKey !== channel.apiKey || liveChannel.apiKeyId !== channel.apiKeyId)
        throw fail(409, '保存期间原渠道配置已变化，请刷新后核对');

      const at = new Date().toISOString();
      persistVideoSubmissionReceipt({ contentId, upstreamTaskId: taskId, provider: receipt?.provider || channel.type,
        channelId: channel.id, channelApiKeyId: channel.apiKeyId });
      const updated = {
        ...current.meta, ...taskMetadata, videoId: taskId, upstreamTaskId: taskId, videoSubmissionState: 'accepted',
        channelId: channel.id, channelApiKeyId: channel.apiKeyId,
        upstreamGenerated: true, upstreamStatus: 'completed', upstreamDeliveryPending: false,
        progress: 100, progresses: [100], completedAt: at,
        requiresReview: false, reviewKind: null, missingTaskIdReview: false, queueStatus: 'completed',
        videoDeliveryUnavailable: false, resultSaveError: null,
        recoveryPreviousError: meta.error || meta.recoveryPreviousError, error: null, failureReason: null,
        progressText: '原视频已恢复', originalVideoRestoration: { taskId, actorId, at },
        ...(v6k ? { v6kOriginalRestoration: { taskId, actorId, at } } : {}),
      };
      if (v6k) {
        const destination = path.join(directory, path.posix.basename(resultUrl));
        fs.renameSync(temp, destination);
        published = destination;
      }
      return result(resultUrl, false, settleDeliveredOriginal(current.row, updated, resultUrl));
    }).immediate();
    committed = !restored.alreadyRestored;
    return restored;
  } finally {
    release();
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    if (!committed && published) await fs.promises.rm(published, { force: true }).catch(() => {});
  }
}
