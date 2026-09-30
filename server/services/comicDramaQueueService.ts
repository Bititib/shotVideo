import jwt from 'jsonwebtoken';
import { sqlite } from '../db/index.js';
import { env } from '../config/env.js';

type TaskRow = { id: number; project_id: number; episode_id: number; user_id: number; kind: string; entity_key: string; status: string; payload: string; result_url?: string | null; attempts: number };

const active = new Set<number>();
const cancelled = new Set<number>();
const pending: number[] = [];
const MAX_ACTIVE_PROJECTS = 2;

function drain() {
  while (active.size < MAX_ACTIVE_PROJECTS && pending.length) {
    const projectId = pending.shift()!;
    if (active.has(projectId)) continue;
    void runProject(projectId).finally(() => drain());
  }
}

function json<T>(value: unknown, fallback: T): T { try { return JSON.parse(String(value || '')) as T; } catch { return fallback; } }

async function consumeSse(endpoint: string, token: string, body: any, resultField: 'imageUrl' | 'videoUrl'): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${env.PORT}${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  if (!response.ok) { const payload: any = await response.json().catch(() => ({})); throw new Error(payload.error || `生成请求失败 (${response.status})`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('生成接口没有返回任务流');
  const decoder = new TextDecoder(); let buffer = ''; let lastResult = ''; let contentId = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n'); buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      const event = json<any>(line.slice(6), {});
      if (event.type === 'error') throw new Error(event.message || '生成失败');
      if (event.contentId) contentId = Number(event.contentId);
      if (event[resultField]) lastResult = event[resultField];
      if (resultField === 'imageUrl' && event.imageUrls?.[0]) lastResult = event.imageUrls[0];
    }
  }
  if (!lastResult && contentId) {
    for (let attempt = 0; attempt < 360; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5_000));
      const statusResponse = await fetch(`http://127.0.0.1:${env.PORT}/api/contents/${contentId}`, { headers: { Authorization: `Bearer ${token}` } });
      const content: any = await statusResponse.json().catch(() => ({}));
      if (content.status === 'completed' && content.resultUrl) { lastResult = content.resultUrl; break; }
      if (content.status === 'failed') throw new Error(content.metadata?.error || content.error || '后台生成失败');
    }
  }
  if (!lastResult) throw new Error('生成完成但没有返回结果地址');
  return lastResult;
}

