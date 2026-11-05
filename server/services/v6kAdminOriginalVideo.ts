import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { contents } from '../db/schema.js';
import { canDownloadV6kOriginal } from '../../shared/videoTaskSupplement.js';
import { isTaskIdPlaceholder } from '../../shared/upstreamTaskId.js';
import { ChannelService } from './channelService.js';
import { fetchVideoTaskResponse } from './videoPollDeadline.js';
import { normalizeZonghengTask, readZonghengTaskResponse, zonghengTaskUrl } from './zonghengAdapter.js';
import { zonghengTaskChannel, V6K_CHANNEL_TYPE } from './zonghengProtocol.js';
import { responseDiagnostic, transportDiagnostic } from './upstreamDiagnostic.js';

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

/** Admin download only. Never bind the candidate, resume polling, or enter settlement. */
export async function downloadV6kAdminOriginalVideo(contentId: number, candidate: unknown) {
  const taskId = typeof candidate === 'string' ? candidate.trim() : '';
  if (!Number.isSafeInteger(contentId) || contentId <= 0 || !/^task_[A-Za-z0-9_-]{1,250}$/.test(taskId))
    throw fail(400, '请输入 V6K 确认对应原订单的完整 task_ 编号');

  const row = db.select().from(contents).where(eq(contents.id, contentId)).get();
  if (!row) throw fail(404, '订单不存在');
  const meta = JSON.parse(row.metadata || '{}') || {};
  if (!canDownloadV6kOriginal(row, meta) || !meta.upstreamModel || !meta.zonghengBaseUrl)
    throw fail(409, '该订单缺少原 V6K 渠道、接口地址或模型记录');

  if (sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='video_submission_receipts'").get()) {
    const receipts = sqlite.prepare(
      'SELECT content_id,upstream_task_id FROM video_submission_receipts WHERE content_id=? OR upstream_task_id=?'
    ).all(contentId, taskId) as { content_id: number; upstream_task_id: string }[];
    if (receipts.some(r => r.content_id !== contentId || r.upstream_task_id !== taskId))
      throw fail(409, '编号与本站已有回执冲突，请核对任务归属');
  }
  const savedIds = [meta.videoId, meta.upstreamTaskId, meta.upstream_task_id, meta.taskId, meta.task_id,
    ...(Array.isArray(meta.upstreamTaskIds) ? meta.upstreamTaskIds : [])];
  if (savedIds.some(value => typeof value === 'string' && value.trim() && !isTaskIdPlaceholder(value) && value.trim() !== taskId))
    throw fail(409, '该订单已有不同的上游任务编号');

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
  return { body: response.body, contentType };
}
