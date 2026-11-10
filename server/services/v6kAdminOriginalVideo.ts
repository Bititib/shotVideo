import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db, sqlite } from '../db/index.js';
import { contents } from '../db/schema.js';
import { canDownloadV6kOriginal } from '../../shared/videoTaskSupplement.js';
import { isTaskIdPlaceholder } from '../../shared/upstreamTaskId.js';
import { ChannelService } from './channelService.js';
import { fetchVideoTaskResponse } from './videoPollDeadline.js';
import { normalizeZonghengTask, readZonghengTaskResponse, zonghengTaskMetadata, zonghengTaskUrl } from './zonghengAdapter.js';
import { zonghengTaskChannel, V6K_CHANNEL_TYPE } from './zonghengProtocol.js';
import { responseDiagnostic, transportDiagnostic } from './upstreamDiagnostic.js';
import { persistVideoSubmissionReceipt } from './videoSubmissionReceiptService.js';
import { videoSubmissionPending } from './videoSubmissionGuard.js';

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const restoring = new Set<number>();

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

function savedTaskIds(meta: Record<string, any>): string[] {
  return [meta.videoId, meta.upstreamTaskId, meta.upstream_task_id, meta.taskId, meta.task_id,
    ...(Array.isArray(meta.upstreamTaskIds) ? meta.upstreamTaskIds : [])]
    .filter(value => typeof value === 'string' && value.trim() && !isTaskIdPlaceholder(value))
    .map(value => value.trim());
}

function assertOwnership(contentId: number, taskId: string, meta: Record<string, any>) {
  if (sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='video_submission_receipts'").get()) {
    const receipts = sqlite.prepare(
      'SELECT content_id,upstream_task_id FROM video_submission_receipts WHERE content_id=? OR upstream_task_id=?'
    ).all(contentId, taskId) as { content_id: number; upstream_task_id: string }[];
    if (receipts.some(r => r.content_id !== contentId || r.upstream_task_id !== taskId))
      throw fail(409, '编号与本站已有回执冲突，请核对任务归属');
  }
  if (savedTaskIds(meta).some(value => value !== taskId))
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
      SELECT 1 FROM json_each(meta, '$.upstreamTaskIds') WHERE type = 'text' AND trim(value) = @taskId
    )) LIMIT 1
  `).get({ contentId, taskId }) as { id: number } | undefined;
  if (other) throw fail(409, '该编号已登记在本站订单 #' + other.id + '，请核对任务归属');
}

async function requestCompletedOriginal(meta: Record<string, any>, taskId: string) {
  const configured = ChannelService.getChannelRaw(Number(meta.channelId));
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

/** Store the already completed original and its receipt, outside the billing executor. */
export async function restoreV6kAdminOriginalVideo(contentId: number, actorId: number, candidate: unknown, confirmed: unknown) {
  const taskId = originalTaskId(contentId, candidate);
  if (!Number.isSafeInteger(actorId) || actorId <= 0 || confirmed !== true)
    throw fail(400, '请先确认该 V6K 编号确实属于原订单');
  const order = originalOrder(contentId);
  const { row, meta } = order;
  const result = (resultUrl: string, alreadyRestored: boolean) => ({
    id: contentId, status: 'completed' as const, taskId, resultUrl, alreadyRestored,
    message: alreadyRestored ? '原视频已恢复到该订单' : '已将原视频恢复到该订单，账务沿用原记录',
  });
  assertOwnership(contentId, taskId, meta);
  if (row.status === 'completed' && row.resultUrl && meta.v6kOriginalRestoration?.taskId === taskId)
    return result(row.resultUrl, true);
  assertEligible(order);
  if (row.resultUrl || savedTaskIds(meta).length || videoSubmissionPending(contentId, meta) || restoring.has(contentId))
    throw fail(409, '该订单已有结果、任务编号或正在处理，请刷新后核对');

  restoring.add(contentId);
  const fileBase = 'zongheng_restore_' + contentId + '_' + randomUUID();
  const directory = path.resolve('data/uploads/videos');
  const temp = path.join(directory, fileBase + '.part');
  let published = '';
  let committed = false;
  try {
    await fs.promises.mkdir(directory, { recursive: true });
    const { body, taskMetadata } = await requestCompletedOriginal(meta, taskId);
    try {
      await pipeline(Readable.fromWeb(body as any), fs.createWriteStream(temp, { flags: 'wx' }));
    } catch (error: any) {
      throw fail(502, '原视频未完整保存' + (typeof error?.code === 'string' ? '（' + error.code + '）' : ''));
    }
    const name = fileBase + '.' + videoExtension(temp);
    const resultUrl = '/uploads/videos/' + name;
    const restored = sqlite.transaction(() => {
      const current = originalOrder(contentId);
      assertOwnership(contentId, taskId, current.meta);
      if (current.row.status === 'completed' && current.row.resultUrl && current.meta.v6kOriginalRestoration?.taskId === taskId)
        return result(current.row.resultUrl, true);
      if (current.row.metadata !== row.metadata || current.row.status !== row.status
        || current.row.cost !== row.cost || current.row.resultUrl !== row.resultUrl || videoSubmissionPending(contentId, current.meta))
        throw fail(409, '保存期间原订单已变化，请刷新后核对');

      const at = new Date().toISOString();
      persistVideoSubmissionReceipt({ contentId, upstreamTaskId: taskId, provider: V6K_CHANNEL_TYPE,
        channelId: Number(meta.channelId), channelApiKeyId: Number(meta.channelApiKeyId) || null });
      const updated = {
        ...current.meta, ...taskMetadata, videoId: taskId, upstreamTaskId: taskId, videoSubmissionState: 'accepted',
        progress: 100, progresses: [100], completedAt: at,
        requiresReview: false, reviewKind: null, missingTaskIdReview: false, queueStatus: 'completed',
        videoDeliveryUnavailable: false, resultSaveError: null,
        recoveryPreviousError: meta.error || meta.recoveryPreviousError, error: null, failureReason: null,
        progressText: '原视频已恢复', v6kOriginalRestoration: { taskId, actorId, at },
      };
      const destination = path.join(directory, name);
      fs.renameSync(temp, destination);
      published = destination;
      db.update(contents).set({ status: 'completed', resultUrl, metadata: JSON.stringify(updated) }).where(eq(contents.id, contentId)).run();
      return result(resultUrl, false);
    }).immediate();
    committed = true;
    return restored;
  } finally {
    restoring.delete(contentId);
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    if (!committed && published) await fs.promises.rm(published, { force: true }).catch(() => {});
  }
}
