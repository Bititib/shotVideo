import { sqlite } from '../db/index.js';
import { logImageRequestFailure, type ImageRequestContext } from './imageRequestDiagnostics.js';
import { ChannelService } from './channelService.js';
import { pollPidoiImage } from './pidoiImageAdapter.js';
import { finalizeReservedContent } from './contentBillingService.js';
import { localizeRecoveredImages } from './pidoiImageStorage.js';
import { restorePidoiJobs } from './pidoiImageEvidence.js';
import { pidoiContentUrl } from './pidoiImageResult.js';
import { upstreamDiagnostic } from './upstreamDiagnostic.js';

const active = new Set<number>();
export const pidoiImageActive = active;
const RECOVERY_WINDOW_MS = 30 * 60_000;
export async function recoverPidoiImage(contentId: number, options: { automatic?: boolean } = {}) {
  if (active.has(contentId)) return;
  active.add(contentId);
  const diagnostic: ImageRequestContext = { stage: 'persist', contentId };
  try {
    const row = sqlite.prepare('SELECT * FROM contents WHERE id=?').get(contentId) as any;
    if (!row || !['processing', 'review'].includes(row.status)) return;
    const m = JSON.parse(row.metadata || '{}');
    if (m.imageProtocol !== 'pidoi-async-v1' || m.managedSpecification) return;
    if (options.automatic && m.pidoiRecoveryPausedAt) return;
    // An explicit administrator recheck may resume the original task, never a POST.
    if (!options.automatic && m.pidoiRecoveryPausedAt) {
      delete m.pidoiRecoveryPausedAt;
      delete m.pidoiRecoveryPauseReason;
      delete m.pidoiRecoveryStartedAt;
    }
    m.pidoiRecoveryStartedAt ||= Date.now();
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
    if (options.automatic && Date.now() - m.pidoiRecoveryStartedAt >= RECOVERY_WINDOW_MS) {
      const reason = '自动恢复已达 30 分钟，已暂停；请管理员查询原任务或核实后处理，未重复生成';
      finalizeReservedContent(contentId, 'review', { ...m, pidoiRecoveryPausedAt: new Date().toISOString(), pidoiRecoveryPauseReason: reason, progressText: reason });
      return;
    }
    const channel = ChannelService.getChannelRaw(m.channelId, m.channelApiKeyId);
    if (!channel) throw new Error('原渠道不可用，已保留任务 ID，请管理员核对');
    for (const job of jobs) {
      if (job.localUrl || job.status === 'failed') continue;
      // A persisted successful receipt already contains the original result. Retry its
      // download directly, including administrator-verified asynchronous task receipts.
      if (!job.sourceUrl || job.status !== 'completed') {
        if (!job.taskId) continue; // Unknown submissions cannot be queried or resubmitted.
        Object.assign(diagnostic, { stage: 'poll', taskId: job.taskId, index: job.index });
        const task = job.pollPath ? await pollPidoiImage(channel, job.taskId, fetch, job.pollPath) : await pollPidoiImage(channel, job.taskId);
        if (task.status === 'processing' && task.raw?.data?.recovery_required === true) {
          const reason = upstreamDiagnostic('Pidoi', '上游要求核查原任务结果', { message: task.raw.message || 'recovery_required=true：上游要求管理员核查结果' });
          finalizeReservedContent(contentId, 'review', { ...m, pidoiRecoveryPausedAt: new Date().toISOString(), pidoiRecoveryPauseReason: reason, progressText: reason });
          return;
        }
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
      const fallback = m.pidoiFallbacks?.[job.index];
      if (fallback?.taskId === job.taskId && ['completed', 'failed'].includes(job.status)) fallback.status = job.status;
      m.progressText = job.status === 'completed' ? '图片已生成，正在保存' : '上游生成中';
      save();
      if (job.sourceUrl && job.status === 'completed') {
        Object.assign(diagnostic, { taskId: job.taskId, index: job.index });
        diagnostic.stage = 'download';
        // Signed Pidoi storage URLs must never receive the channel API key.
        const auth = pidoiContentUrl(job.sourceUrl, channel.baseUrl, job.taskId)
          ? { baseUrl: channel.baseUrl, apiKey: channel.apiKey, taskId: job.taskId } : undefined;
        const result = await localizeRecoveredImages([{ url: job.sourceUrl, channelId: 0, channelApiKeyId: null, ...(auth ? { auth } : {}) }], contentId, row.user_id, m.publicBaseUrl);
        if (!result.urls.length) throw result.failures?.[0] || new Error('图片下载暂未完成，将自动重试');
        diagnostic.stage = 'persist';
        job.localUrl = result.urls[0];
        delete m.lastRecoveryError;
        delete m.recoveryStage;
        m.imageUrls = jobs.map((j: any) => j.localUrl).filter(Boolean);
        save();
      }
    }
    if (jobs.length !== m.count) {
      const noRecoverableJobs = jobs.every((j: any) => j.localUrl || j.status === 'failed' || !j.taskId);
      const reason = '提交结果未知且无可查询任务，请管理员核对上游后处理；不会自动重新生成';
      finalizeReservedContent(contentId, 'review', { ...m,
        ...(noRecoverableJobs ? { pidoiRecoveryPausedAt: new Date().toISOString(), pidoiRecoveryPauseReason: reason } : {}),
        progressText: noRecoverableJobs ? reason : '部分提交结果未知，后台继续恢复已受理任务；不会重新生成' });
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
    if (diagnostic.stage === 'poll' && [404, 405].includes(error.status)) {
      const reason = `上游查询接口返回 ${error.status}，已暂停自动查询；这不代表生成失败，请核对原任务查询地址`;
      finalizeReservedContent(contentId, 'review', { ...recovery, pidoiRecoveryPausedAt: new Date().toISOString(), pidoiRecoveryPauseReason: reason, progressText: reason });
      return;
    }
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
      while (cursor < rows.length) { const row = rows[cursor++]; await recoverPidoiImage(row.id, { automatic: true }); }
    }));
  } finally { scanning = false; }
}
