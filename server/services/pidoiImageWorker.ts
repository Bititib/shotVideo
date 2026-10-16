import { sqlite } from '../db/index.js';
import { logImageRequestFailure, type ImageRequestContext } from './imageRequestDiagnostics.js';
import { ChannelService } from './channelService.js';
import { pollPidoiImage } from './pidoiImageAdapter.js';
import { finalizeReservedContent } from './contentBillingService.js';
import { localizeRecoveredImages } from './pidoiImageStorage.js';

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
    const channel = ChannelService.getChannelRaw(m.channelId, m.channelApiKeyId);
    if (!channel) return;
    diagnostic.channelId = m.channelId;
    const save = () => sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?').run(JSON.stringify(m), contentId);
    const jobs = m.pidoiImageJobs || [];
    for (const job of jobs) {
      if (job.localUrl || job.status === 'failed') continue;
      if (job.protocol !== 'openai-compatible' || !job.sourceUrl || job.status !== 'completed') {
        if (!job.taskId) continue; // Unknown submissions cannot be queried or resubmitted.
        Object.assign(diagnostic, { stage: 'poll', taskId: job.taskId, index: job.index });
        const task = await pollPidoiImage(channel, job.taskId);
        diagnostic.stage = 'persist';
        job.status = task.status;
        job.error = task.error;
        if (task.imageUrl) job.sourceUrl = task.imageUrl;
        m.progresses[job.index] = task.progress;
      }
      m.upstreamImageUrls = jobs.map((j: any) => j.sourceUrl).filter(Boolean);
      m.progressText = job.status === 'completed' ? '图片已生成，正在保存' : '上游生成中';
      save();
      if (job.sourceUrl) {
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
      finalizeReservedContent(contentId, 'review', { ...m, progressText: '部分图片成功，待核对结算' });
    } else if (m.asyncStartedAt && Date.now() - m.asyncStartedAt > 20 * 60_000) {
      finalizeReservedContent(contentId, 'review', { ...m, progressText: '上游任务耗时较长，后台继续查询，请勿重复提交' });
    }
  } catch (error: any) {
    logImageRequestFailure(diagnostic, error);
    const latest = sqlite.prepare('SELECT metadata FROM contents WHERE id=?').get(contentId) as any;
    const metadata = JSON.parse(latest?.metadata || '{}');
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
    for (const row of rows) await recoverPidoiImage(row.id);
  } finally { scanning = false; }
}