async function postJson(endpoint: string, token: string, body: any) {
  const response = await fetch(`http://127.0.0.1:${env.PORT}${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload;
}

function updateTask(task: TaskRow, patch: { status: string; resultUrl?: string | null; attempts?: number; qualityScore?: number | null; qualityReport?: any }) {
  sqlite.prepare(`UPDATE comic_drama_tasks SET status=?, result_url=?, attempts=?, quality_score=?, quality_report=?, updated_at=datetime('now') WHERE id=?`)
    .run(patch.status, patch.resultUrl ?? task.result_url ?? null, patch.attempts ?? task.attempts, patch.qualityScore ?? null, patch.qualityReport ? JSON.stringify(patch.qualityReport) : null, task.id);
}

function syncSharedAsset(projectId: number, payload: any, resultUrl: string, qualityScore?: number | null, qualityReport?: any) {
  const row = sqlite.prepare('SELECT state FROM comic_drama_projects WHERE id=?').get(projectId) as any;
  const state = json<any>(row?.state, {}); const sharedAssets = Array.isArray(state.sharedAssets) ? [...state.sharedAssets] : [];
  const index = sharedAssets.findIndex((asset: any) => asset.kind === payload.assetKind && asset.name === payload.name);
  const next = { ...(index >= 0 ? sharedAssets[index] : {}), name: payload.name, kind: payload.assetKind, prompt: payload.assetPrompt, aliases: payload.aliases || [], variant: payload.variant || '基础造型', locked: !!payload.locked, status: 'done', url: resultUrl, qualityScore, qualityReport };
  if (index >= 0) sharedAssets[index] = next; else sharedAssets.push(next);
  sqlite.prepare("UPDATE comic_drama_projects SET state=?, updated_at=datetime('now') WHERE id=?").run(JSON.stringify({ ...state, sharedAssets }), projectId);
}

async function runProject(projectId: number) {
  if (active.has(projectId)) return;
  active.add(projectId);
  cancelled.delete(projectId);
  try {
    const project = sqlite.prepare('SELECT * FROM comic_drama_projects WHERE id=?').get(projectId) as any;
    if (!project) return;
    const user = sqlite.prepare('SELECT id, role, org_id FROM users WHERE id=? AND is_active=1').get(project.user_id) as any;
    if (!user) throw new Error('项目用户不存在或已停用');
    const token = jwt.sign({ userId: user.id, role: user.role, orgId: user.org_id || null }, env.JWT_SECRET, { expiresIn: '7d' });
    const projectState = json<any>(project.state, {});
    const targetEpisodeIds = projectState.managedScope === 'all'
      ? (sqlite.prepare("SELECT id FROM comic_drama_episodes WHERE project_id=? AND blueprint!='{}' ORDER BY episode_number").all(projectId) as any[]).map(row => Number(row.id))
      : [Number(projectState.activeEpisodeId || 0)].filter(Boolean);
    if (!targetEpisodeIds.length) throw new Error('没有可托管的剧集');
    const episodePlaceholders = targetEpisodeIds.map(() => '?').join(',');
    const episodeCache = new Map<number, { blueprint: any; state: any }>();
    const getContext = (task: TaskRow) => {
      let context = episodeCache.get(task.episode_id);
      if (!context) {
        const episode = sqlite.prepare('SELECT blueprint, state FROM comic_drama_episodes WHERE id=?').get(task.episode_id) as any;
        context = { blueprint: json<any>(episode?.blueprint, {}), state: json<any>(episode?.state, {}) };
        episodeCache.set(task.episode_id, context);
      }
      return context;
    };
    sqlite.prepare("UPDATE comic_drama_projects SET status='producing', updated_at=datetime('now') WHERE id=?").run(projectId);
    sqlite.prepare("UPDATE comic_drama_episodes SET status='producing', updated_at=datetime('now') WHERE project_id=? AND status='queued'").run(projectId);

    {
      const tasks = sqlite.prepare(`SELECT * FROM comic_drama_tasks WHERE project_id=? AND episode_id IN (${episodePlaceholders}) AND kind='asset' AND status IN ('pending','error','running') ORDER BY episode_id, sort_order`).all(projectId, ...targetEpisodeIds) as TaskRow[];
      for (const task of tasks) {
        if (cancelled.has(projectId)) { sqlite.prepare("UPDATE comic_drama_projects SET status='paused', updated_at=datetime('now') WHERE id=?").run(projectId); return; }
        const payload = json<any>(task.payload, {}); const { blueprint, state } = getContext(task);
        const imageModel = state.imageModel; const analysisModel = state.analysisModel;
        const qualityEnabled = state.qualityEnabled !== false; const qualityRetries = Math.max(0, Math.min(2, Number(state.qualityRetries ?? 1)));
        const canonicalAsset = (projectState.sharedAssets || []).find((asset: any) => asset.kind === payload.assetKind && asset.name === payload.name);
        let prompt = canonicalAsset?.prompt || `${blueprint.visualStyle || ''}。${payload.assetPrompt || ''}`; let url = ''; let report: any;
        const reusable = (sqlite.prepare("SELECT * FROM comic_drama_tasks WHERE project_id=? AND id!=? AND kind='asset' AND status='done' AND result_url IS NOT NULL ORDER BY id").all(projectId, task.id) as TaskRow[])
          .find(candidate => {
            const candidatePayload = json<any>(candidate.payload, {});
            return candidatePayload.assetKind === payload.assetKind && candidatePayload.name === payload.name;
          }) as any;
        if (reusable?.result_url) {
          updateTask(task, { status: 'done', resultUrl: reusable.result_url, attempts: task.attempts, qualityScore: reusable.quality_score, qualityReport: json(reusable.quality_report, null) });
          syncSharedAsset(projectId, payload, reusable.result_url, reusable.quality_score, json(reusable.quality_report, null));
          continue;
        }
        updateTask(task, { status: 'running', attempts: task.attempts + 1 });
        try {
          for (let attempt = 0; attempt <= (qualityEnabled ? qualityRetries : 0); attempt++) {
            url = await consumeSse('/api/image-gen/generate', token, { prompt, model: imageModel, aspect_ratio: '9:16', n: 1 }, 'imageUrl');
            if (!qualityEnabled) break;
            report = await postJson('/api/analysis/comic-drama-quality-review', token, { imageUrl: url, kind: payload.assetKind || '资产', name: payload.name || '', expectedPrompt: prompt, visualStyle: blueprint.visualStyle || '', modelId: analysisModel });
            if (report.consistencyPassed && Number(report.score) >= 75) break;
            prompt = report.correctedPrompt || prompt;
          }
          const passed = !qualityEnabled || (report?.consistencyPassed && Number(report?.score) >= 75);
          updateTask(task, { status: passed ? 'done' : 'review_required', resultUrl: url, attempts: task.attempts + 1, qualityScore: report?.score, qualityReport: report });
          if (passed) syncSharedAsset(projectId, payload, url, report?.score, report);
        } catch (error: any) { updateTask(task, { status: 'error', attempts: task.attempts + 1, qualityReport: { summary: error.message } }); }
      }
      const blocked = sqlite.prepare(`SELECT count(*) AS count FROM comic_drama_tasks WHERE project_id=? AND episode_id IN (${episodePlaceholders}) AND kind='asset' AND status='review_required'`).get(projectId, ...targetEpisodeIds) as any;
      if (Number(blocked?.count || 0)) { sqlite.prepare("UPDATE comic_drama_projects SET status='needs_attention', updated_at=datetime('now') WHERE id=?").run(projectId); return; }
    }

    {
      const tasks = sqlite.prepare(`SELECT * FROM comic_drama_tasks WHERE project_id=? AND episode_id IN (${episodePlaceholders}) AND kind='storyboard' AND status IN ('pending','error','running') ORDER BY episode_id, sort_order`).all(projectId, ...targetEpisodeIds) as TaskRow[];
      for (const task of tasks) {
        if (cancelled.has(projectId)) { sqlite.prepare("UPDATE comic_drama_projects SET status='paused', updated_at=datetime('now') WHERE id=?").run(projectId); return; }
        const payload = json<any>(task.payload, {}); const { blueprint, state } = getContext(task);
        const imageModel = state.imageModel; const analysisModel = state.analysisModel;
        const qualityEnabled = state.qualityEnabled !== false; const qualityRetries = Math.max(0, Math.min(2, Number(state.qualityRetries ?? 1)));
        const referenceImages = (sqlite.prepare("SELECT result_url FROM comic_drama_tasks WHERE episode_id=? AND kind='asset' AND status='done' AND result_url IS NOT NULL ORDER BY sort_order LIMIT 4").all(task.episode_id) as any[]).map(row => row.result_url);
        let prompt = `${blueprint.visualStyle || ''}。${payload.shot?.imagePrompt || ''}`; let url = ''; let report: any;
        updateTask(task, { status: 'running', attempts: task.attempts + 1 });
        try {
          for (let attempt = 0; attempt <= (qualityEnabled ? qualityRetries : 0); attempt++) {
            url = await consumeSse('/api/image-gen/generate', token, { prompt, model: imageModel, aspect_ratio: '9:16', n: 1, reference_images: referenceImages }, 'imageUrl');
            if (!qualityEnabled) break;
            report = await postJson('/api/analysis/comic-drama-quality-review', token, { imageUrl: url, kind: '分镜', name: `${payload.sceneTitle || ''} 镜头${payload.shot?.shotNumber || ''}`, expectedPrompt: prompt, visualStyle: blueprint.visualStyle || '', modelId: analysisModel });
            if (report.consistencyPassed && Number(report.score) >= 75) break;
            prompt = report.correctedPrompt || prompt;
          }
          const passed = !qualityEnabled || (report?.consistencyPassed && Number(report?.score) >= 75);
          updateTask(task, { status: passed ? 'done' : 'review_required', resultUrl: url, attempts: task.attempts + 1, qualityScore: report?.score, qualityReport: report });
        } catch (error: any) { updateTask(task, { status: 'error', attempts: task.attempts + 1, qualityReport: { summary: error.message } }); }
      }
      const blocked = sqlite.prepare(`SELECT count(*) AS count FROM comic_drama_tasks WHERE project_id=? AND episode_id IN (${episodePlaceholders}) AND kind='storyboard' AND status='review_required'`).get(projectId, ...targetEpisodeIds) as any;
      if (Number(blocked?.count || 0)) { sqlite.prepare("UPDATE comic_drama_projects SET status='needs_attention', updated_at=datetime('now') WHERE id=?").run(projectId); return; }
    }

    {
      const tasks = sqlite.prepare(`SELECT * FROM comic_drama_tasks WHERE project_id=? AND episode_id IN (${episodePlaceholders}) AND kind='video' AND status IN ('pending','error','running') ORDER BY episode_id, sort_order`).all(projectId, ...targetEpisodeIds) as TaskRow[];
      for (const task of tasks) {
        if (cancelled.has(projectId)) { sqlite.prepare("UPDATE comic_drama_projects SET status='paused', updated_at=datetime('now') WHERE id=?").run(projectId); return; }
        const payload = json<any>(task.payload, {}); const { blueprint, state } = getContext(task); const videoModel = state.videoModel;
        const analysisModel = state.analysisModel; const qualityEnabled = state.qualityEnabled !== false;
        const qualityRetries = Math.max(0, Math.min(2, Number(state.qualityRetries ?? 1)));
        const storyboard = sqlite.prepare("SELECT result_url FROM comic_drama_tasks WHERE episode_id=? AND kind='storyboard' AND entity_key=?").get(task.episode_id, task.entity_key) as any;
        updateTask(task, { status: 'running', attempts: task.attempts + 1 });
        try {
          const requested = Number(payload.shot?.duration || 5); const duration = Math.abs(requested - 5) <= Math.abs(requested - 10) ? 5 : 10;
          let prompt = [payload.shot?.videoPrompt, `开始状态：${payload.shot?.continuityStart || '承接上一镜'}`, `结束状态：${payload.shot?.continuityEnd || '动作完整收束'}`].filter(Boolean).join('。');
          let url = ''; let report: any; let reviewUnavailable = false;
          for (let attempt = 0; attempt <= (qualityEnabled ? qualityRetries : 0); attempt++) {
            url = await consumeSse('/api/video/generate', token, { prompt, model: videoModel, aspect_ratio: '9:16', video_length: duration, reference_images: storyboard?.result_url ? [storyboard.result_url] : [] }, 'videoUrl');
            if (!qualityEnabled) break;
            try {
              report = await postJson('/api/analysis/comic-drama-video-quality-review', token, {
                videoUrl: url, name: `${payload.sceneTitle || ''} 镜头${payload.shot?.shotNumber || ''}`,
                expectedPrompt: prompt, continuityStart: payload.shot?.continuityStart, continuityEnd: payload.shot?.continuityEnd,
                visualStyle: blueprint.visualStyle || '', modelId: analysisModel,
              });
            } catch (reviewError: any) {
              reviewUnavailable = true; report = { summary: `视频已生成，质检暂不可用：${reviewError.message}`, issues: [], correctedPrompt: prompt };
              break;
            }
            if (report.consistencyPassed && Number(report.score) >= 75) break;
            prompt = report.correctedPrompt || prompt;
          }
          const passed = !qualityEnabled || reviewUnavailable || (report?.consistencyPassed && Number(report?.score) >= 75);
          updateTask(task, { status: passed ? 'done' : 'review_required', resultUrl: url, attempts: task.attempts + 1, qualityScore: report?.score, qualityReport: report });
        } catch (error: any) { updateTask(task, { status: 'error', attempts: task.attempts + 1, qualityReport: { summary: error.message } }); }
      }
      const blocked = sqlite.prepare(`SELECT count(*) AS count FROM comic_drama_tasks WHERE project_id=? AND episode_id IN (${episodePlaceholders}) AND kind='video' AND status='review_required'`).get(projectId, ...targetEpisodeIds) as any;
      if (Number(blocked?.count || 0)) { sqlite.prepare("UPDATE comic_drama_projects SET status='needs_attention', updated_at=datetime('now') WHERE id=?").run(projectId); return; }
    }
    if (cancelled.has(projectId)) { sqlite.prepare("UPDATE comic_drama_projects SET status='paused', updated_at=datetime('now') WHERE id=?").run(projectId); return; }
    const unfinished = sqlite.prepare(`SELECT count(*) AS count FROM comic_drama_tasks WHERE project_id=? AND episode_id IN (${episodePlaceholders}) AND status NOT IN ('done','skipped')`).get(projectId, ...targetEpisodeIds) as any;
    sqlite.prepare(`
      UPDATE comic_drama_episodes SET status = CASE WHEN EXISTS (
        SELECT 1 FROM comic_drama_tasks task WHERE task.episode_id = comic_drama_episodes.id AND task.status NOT IN ('done','skipped')
      ) THEN 'needs_attention' ELSE 'completed' END, updated_at=datetime('now')
      WHERE project_id=? AND status IN ('queued','producing')
    `).run(projectId);
    sqlite.prepare("UPDATE comic_drama_projects SET status=?, updated_at=datetime('now') WHERE id=?").run(Number(unfinished?.count || 0) ? 'needs_attention' : 'completed', projectId);
  } catch (error: any) {
    sqlite.prepare("UPDATE comic_drama_projects SET status='needs_attention', updated_at=datetime('now') WHERE id=?").run(projectId);
    console.error(`[comic-drama] 项目 ${projectId} 托管失败:`, error.message);
  } finally { active.delete(projectId); cancelled.delete(projectId); }
}

export const ComicDramaQueueService = {
  enqueue(projectId: number) { if (!active.has(projectId) && !pending.includes(projectId)) pending.push(projectId); queueMicrotask(drain); },
  cancel(projectId: number) { cancelled.add(projectId); const index = pending.indexOf(projectId); if (index >= 0) pending.splice(index, 1); sqlite.prepare("UPDATE comic_drama_projects SET status='paused', updated_at=datetime('now') WHERE id=?").run(projectId); },
  resumePending() {
    const rows = sqlite.prepare("SELECT id FROM comic_drama_projects WHERE status IN ('queued','producing') ORDER BY updated_at").all() as Array<{ id: number }>;
    rows.forEach(row => this.enqueue(row.id));
  },
};
