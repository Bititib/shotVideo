import { sqlite } from '../db/index.js';
import { logImageRequestFailure, type ImageRequestContext } from './imageRequestDiagnostics.js';
import { ChannelService } from './channelService.js';
import { pollPidoiImage } from './pidoiImageAdapter.js';
import { finalizeReservedContent } from './contentBillingService.js';
import { localizeRecoveredImages } from './pidoiImageStorage.js';
import { restorePidoiJobs } from './pidoiImageEvidence.js';

const active = new Set<number>();
export const pidoiImageActive = active;
export async function recoverPidoiImage(contentId: number) {
  if (active.has(contentId)) return;
  active.add(contentId);
  const diagnostic: ImageRequestContext = { stage: 'persist', contentId };
  try {
    const row = sqlite.prepare('SELECT * FROM contents WHERE id=?').get(contentId) as any;
    if (!row || !['processing', 'review'].includes(row.status)) return;
    const m = JSON.parse(row.metadata || '{}');
    if (m.imageProtocol !== 'pidoi-async-v1' || m.managedSpecification) return;
    const jobs = restorePidoiJobs(m);
    // Older versions classified a definite HTTP 451 rejection as an unknown
    // submission. Correct only single-image compatibility requests with matching
    // response evidence and no accepted jobs/results. Finalization uses the
    // reservation ledger transaction, so repeated scans cannot refund twice.
    if (row.status === 'review' && m.billingStatus === 'review'
      && m.pidoiSubmissionProtocol === 'openai-compatible' && m.count === 1
      && m.submissionFailure?.stage === 'submit' && m.submissionFailure.httpStatus === 451
      && Array.isArray(m.upstreamResponses) && m.upstreamResponses.length === 1
      && m.upstreamResponses[0]?.httpStatus === 451 && m.upstreamResponses[0]?.state === 'response_without_id'
      && !m.upstreamResponses[0]?.id
      && Array.isArray(m.pidoiImageJobs) && m.pidoiImageJobs.length === 0
      && !m.taskId && !m.upstreamTaskId && !m.requestId && !m.request_id
      && !m.task_id && !m.upstream_task_id && !m.upstreamTaskIds?.length
      && !jobs.length && !row.result_url && !m.imageUrls?.length && !m.upstreamImageUrls?.length) {
      const message = m.submissionFailure.message || '上游拒绝图片请求（HTTP 451）';
      finalizeReservedContent(contentId, 'failed', {
        submissionFailure: { ...m.submissionFailure, confirmedFailure: true },
        failureReason: message, progressText: message, failedAt: new Date().toISOString(),
        failureClassificationCorrection: { from: 'review', reason: 'http_451_rejection', at: new Date().toISOString() },
      });
      return;
    }
    diagnostic.channelId = m.channelId;
    const save = () => {
      const result = sqlite.prepare("UPDATE contents SET metadata=? WHERE id=? AND status IN ('processing','review')").run(JSON.stringify(m), contentId);
      if (result && result.changes === 0) throw new Error('任务已处理，停止恢复');
    };
    m.pidoiImageJobs = jobs;
    m.progresses ||= new Array(m.count || 1).fill(0);
    const ids = jobs.map((j: any) => j.taskId).filter(Boolean);
    if (ids.length) Object.assign(m, { upstreamTaskIds: ids, upstreamTaskId: ids[0], taskId: ids[0] });
    save();
    const channel = ChannelService.getChannelRaw(m.channelId, m.channelApiKeyId);
    if (!channel) throw new Error('原渠道不可用，已保留任务 ID，请管理员核对');
    for (const job of jobs) {
      if (job.localUrl || job.status === 'failed') continue;
      if (job.protocol !== 'openai-compatible' || !job.sourceUrl || job.status !== 'completed') {
        if (!job.taskId) continue; // Unknown submissions cannot be queried or resubmitted.
        Object.assign(diagnostic, { stage: 'poll', taskId: job.taskId, index: job.index });
        const task = job.pollPath ? await pollPidoiImage(channel, job.taskId, fetch, job.pollPath) : await pollPidoiImage(channel, job.taskId);
        delete m.lastRecoveryError;
        delete m.recoveryStage;
        diagnostic.stage = 'persist';
        // A previously delivered image must not be reclassified/refunded because
        // a later status response regresses while retrying its download.
        if (!(job.status === 'completed' && job.sourceUrl)) {
          job.status = task.status;
          job.error = task.error;
        }
        if (task.pollPath) job.pollPath = task.pollPath;
        if (task.imageUrl) job.sourceUrl = task.imageUrl;
        m.progresses[job.index] = task.progress;
      }
      m.upstreamImageUrls = jobs.map((j: any) => j.sourceUrl).filter(Boolean);
      m.progressText = job.status === 'completed' ? '图片已生成，正在保存' : '上游生成中';
      save();
      if (job.sourceUrl && job.status === 'completed') {
        Object.assign(diagnostic, { taskId: job.taskId, index: job.index });
        diagnostic.stage = 'download';
        // Signed Pidoi storage URLs must never receive the channel API key.
        const result = await localizeRecoveredImages([{ url: job.sourceUrl, channelId: 0, channelApiKeyId: null }], contentId, row.user_id, m.publicBaseUrl);
        if (!result.urls.length) throw result.failures?.[0] || new Error('图片下载暂未完成，将自动重试');
        diagnostic.stage = 'persist';
        job.localUrl = result.urls[0];
        m.imageUrls = jobs.map((j: any) => j.localUrl).filter(Boolean);
        save();
      }
    }
    if (jobs.length !== m.count) {
      finalizeReservedContent(contentId, 'review', { ...m, progressText: '部分提交结果未知，请核对；不会自动重新生成' });
    } else if (jobs.every((j: any) => j.localUrl)) {
      finalizeReservedContent(contentId, 'completed', { ...m, progresses: jobs.map(() => 100), completedAt: new Date().toISOString(), progressText: '图片生成完成' }, m.imageUrls[0]);
    } else if (jobs.every((j: any) => j.status === 'failed')) {
      finalizeReservedContent(contentId, 'failed', { ...m, failedAt: new Date().toISOString(), failureReason: jobs[0]?.error, progressText: '图片生成失败' });
    } else if (jobs.every((j: any) => j.localUrl || j.status === 'failed')) {
      const succeeded = jobs.filter((j: any) => j.localUrl);
      finalizeReservedContent(contentId, 'completed', { ...m, completedAt: new Date().toISOString(),
        failedImageIndexes: jobs.filter((j: any) => j.status === 'failed').map((j: any) => j.index),
        progressText: `已生成 ${succeeded.length} 张，失败部分已退款` }, succeeded[0].localUrl, succeeded.length / m.count);
    } else if (m.asyncStartedAt && Date.now() - m.asyncStartedAt > 20 * 60_000) {
      finalizeReservedContent(contentId, 'review', { ...m, progressText: '上游任务耗时较长，后台继续查询，请勿重复提交' });
    } else if (jobs.length === m.count) {
      m.requiresReview = false;
      m.recoveryStage = 'poll';
      m.failureReason = undefined;
      save();
      sqlite.prepare("UPDATE contents SET status='processing' WHERE id=? AND status='review'").run(contentId);
    }
  } catch (error: any) {
    logImageRequestFailure(diagnostic, error);
    const latest = sqlite.prepare('SELECT status,metadata FROM contents WHERE id=?').get(contentId) as any;
    if (!latest || !['processing', 'review'].includes(latest.status)) return;
    let metadata: any;
    try { metadata = JSON.parse(latest.metadata || '{}'); } catch { return; }
    const recovery = { ...metadata, recoveryStage: diagnostic.stage, lastRecoveryError: String(error.message || '恢复失败').slice(0, 200), lastRecoveryAt: new Date().toISOString() };
    if (diagnostic.stage === 'download') {
      Object.assign(recovery, { requiresReview: false, progressText: '图片已生成，保存失败，后台正在重试下载' });
      sqlite.prepare("UPDATE contents SET status='processing',metadata=? WHERE id=? AND status IN ('processing','review')").run(JSON.stringify(recovery), contentId);
      return;
    }
    sqlite.prepare("UPDATE contents SET metadata=? WHERE id=? AND status IN ('processing','review')").run(JSON.stringify(recovery), contentId);
    if (metadata.asyncStartedAt && Date.now() - metadata.asyncStartedAt > 20 * 60_000) {
      finalizeReservedContent(contentId, 'review', { progressText: '查询或下载暂不可用，后台继续恢复，请勿重复提交' });
    }
  } finally { active.delete(contentId); }
}
let scanning = false;
export async function resumePidoiImages() {
  if (scanning) return;
  scanning = true;
  try {
    const rows = sqlite.prepare("SELECT id FROM contents WHERE type='image' AND status IN ('processing','review') AND metadata LIKE '%pidoi-async-v1%'").all() as { id: number }[];
    // Slow status requests must not serially block every other accepted task.
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(3, rows.length) }, async () => {
      while (cursor < rows.length) { const row = rows[cursor++]; await recoverPidoiImage(row.id); }
    }));
  } finally { scanning = false; }
}
