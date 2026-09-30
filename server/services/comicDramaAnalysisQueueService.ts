import { sqlite } from '../db/index.js';
import { logUsage } from '../middleware/quota.js';
import { AIService } from './aiService.js';
import { ComicDramaProjectService } from './comicDramaProjectService.js';

type ModelConfig = { id: number; modelId: string; apiKey: string | null } | undefined;
type AnalysisJob = { projectId: number; userId: number; episodeIds: number[]; modelConfig: ModelConfig };

const waiting: AnalysisJob[] = [];
const activeProjects = new Set<number>();
let activeJobs = 0;
const MAX_ACTIVE_PROJECTS = 2;

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '未知错误');
  return message.slice(0, 500);
}

async function runJob(job: AnalysisJob) {
  activeJobs += 1;
  activeProjects.add(job.projectId);
  try {
    for (const episodeId of job.episodeIds) {
      const episode: any = ComicDramaProjectService.getEpisode(job.projectId, episodeId, job.userId);
      if (!episode || episode.status !== 'analysis_queued') continue;
      const startedAt = Date.now();
      ComicDramaProjectService.setEpisodeAnalysisStatus(job.projectId, episodeId, job.userId, 'analyzing');
      try {
        const project: any = ComicDramaProjectService.get(job.projectId, job.userId);
        if (!project) throw new Error('漫剧项目不存在');
        const blueprint = await AIService.analyzeComicDramaScript(String(episode.script || '').trim(), job.modelConfig, {
          visualStyle: project.blueprint?.visualStyle,
          sharedAssets: project.state?.sharedAssets || [],
        });
        ComicDramaProjectService.saveEpisodeAnalysis(job.projectId, episodeId, job.userId, episode.script, blueprint);
        logUsage(job.userId, 'comic_drama_script', job.modelConfig?.id, Date.now() - startedAt, 'success');
      } catch (error) {
        ComicDramaProjectService.setEpisodeAnalysisStatus(job.projectId, episodeId, job.userId, 'analysis_failed', errorMessage(error));
        logUsage(job.userId, 'comic_drama_script', job.modelConfig?.id, Date.now() - startedAt, 'failed');
      }
    }
  } finally {
    ComicDramaProjectService.finishBatchAnalysis(job.projectId, job.userId);
    activeProjects.delete(job.projectId);
    activeJobs -= 1;
    queueMicrotask(tick);
  }
}

function tick() {
  while (activeJobs < MAX_ACTIVE_PROJECTS) {
    const index = waiting.findIndex(job => !activeProjects.has(job.projectId));
    if (index < 0) return;
    const [job] = waiting.splice(index, 1);
    void runJob(job);
  }
}

// 进程重启时内存中的模型密钥不会被持久化。把中断任务明确标为失败，允许用户一键重试。
try {
  const stale = sqlite.prepare("SELECT DISTINCT project_id, user_id FROM comic_drama_episodes WHERE status IN ('analysis_queued','analyzing')").all() as any[];
  sqlite.prepare(`UPDATE comic_drama_episodes SET status = 'analysis_failed',
    state = json_set(CASE WHEN json_valid(state) THEN state ELSE '{}' END, '$.analysisError', '服务重启导致分析中断，请重试'),
    updated_at = datetime('now') WHERE status IN ('analysis_queued','analyzing')`).run();
  for (const row of stale) ComicDramaProjectService.finishBatchAnalysis(Number(row.project_id), Number(row.user_id));
} catch (error) {
  console.warn('[comic-drama-analysis] 恢复中断任务失败:', error);
}

export class ComicDramaAnalysisQueueService {
  static enqueue(job: AnalysisJob) {
    if (!job.episodeIds.length) return;
    waiting.push(job);
    tick();
  }
}
