import { sqlite } from '../db/index.js';

function parseJson<T>(value: unknown, fallback: T): T {
  try { return JSON.parse(String(value || '')) as T; } catch { return fallback; }
}

function mapTask(task: any) {
  return {
    id: task.id, episodeId: task.episode_id, kind: task.kind, entityKey: task.entity_key,
    status: task.status, payload: parseJson(task.payload, {}), resultUrl: task.result_url,
    attempts: task.attempts, qualityScore: task.quality_score,
    qualityReport: parseJson(task.quality_report, null),
  };
}

function mapEpisode(row: any) {
  return {
    id: row.id, projectId: row.project_id, episodeNumber: row.episode_number,
    title: row.title, script: row.script, status: row.status,
    blueprint: parseJson(row.blueprint, {}), state: parseJson(row.state, {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

const taskKinds = ['asset', 'storyboard', 'video'] as const;

function taskProgress(row: any, kind: typeof taskKinds[number]) {
  const total = Number(row[`${kind}_total`] || 0);
  const done = Number(row[`${kind}_done`] || 0);
  const running = Number(row[`${kind}_running`] || 0);
  const failed = Number(row[`${kind}_failed`] || 0);
  return { total, done, running, failed, pending: Math.max(0, total - done - running - failed) };
}

export class ComicDramaProjectService {
  static createSeries(input: {
    userId: number; orgId?: number | null; title: string; originalScript: string;
    plan: { logline?: string; genre?: string; visualStyle?: string; episodes: Array<{ title: string; summary?: string; hook?: string; estimatedDuration?: number; script: string }> };
  }) {
    const transaction = sqlite.transaction(() => {
      const projectBlueprint = { title: input.title, logline: input.plan.logline || '', genre: input.plan.genre || '', visualStyle: input.plan.visualStyle || '', seriesPlanned: true };
      const projectState = { seriesPlan: input.plan.episodes.map((episode, index) => ({ episodeNumber: index + 1, title: episode.title, summary: episode.summary || '', hook: episode.hook || '', estimatedDuration: episode.estimatedDuration || 0 })) };
      const result = sqlite.prepare(`
        INSERT INTO comic_drama_projects (user_id, org_id, title, script, status, blueprint, state, updated_at)
        VALUES (?, ?, ?, ?, 'draft', ?, ?, datetime('now'))
      `).run(input.userId, input.orgId || null, input.title || '未命名漫剧', input.originalScript, JSON.stringify(projectBlueprint), JSON.stringify(projectState));
      const projectId = Number(result.lastInsertRowid);
      const insertEpisode = sqlite.prepare(`
        INSERT INTO comic_drama_episodes (project_id, user_id, episode_number, title, script, status, blueprint, state, updated_at)
        VALUES (?, ?, ?, ?, ?, 'draft', '{}', '{}', datetime('now'))
      `);
      let firstEpisodeId = 0;
      input.plan.episodes.forEach((episode, index) => {
        const episodeResult = insertEpisode.run(projectId, input.userId, index + 1, episode.title || `第${index + 1}集`, episode.script);
        if (!firstEpisodeId) firstEpisodeId = Number(episodeResult.lastInsertRowid);
      });
      return { projectId, firstEpisodeId };
    });
    const created = transaction();
    return { ...this.get(created.projectId, input.userId), episodeId: created.firstEpisodeId };
  }

  static create(input: { userId: number; orgId?: number | null; script: string; blueprint: any }) {
    const transaction = sqlite.transaction(() => {
      const result = sqlite.prepare(`
        INSERT INTO comic_drama_projects (user_id, org_id, title, script, status, blueprint, state, updated_at)
        VALUES (?, ?, ?, ?, 'planned', ?, '{}', datetime('now'))
      `).run(input.userId, input.orgId || null, input.blueprint.title || '未命名漫剧', input.script, JSON.stringify(input.blueprint));
      const projectId = Number(result.lastInsertRowid);
      const episodeResult = sqlite.prepare(`
        INSERT INTO comic_drama_episodes (project_id, user_id, episode_number, title, script, status, blueprint, state, updated_at)
        VALUES (?, ?, 1, '第1集', ?, 'planned', ?, '{}', datetime('now'))
      `).run(projectId, input.userId, input.script, JSON.stringify(input.blueprint));
      const episodeId = Number(episodeResult.lastInsertRowid);
      this.seedTasks(projectId, episodeId, input.userId, input.blueprint);
      return { projectId, episodeId };
    });
    const created = transaction();
    return { ...this.get(created.projectId, input.userId), episodeId: created.episodeId };
  }

  static seedTasks(projectId: number, episodeId: number, userId: number, blueprint: any) {
    const insert = sqlite.prepare(`
      INSERT OR IGNORE INTO comic_drama_tasks (project_id, episode_id, user_id, kind, entity_key, sort_order, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let order = 0;
    for (const [index, character] of (blueprint.characters || []).entries()) {
      insert.run(projectId, episodeId, userId, 'asset', `character-${index}`, order++, JSON.stringify({ ...character, assetKind: '角色' }));
    }
    for (const [index, scene] of (blueprint.scenes || []).entries()) {
      insert.run(projectId, episodeId, userId, 'asset', `scene-${index}`, order++, JSON.stringify({ name: scene.title, assetPrompt: scene.assetPrompt, assetKind: '场景' }));
    }
    for (const [index, prop] of (blueprint.props || []).entries()) {
      insert.run(projectId, episodeId, userId, 'asset', `prop-${index}`, order++, JSON.stringify({ ...prop, assetKind: '道具' }));
    }
    for (const scene of blueprint.scenes || []) {
      for (const [index, shot] of (scene.shots || []).entries()) {
        const entityKey = `${scene.sceneNumber}-${shot.shotNumber || index + 1}`;
        const payload = JSON.stringify({ sceneNumber: scene.sceneNumber, sceneTitle: scene.title, shot });
        insert.run(projectId, episodeId, userId, 'storyboard', entityKey, order++, payload);
        insert.run(projectId, episodeId, userId, 'video', entityKey, order++, payload);
      }
    }
  }

  static list(userId: number) {
    return sqlite.prepare(`
      SELECT project.id, project.title, project.status, project.updated_at AS updatedAt,
        project.created_at AS createdAt, count(episode.id) AS episodeCount
      FROM comic_drama_projects project
      LEFT JOIN comic_drama_episodes episode ON episode.project_id = project.id
      WHERE project.user_id = ? GROUP BY project.id ORDER BY project.updated_at DESC LIMIT 30
    `).all(userId);
  }

  static get(projectId: number, userId: number) {
    const row = sqlite.prepare('SELECT * FROM comic_drama_projects WHERE id = ? AND user_id = ?').get(projectId, userId) as any;
    if (!row) return null;
    const episodes = (sqlite.prepare(`
      SELECT episode.id, episode.project_id, episode.episode_number, episode.title, episode.status, episode.state,
        episode.created_at, episode.updated_at, count(task.id) AS taskCount,
        sum(CASE WHEN task.status = 'done' THEN 1 ELSE 0 END) AS doneCount,
        sum(CASE WHEN task.kind = 'asset' THEN 1 ELSE 0 END) AS asset_total,
        sum(CASE WHEN task.kind = 'asset' AND task.status = 'done' THEN 1 ELSE 0 END) AS asset_done,
        sum(CASE WHEN task.kind = 'asset' AND task.status = 'running' THEN 1 ELSE 0 END) AS asset_running,
        sum(CASE WHEN task.kind = 'asset' AND task.status IN ('error','review_required') THEN 1 ELSE 0 END) AS asset_failed,
        sum(CASE WHEN task.kind = 'storyboard' THEN 1 ELSE 0 END) AS storyboard_total,
        sum(CASE WHEN task.kind = 'storyboard' AND task.status = 'done' THEN 1 ELSE 0 END) AS storyboard_done,
        sum(CASE WHEN task.kind = 'storyboard' AND task.status = 'running' THEN 1 ELSE 0 END) AS storyboard_running,
        sum(CASE WHEN task.kind = 'storyboard' AND task.status IN ('error','review_required') THEN 1 ELSE 0 END) AS storyboard_failed,
        sum(CASE WHEN task.kind = 'video' THEN 1 ELSE 0 END) AS video_total,
        sum(CASE WHEN task.kind = 'video' AND task.status = 'done' THEN 1 ELSE 0 END) AS video_done,
        sum(CASE WHEN task.kind = 'video' AND task.status = 'running' THEN 1 ELSE 0 END) AS video_running,
        sum(CASE WHEN task.kind = 'video' AND task.status IN ('error','review_required') THEN 1 ELSE 0 END) AS video_failed
      FROM comic_drama_episodes episode
      LEFT JOIN comic_drama_tasks task ON task.episode_id = episode.id
      WHERE episode.project_id = ? AND episode.user_id = ?
      GROUP BY episode.id ORDER BY episode.episode_number
    `).all(projectId, userId) as any[]).map(episode => {
      const state: any = parseJson(episode.state, {});
      return {
        id: episode.id, projectId: episode.project_id, episodeNumber: episode.episode_number,
        title: episode.title, status: episode.status, taskCount: Number(episode.taskCount || 0),
        doneCount: Number(episode.doneCount || 0), analysisError: state.analysisError || null,
        progress: Object.fromEntries(taskKinds.map(kind => [kind, taskProgress(episode, kind)])),
        createdAt: episode.created_at, updatedAt: episode.updated_at,
      };
    });
    const uniqueAssets = new Map<string, { statuses: Set<string> }>();
    const assetRows = sqlite.prepare("SELECT payload, status FROM comic_drama_tasks WHERE project_id = ? AND user_id = ? AND kind = 'asset'").all(projectId, userId) as any[];
    for (const assetRow of assetRows) {
      const payload: any = parseJson(assetRow.payload, {});
      const key = `${payload.assetKind || '资产'}:${payload.name || ''}`;
      const entry = uniqueAssets.get(key) || { statuses: new Set<string>() };
      entry.statuses.add(String(assetRow.status)); uniqueAssets.set(key, entry);
    }
    const assetOverview = [...uniqueAssets.values()].reduce((sum, asset) => {
      if (asset.statuses.has('done')) sum.done += 1;
      else if (asset.statuses.has('running')) sum.running += 1;
      else if (asset.statuses.has('error') || asset.statuses.has('review_required')) sum.failed += 1;
      else sum.pending += 1;
      return sum;
    }, { total: uniqueAssets.size, done: 0, running: 0, failed: 0, pending: 0 });
    const overview = {
      episodes: {
        total: episodes.length,
        analyzed: episodes.filter(episode => !['draft', 'analysis_queued', 'analyzing', 'analysis_failed'].includes(episode.status)).length,
        queued: episodes.filter(episode => episode.status === 'analysis_queued').length,
        analyzing: episodes.filter(episode => episode.status === 'analyzing').length,
        failed: episodes.filter(episode => episode.status === 'analysis_failed').length,
      },
      ...Object.fromEntries(taskKinds.map(kind => [kind, episodes.reduce((sum: any, episode: any) => ({
        total: sum.total + episode.progress[kind].total,
        done: sum.done + episode.progress[kind].done,
        running: sum.running + episode.progress[kind].running,
        failed: sum.failed + episode.progress[kind].failed,
        pending: sum.pending + episode.progress[kind].pending,
      }), { total: 0, done: 0, running: 0, failed: 0, pending: 0 })])),
      asset: assetOverview,
    };
    return {
      id: row.id, title: row.title, script: row.script, status: row.status,
      blueprint: parseJson(row.blueprint, {}), state: parseJson(row.state, {}), episodes, overview,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  static getEpisode(projectId: number, episodeId: number, userId: number) {
    const row = sqlite.prepare('SELECT * FROM comic_drama_episodes WHERE id = ? AND project_id = ? AND user_id = ?').get(episodeId, projectId, userId) as any;
    if (!row) return null;
    const tasks = (sqlite.prepare('SELECT * FROM comic_drama_tasks WHERE episode_id = ? AND user_id = ? ORDER BY sort_order, id').all(episodeId, userId) as any[]).map(mapTask);
    return { ...mapEpisode(row), tasks };
  }

  static createEpisode(projectId: number, userId: number, input: { title?: string; script?: string } = {}) {
    const project = sqlite.prepare('SELECT id FROM comic_drama_projects WHERE id = ? AND user_id = ?').get(projectId, userId);
    if (!project) return null;
    const next = sqlite.prepare('SELECT COALESCE(MAX(episode_number), 0) + 1 AS number FROM comic_drama_episodes WHERE project_id = ?').get(projectId) as any;
    const episodeNumber = Number(next?.number || 1);
    const result = sqlite.prepare(`
      INSERT INTO comic_drama_episodes (project_id, user_id, episode_number, title, script, status, blueprint, state, updated_at)
      VALUES (?, ?, ?, ?, ?, 'draft', '{}', '{}', datetime('now'))
    `).run(projectId, userId, episodeNumber, input.title?.trim() || `第${episodeNumber}集`, input.script || '');
    sqlite.prepare("UPDATE comic_drama_projects SET updated_at = datetime('now') WHERE id = ?").run(projectId);
    return this.getEpisode(projectId, Number(result.lastInsertRowid), userId);
  }

  static saveEpisodeDraft(projectId: number, episodeId: number, userId: number, input: { title?: string; script?: string }) {
    const exists = sqlite.prepare('SELECT id FROM comic_drama_episodes WHERE id = ? AND project_id = ? AND user_id = ?').get(episodeId, projectId, userId);
    if (!exists) return null;
    sqlite.prepare(`
      UPDATE comic_drama_episodes SET script = COALESCE(?, script), title = COALESCE(?, title), updated_at = datetime('now')
      WHERE id = ? AND project_id = ? AND user_id = ?
    `).run(typeof input.script === 'string' ? input.script : null, input.title?.trim() || null, episodeId, projectId, userId);
    sqlite.prepare("UPDATE comic_drama_projects SET updated_at = datetime('now') WHERE id = ?").run(projectId);
    return this.getEpisode(projectId, episodeId, userId);
  }

  static saveEpisodeAnalysis(projectId: number, episodeId: number, userId: number, script: string, blueprint: any) {
    const exists = sqlite.prepare('SELECT id FROM comic_drama_episodes WHERE id = ? AND project_id = ? AND user_id = ?').get(episodeId, projectId, userId);
    if (!exists) return null;
    const projectRow = sqlite.prepare('SELECT state FROM comic_drama_projects WHERE id = ? AND user_id = ?').get(projectId, userId) as any;
    const projectState: any = parseJson(projectRow?.state, {});
    const sharedAssets: any[] = Array.isArray(projectState.sharedAssets) ? projectState.sharedAssets : [];
    const proposedAssets = [
      ...(blueprint.characters || []).map((item: any, index: number) => ({ id: `character-${index}`, name: item.name, kind: '角色', prompt: `${blueprint.visualStyle}。${item.assetPrompt}`, status: 'pending' })),
      ...(blueprint.scenes || []).map((item: any, index: number) => ({ id: `scene-${index}`, name: item.title, kind: '场景', prompt: `${blueprint.visualStyle}。${item.assetPrompt}`, status: 'pending' })),
      ...(blueprint.props || []).map((item: any, index: number) => ({ id: `prop-${index}`, name: item.name, kind: '道具', prompt: `${blueprint.visualStyle}。${item.assetPrompt}`, status: 'pending' })),
    ];
    const assets = proposedAssets.map(asset => {
      const shared = sharedAssets.find(candidate => candidate.kind === asset.kind && (candidate.name === asset.name || candidate.aliases?.includes(asset.name)));
      return shared ? { ...asset, ...shared, id: asset.id, status: shared.url ? 'done' : 'pending' } : asset;
    });
    const nextSharedAssets = [...sharedAssets];
    for (const asset of assets) {
      const exists = nextSharedAssets.some(candidate => candidate.kind === asset.kind && (candidate.name === asset.name || candidate.aliases?.includes(asset.name) || asset.aliases?.includes(candidate.name)));
      if (!exists) nextSharedAssets.push(asset);
    }
    const shots = (blueprint.scenes || []).flatMap((scene: any) => (scene.shots || []).map((shot: any, index: number) => ({
      id: `${scene.sceneNumber}-${shot.shotNumber || index + 1}`, sceneNumber: scene.sceneNumber,
      sceneTitle: scene.title, shot, status: 'pending',
    })));
    const previous = this.getEpisode(projectId, episodeId, userId)?.state || {};
    const episodeState = { ...previous, assets, shots, analysisError: null };
    const transaction = sqlite.transaction(() => {
      sqlite.prepare('DELETE FROM comic_drama_tasks WHERE episode_id = ? AND user_id = ?').run(episodeId, userId);
      sqlite.prepare(`UPDATE comic_drama_episodes SET script = ?, blueprint = ?, status = 'planned', state = ?, updated_at = datetime('now') WHERE id = ?`).run(script, JSON.stringify(blueprint), JSON.stringify(episodeState), episodeId);
      this.seedTasks(projectId, episodeId, userId, blueprint);
      const syncAsset = sqlite.prepare("UPDATE comic_drama_tasks SET payload = ?, status = ?, result_url = ?, quality_score = ?, quality_report = ? WHERE episode_id = ? AND kind = 'asset' AND entity_key = ?");
      for (const asset of assets) syncAsset.run(
        JSON.stringify({ name: asset.name, assetPrompt: asset.prompt, assetKind: asset.kind, aliases: asset.aliases || [], variant: asset.variant || '基础造型', locked: !!asset.locked }),
        asset.url ? 'done' : 'pending', asset.url || null, asset.qualityScore ?? null, JSON.stringify(asset.qualityReport || null), episodeId, asset.id,
      );
      sqlite.prepare("UPDATE comic_drama_projects SET state = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify({ ...projectState, sharedAssets: nextSharedAssets }), projectId);
    });
    transaction();
    return this.getEpisode(projectId, episodeId, userId);
  }

  static queueEpisodeAnalysis(projectId: number, userId: number, episodeIds?: number[]) {
    const rows = sqlite.prepare(`SELECT id, script, status FROM comic_drama_episodes WHERE project_id = ? AND user_id = ? ORDER BY episode_number`).all(projectId, userId) as any[];
    const requested = episodeIds?.length ? new Set(episodeIds) : null;
    const targets = rows.filter(row => (!requested || requested.has(Number(row.id))) && ['draft', 'analysis_failed'].includes(row.status) && String(row.script || '').trim().length >= 20);
    const transaction = sqlite.transaction(() => {
      const update = sqlite.prepare("UPDATE comic_drama_episodes SET status = 'analysis_queued', state = ?, updated_at = datetime('now') WHERE id = ?");
      for (const row of targets) {
        const current: any = this.getEpisode(projectId, Number(row.id), userId);
        update.run(JSON.stringify({ ...(current?.state || {}), analysisError: null }), row.id);
      }
      if (targets.length) sqlite.prepare("UPDATE comic_drama_projects SET status = 'analyzing', updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(projectId, userId);
    });
    transaction();
    return targets.map(row => Number(row.id));
  }

  static setEpisodeAnalysisStatus(projectId: number, episodeId: number, userId: number, status: 'analyzing' | 'analysis_failed', error?: string) {
    const episode: any = this.getEpisode(projectId, episodeId, userId);
    if (!episode) return null;
    sqlite.prepare("UPDATE comic_drama_episodes SET status = ?, state = ?, updated_at = datetime('now') WHERE id = ? AND project_id = ? AND user_id = ?")
      .run(status, JSON.stringify({ ...episode.state, analysisError: error || null }), episodeId, projectId, userId);
    return this.getEpisode(projectId, episodeId, userId);
  }

  static finishBatchAnalysis(projectId: number, userId: number) {
    const counts = sqlite.prepare(`SELECT
      sum(CASE WHEN status IN ('analysis_queued','analyzing') THEN 1 ELSE 0 END) AS active,
      sum(CASE WHEN status = 'analysis_failed' THEN 1 ELSE 0 END) AS failed,
      sum(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft
      FROM comic_drama_episodes WHERE project_id = ? AND user_id = ?`).get(projectId, userId) as any;
    if (Number(counts?.active || 0) > 0) return;
    const status = Number(counts?.failed || 0) > 0 ? 'analysis_failed' : Number(counts?.draft || 0) > 0 ? 'draft' : 'planned';
    sqlite.prepare("UPDATE comic_drama_projects SET status = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(status, projectId, userId);
  }

  static saveProjectState(projectId: number, userId: number, state: any, status?: string) {
    const exists = sqlite.prepare('SELECT id FROM comic_drama_projects WHERE id = ? AND user_id = ?').get(projectId, userId);
    if (!exists) return null;
    sqlite.prepare(`UPDATE comic_drama_projects SET state = ?, status = COALESCE(?, status), updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
      .run(JSON.stringify(state || {}), status || null, projectId, userId);
    // 共享资产是项目级单一真源：替换一次后，把结果同步到每一集对应的资产任务。
    const assetTasks = sqlite.prepare("SELECT id, payload FROM comic_drama_tasks WHERE project_id = ? AND user_id = ? AND kind = 'asset'").all(projectId, userId) as any[];
    const updateTask = sqlite.prepare("UPDATE comic_drama_tasks SET status = 'done', result_url = ?, quality_score = ?, quality_report = ?, updated_at = datetime('now') WHERE id = ?");
    const sharedAssets = Array.isArray(state?.sharedAssets) ? state.sharedAssets : [];
    const sharedByKey = new Map(sharedAssets.filter((asset: any) => asset?.url).map((asset: any) => [`${asset.kind}:${asset.name}`, asset]));
    const transaction = sqlite.transaction(() => {
      for (const task of assetTasks) {
        const payload: any = parseJson(task.payload, {});
        const shared: any = sharedByKey.get(`${payload.assetKind}:${payload.name}`);
        if (shared) updateTask.run(shared.url, shared.qualityScore ?? null, JSON.stringify(shared.qualityReport || null), task.id);
      }
    });
    transaction();
    return this.get(projectId, userId);
  }

  static saveEpisodeState(projectId: number, episodeId: number, userId: number, state: any, status = 'producing') {
    const exists = sqlite.prepare('SELECT id FROM comic_drama_episodes WHERE id = ? AND project_id = ? AND user_id = ?').get(episodeId, projectId, userId);
    if (!exists) return null;
    sqlite.prepare(`UPDATE comic_drama_episodes SET state = ?, status = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(state || {}), status, episodeId);
    sqlite.prepare("UPDATE comic_drama_projects SET updated_at = datetime('now') WHERE id = ?").run(projectId);
    const upsertTask = sqlite.prepare(`
      INSERT INTO comic_drama_tasks
        (project_id, episode_id, user_id, kind, entity_key, sort_order, status, payload, result_url, attempts, quality_score, quality_report, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(project_id, episode_id, kind, entity_key) DO UPDATE SET
        sort_order=excluded.sort_order, status=excluded.status, payload=excluded.payload,
        result_url=excluded.result_url, attempts=excluded.attempts, quality_score=excluded.quality_score,
        quality_report=excluded.quality_report, updated_at=datetime('now')
    `);
    const transaction = sqlite.transaction(() => {
      let order = 0;
      for (const asset of state?.assets || []) {
        const payload = JSON.stringify({ name: asset.name, assetPrompt: asset.prompt, assetKind: asset.kind, aliases: asset.aliases || [], variant: asset.variant || '基础造型', locked: !!asset.locked });
        upsertTask.run(projectId, episodeId, userId, 'asset', asset.id, order++, asset.url ? 'done' : asset.status, payload, asset.url || null, asset.attempts || 0, asset.qualityScore ?? null, JSON.stringify(asset.qualityReport || null));
      }
      const shotIds = new Set<string>();
      for (const shot of state?.shots || []) {
        shotIds.add(String(shot.id));
        const payload = JSON.stringify({ sceneNumber: shot.sceneNumber, sceneTitle: shot.sceneTitle, shot: shot.shot });
        upsertTask.run(projectId, episodeId, userId, 'storyboard', shot.id, order++, shot.imageUrl ? 'done' : shot.status, payload, shot.imageUrl || null, shot.attempts || 0, shot.qualityScore ?? null, JSON.stringify(shot.qualityReport || null));
        upsertTask.run(projectId, episodeId, userId, 'video', shot.id, order++, shot.videoUrl ? 'done' : 'pending', payload, shot.videoUrl || null, shot.videoAttempts || 0, shot.videoQualityScore ?? null, JSON.stringify(shot.videoQualityReport || null));
      }
      const existingShots = sqlite.prepare("SELECT id, entity_key FROM comic_drama_tasks WHERE episode_id=? AND user_id=? AND kind IN ('storyboard','video')").all(episodeId, userId) as any[];
      const deleteTask = sqlite.prepare('DELETE FROM comic_drama_tasks WHERE id=?');
      for (const task of existingShots) if (!shotIds.has(String(task.entity_key))) deleteTask.run(task.id);
      const blueprintRow = sqlite.prepare('SELECT blueprint FROM comic_drama_episodes WHERE id=?').get(episodeId) as any;
      const blueprint: any = parseJson(blueprintRow?.blueprint, {});
      if (Array.isArray(blueprint.scenes)) {
        blueprint.scenes = blueprint.scenes.map((scene: any) => ({ ...scene, shots: (state?.shots || []).filter((shot: any) => shot.sceneNumber === scene.sceneNumber).map((shot: any) => shot.shot) }));
        sqlite.prepare("UPDATE comic_drama_episodes SET blueprint=? WHERE id=?").run(JSON.stringify(blueprint), episodeId);
      }
    });
    transaction();
    return this.getEpisode(projectId, episodeId, userId);
  }

  static saveState(projectId: number, userId: number, state: any, status = 'producing') {
    const episode = sqlite.prepare('SELECT id FROM comic_drama_episodes WHERE project_id = ? AND user_id = ? ORDER BY episode_number LIMIT 1').get(projectId, userId) as any;
    if (!episode) return null;
    this.saveEpisodeState(projectId, episode.id, userId, state, status);
    return this.get(projectId, userId);
  }

  static startManaged(projectId: number, userId: number, episodeId: number, state: any, scope: 'current' | 'all' = 'current') {
    const targetIds = scope === 'all'
      ? (sqlite.prepare("SELECT id FROM comic_drama_episodes WHERE project_id = ? AND user_id = ? AND blueprint != '{}' ORDER BY episode_number").all(projectId, userId) as any[]).map(row => Number(row.id))
      : [episodeId];
    if (!targetIds.length) return null;
    const enabled: Record<string, boolean> = { asset: state?.selected?.assets !== false, storyboard: state?.selected?.storyboards !== false, video: state?.selected?.videos !== false };
    const transaction = sqlite.transaction(() => {
      for (const targetId of targetIds) {
        const episode: any = this.getEpisode(projectId, targetId, userId);
        if (!episode) continue;
        const nextState = { ...episode.state, ...state, assets: targetId === episodeId ? state.assets : episode.state.assets, shots: targetId === episodeId ? state.shots : episode.state.shots };
        this.saveEpisodeState(projectId, targetId, userId, nextState, 'queued');
        const update = sqlite.prepare("UPDATE comic_drama_tasks SET status=?, updated_at=datetime('now') WHERE episode_id=? AND user_id=? AND kind=? AND status!='done'");
        for (const [kind, isEnabled] of Object.entries(enabled)) update.run(isEnabled ? 'pending' : 'skipped', targetId, userId, kind);
      }
      const project = this.get(projectId, userId);
      this.saveProjectState(projectId, userId, { ...(project?.state || {}), activeEpisodeId: episodeId, managedScope: scope }, 'queued');
    });
    transaction();
    return this.get(projectId, userId);
  }
}
