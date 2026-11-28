import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { styles, generationModels, cameraMovements, aspectRatios, audioModes } from './fixtures.mjs';
import { parsePlainScriptToPlan } from './script-parser.mjs';

export function createStore(root) {
  let analysisProvider;
  let modelProvider;
  const activeCatalog = () => (modelProvider ? modelProvider() : generationModels);
  fs.mkdirSync(root, { recursive: true });
  const sql = new Database(path.join(root, 'simulation.db'));
  sql.pragma('journal_mode = WAL');
  sql.exec(`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT, style TEXT NOT NULL DEFAULT 'original', created TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, slot TEXT NOT NULL,
    status TEXT NOT NULL, request_key TEXT NOT NULL, input TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0,
    error TEXT, created TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(project,request_key)
  );
  CREATE INDEX IF NOT EXISTS tasks_slot ON tasks(project,kind,slot);
  CREATE TABLE IF NOT EXISTS analysis_attempts (task_id TEXT PRIMARY KEY, phase TEXT NOT NULL, evidence TEXT);
  `);
  try { sql.exec("ALTER TABLE projects ADD COLUMN preset TEXT NOT NULL DEFAULT ''"); } catch {}
  try { sql.exec("ALTER TABLE projects ADD COLUMN aspect_ratio TEXT NOT NULL DEFAULT '9:16'"); } catch {}
  try { sql.exec("ALTER TABLE projects ADD COLUMN audio_mode TEXT NOT NULL DEFAULT 'original'"); } catch {}
  try { sql.exec("ALTER TABLE projects ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { sql.exec("ALTER TABLE projects ADD COLUMN org_id INTEGER DEFAULT NULL"); } catch {}
  const error = (message, status = 409) => Object.assign(new Error(message), { status });
  const latest = (id, kind, slot) => sql.prepare('SELECT * FROM tasks WHERE project=? AND kind=? AND slot=? ORDER BY rowid DESC LIMIT 1').get(id, kind, String(slot));
  function project(id) {
    const row = sql.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!row) throw error('项目不存在', 404);
    const plan = row.plan ? JSON.parse(row.plan) : null;
    const tasks = sql.prepare('SELECT * FROM tasks WHERE project=? ORDER BY rowid').all(id);
    const assets = { role: {}, frame: {}, video: {} };
    const versions = { role: {}, frame: {}, video: {} };
    let analysis = null;
    let film = null;
    for (const task of tasks) {
      const input = JSON.parse(task.input);
      const item = { id: task.id, status: task.status, confirmed: Boolean(task.confirmed), error: task.error,
        file: task.status === 'completed' ? '/demo/media/' + task.id : null, input, cost: input.mode === 'real' ? null : 0,
        created: task.created,
        evidence: task.kind === 'analysis' ? JSON.parse(sql.prepare('SELECT evidence FROM analysis_attempts WHERE task_id=?').get(task.id)?.evidence || 'null') : null };
      if (task.kind === 'analysis') analysis = item;
      else if (task.kind === 'film') film = item;
      else (versions[task.kind][task.slot] ||= []).push(item);
    }
    // The selected (confirmed) version is the slot's current asset; without a selection, show the newest attempt.
    for (const kind of Object.keys(versions)) {
      for (const [slot, list] of Object.entries(versions[kind])) {
        assets[kind][slot] = [...list].reverse().find(item => item.confirmed && item.status === 'completed') || list[list.length - 1];
      }
    }
    const hasSource = fs.existsSync(path.join(root, id, 'source.mp4'));
    return { id, title: plan?.title || row.name, plan, style: row.style, preset: row.preset || '',
      aspectRatio: row.aspect_ratio || '9:16', audioMode: row.audio_mode || 'original',
      userId: row.user_id || 0, orgId: row.org_id || null,
      hasSource,
      analysis, film, assets, versions, cost: analysis?.input.mode === 'real' ? null : 0,
      source: hasSource ? '/demo/projects/' + id + '/source' : '', created: row.created, taskCount: tasks.length };
  }
  function requireConfirmed(asset, message) {
    if (!asset || !asset.confirmed || asset.status !== 'completed') throw error(message);
    return asset;
  }
  const slotInFlight = (id, kind, slot) => sql.prepare("SELECT id FROM tasks WHERE project=? AND kind=? AND slot=? AND status IN ('queued','running') ORDER BY rowid").all(id, kind, String(slot)).map(row => row.id);
  const roleUsedByFrames = (id, roleSlot) => sql.prepare("SELECT input FROM tasks WHERE project=? AND kind='frame' AND status!='failed'").all(id)
    .some(row => JSON.parse(row.input).roles.some(ref => ref.slot === roleSlot));
  function pickModel(kind, body) {
    const list = activeCatalog()[kind === 'video' ? 'video' : 'image'];
    const chosen = body.model === undefined ? list[0] : list.find(item => item.id === body.model);
    if (!chosen) throw error('所选模型不可用，请刷新后重新选择', 422);
    let resolution = null;
    if (kind === 'video') {
      const resolutions = chosen.resolutions?.length ? chosen.resolutions : ['720p', '1080p'];
      resolution = body.resolution === undefined ? resolutions[0] : body.resolution;
      if (!resolutions.includes(resolution)) throw error('所选清晰度不受该模型支持', 422);
    }
    return { modelId: chosen.id, model: chosen.name, resolution, real: Boolean(chosen.real) };
  }
  function prepare(id, kind, slot, body) {
    if (['analysis','film'].includes(kind) && slot !== 'main') throw error('分析与成片只能使用项目主任务', 422);
    const state = project(id);
    if (kind === 'analysis') {
      if (state.plan) throw error('此项目已完成拉片');
      const previous = latest(id, 'analysis', slot);
      if (previous && ['needs_review', 'result_error'].includes(previous.status)) throw error('原分析已有发送记录或结果，请先核对原回执，禁止重复提交');
      const selected = analysisProvider?.snapshot() || { mode: 'mock', model: '本地 Gemini 模拟响应', fixture: 'rainy-letter-v1' };
      const expected = body.expectedAnalysis;
      if ((selected.mode === 'real' && !expected) || (expected && (expected.mode !== selected.mode ||
        selected.mode === 'real' && (expected.channelId !== selected.channelId || expected.model !== selected.model)))) {
        throw error('后台分析设置已变化，请刷新后确认当前渠道与模型再提交');
      }
      return { ...selected, source: state.source };
    }
    if (!state.plan) throw error('请先完成拉片分析');
    if (kind === 'film') {
      const clips = state.plan.shots.map(shot => requireConfirmed(state.assets.video[shot.id], '请先确认全部分镜视频'));
      const audioMode = body?.audioMode && audioModes.some(m => m.id === body.audioMode) ? body.audioMode : state.audioMode;
      return { clips: clips.map(clip => clip.id), duration: state.plan.duration, style: state.style,
        aspectRatio: state.aspectRatio, audioMode, model: '本地 FFmpeg 合成' };
    }
    const current = state.assets[kind]?.[slot];
    if (current && ['queued', 'running'].includes(current.status)) throw error('该素材的任务正在处理');
    if (slotInFlight(id, kind, slot).length) throw error('该素材还有候选正在生成，请等待完成后再抽卡');
    const style = styles.find(item => item.id === state.style);
    let prompt = body.prompt;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2400) throw error('请填写 2400 字以内的提示词', 422);
    prompt = prompt.trim();
    const picked = pickModel(kind, body);
    if (kind === 'role') {
      const role = state.plan.characters.find(role => role.id === slot);
      if (!role) throw error('角色不存在', 404);
      if (roleUsedByFrames(id, slot)) throw error('该角色图已用于首帧，请新建项目尝试其他版本');
      return { prompt, roleId: slot, style: style.id, styleName: style.name, ...picked };
    }
    const shot = state.plan.shots.find(shot => shot.id === slot);
    if (!shot) throw error('片段不存在', 404);
    if (kind === 'frame') {
      if (latest(id, 'video', slot)?.status !== 'failed' && latest(id, 'video', slot)) throw error('该首帧已用于视频');
      const roles = shot.characters.map(roleId => {
        const role = state.plan.characters.find(role => role.id === roleId);
        const asset = requireConfirmed(state.assets.role[roleId], '请先确认角色图「' + role.name + '」');
        return { slot: roleId, taskId: asset.id, name: role.name };
      });
      return { prompt, roles, style: style.id, styleName: style.name, ...picked, crop: shot.crop,
        roleCrop: shot.id === '01' ? { left: 100, top: 400, width: 400, height: 320 } : null, original: shot.id };
    }
    if (kind === 'video') {
      if (state.film && state.film.status !== 'failed') throw error('该分镜已用于合成');
      const frame = requireConfirmed(state.assets.frame[slot], '请先确认该段生成的首帧');
      const cam = body.camera === undefined ? cameraMovements[0] : cameraMovements.find(item => item.id === body.camera);
      if (!cam) throw error('所选运镜方式不受支持', 422);
      return { prompt, firstFrameTask: frame.id, style: style.id, styleName: style.name,
        duration: shot.end - shot.start, camera: cam.id, cameraName: cam.name, ...picked };
    }
    throw error('无效的步骤', 422);
  }
  // Returns every task id created (or already created) for this logical request. One request may produce
  // several candidates; each candidate stores its own request key so a retried request never duplicates work.
  function enqueueBatch(id, kind, slot, body) {
    if (['analysis','film'].includes(kind) && slot !== 'main') throw error('分析与成片只能使用项目主任务', 422);
    return sql.transaction(() => {
      project(id);
      const key = body.requestKey;
      if (typeof key !== 'string' || !/^[\w-]{16,90}$/.test(key)) throw error('缺少有效的操作编号', 422);
      const batch = sql.prepare("SELECT * FROM tasks WHERE project=? AND (request_key=? OR request_key GLOB ?) ORDER BY rowid").all(id, key, key + '#*');
      if (batch.length) {
        if (batch.some(row => row.kind !== kind || row.slot !== String(slot))) throw error('操作编号已用于其他素材');
        return batch.map(row => row.id);
      }
      const running = slotInFlight(id, kind, slot);
      if (running.length) return running;
      const previous = latest(id, kind, slot);
      if (kind === 'analysis' && previous?.status === 'completed') return [previous.id];
      if (kind === 'film' && previous?.status === 'completed' && !body?.force) {
        const prevInput = JSON.parse(previous.input || '{}');
        const nextAudioMode = body?.audioMode || project(id).audioMode;
        if (!body?.audioMode || prevInput.audioMode === nextAudioMode) return [previous.id];
      }
      const generation = ['role', 'frame', 'video'].includes(kind);
      const list = generation ? activeCatalog()[kind === 'video' ? 'video' : 'image'] : [];
      const allowed = generation ? list.find(item => item.id === (body.model ?? list[0]?.id))?.counts || [1] : [1];
      const count = body.count === undefined ? 1 : body.count;
      if (!Number.isInteger(count) || !allowed.includes(count)) throw error('生成数量不受所选模型支持', 422);
      const input = prepare(id, kind, slot, body);
      const existingVersions = generation ? sql.prepare('SELECT count(1) AS n FROM tasks WHERE project=? AND kind=? AND slot=?').get(id, kind, String(slot)).n : 0;
      const ids = [];
      for (let index = 0; index < count; index++) {
        const taskId = crypto.randomUUID();
        const taskInput = generation ? { ...input, variant: existingVersions + index, batchKey: key, batchSize: count } : input;
        sql.prepare('INSERT INTO tasks(id,project,kind,slot,status,request_key,input) VALUES (?,?,?,?,?,?,?)')
          .run(taskId, id, kind, String(slot), 'queued', index === 0 ? key : key + '#' + (index + 1), JSON.stringify(taskInput));
        ids.push(taskId);
      }
      return ids;
    }).immediate();
  }
  function enqueue(id, kind, slot, body) {
    return enqueueBatch(id, kind, slot, body)[0];
  }
  return {
    sql, root, project, latest, prepare, enqueue, enqueueBatch, error,
    configureAnalysis(provider) { analysisProvider = provider; },
    configureModels(provider) { modelProvider = provider; },
    create(name, preset = '', options = {}) {
      const id = crypto.randomUUID();
      const aspectRatio = aspectRatios.some(r => r.id === options.aspectRatio) ? options.aspectRatio : '9:16';
      const userId = Number(options.userId || 0);
      const orgId = options.orgId ? Number(options.orgId) : null;
      sql.prepare('INSERT INTO projects(id,name,preset,aspect_ratio,user_id,org_id) VALUES (?,?,?,?,?,?)')
        .run(id, name, preset || '', aspectRatio, userId, orgId);
      fs.mkdirSync(path.join(root, id), { recursive: true });
      return id;
    },
    createFromScript(body, options = {}) {
      const plan = parsePlainScriptToPlan(body?.scriptText, {
        title: body?.title,
        videoModel: options.videoModel || body?.videoModel,
        allowedSeconds: options.allowedSeconds || body?.allowedSeconds,
        minDuration: options.minDuration ?? body?.minDuration,
        maxDuration: options.maxDuration ?? body?.maxDuration,
        defaultDuration: options.defaultDuration ?? body?.defaultDuration,
      });
      const id = this.create(plan.title, '', { ...options, aspectRatio: body?.aspectRatio || options.aspectRatio });
      sql.prepare('UPDATE projects SET plan=? WHERE id=?').run(JSON.stringify(plan), id);
      const taskId = crypto.randomUUID();
      sql.prepare("INSERT INTO tasks(id,project,kind,slot,status,request_key,input,confirmed) VALUES (?,?,?,?,?,?,?,1)")
        .run(taskId, id, 'analysis', 'main', 'completed', 'script-import-' + id, JSON.stringify({
          mode: 'script',
          source: 'plain-script',
          videoModel: plan.videoModel || null,
          durationRule: plan.durationRule || null,
        }));
      return id;
    },
    setAspectRatio(id, ratio) {
      return sql.transaction(() => {
        const state = project(id);
        if (!aspectRatios.some(r => r.id === ratio)) throw error('请选择受支持的画幅比例（9:16 / 16:9 / 1:1）', 422);
        if (state.aspectRatio !== ratio && sql.prepare("SELECT 1 FROM tasks WHERE project=? AND kind IN ('frame','video','film') AND status!='failed'").get(id)) {
          throw error('当前画幅已有生成分镜或成片，请新建项目切换画幅比例');
        }
        sql.prepare('UPDATE projects SET aspect_ratio=? WHERE id=?').run(ratio, id);
        return project(id);
      }).immediate();
    },
    setAudioMode(id, mode) {
      return sql.transaction(() => {
        project(id);
        if (!audioModes.some(m => m.id === mode)) throw error('请选择受支持的音轨模式', 422);
        sql.prepare('UPDATE projects SET audio_mode=? WHERE id=?').run(mode, id);
        return project(id);
      }).immediate();
    },
    addCharacter(id, body) {
      return sql.transaction(() => {
        const state = project(id);
        if (!state.plan) throw error('请先完成视频拉片分析');
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        const appearance = typeof body?.appearance === 'string' ? body.appearance.trim() : '';
        const kind = body?.kind === 'product' ? 'product' : 'person';
        if (!name || name.length > 40) throw error('请输入 40 字以内的名称', 422);
        if (!appearance || appearance.length > 600) throw error('请输入 600 字以内的外观特征描述', 422);
        if (state.plan.characters.length >= 30) throw error('单个项目最多支持 30 个主体/人物', 422);
        const roleId = (kind === 'product' ? 'prod_' : 'role_') + crypto.randomUUID().slice(0, 8);
        const nextPlan = {
          ...state.plan,
          characters: [...state.plan.characters, { id: roleId, name, appearance, kind }],
          shots: state.plan.shots.map(shot => {
            const wantBind = Array.isArray(body?.shots) && body.shots.includes(shot.id);
            const locked = Boolean(state.assets.frame[shot.id] && state.assets.frame[shot.id].status !== 'failed');
            if (!wantBind || locked || shot.characters.includes(roleId)) return shot;
            return { ...shot, characters: [...shot.characters, roleId] };
          }),
        };
        sql.prepare('UPDATE projects SET plan=? WHERE id=?').run(JSON.stringify(nextPlan), id);
        return project(id);
      }).immediate();
    },
    attachUploadedSubject(id, { name, appearance, shots }) {
      return sql.transaction(() => {
        const state = project(id);
        if (!state.plan) throw error('请先完成视频拉片分析');
        const cleanName = typeof name === 'string' ? name.trim() : '';
        const cleanAppearance = typeof appearance === 'string' && appearance.trim()
          ? appearance.trim().slice(0, 600)
          : `${cleanName} 实拍商品主体，保持原包装、材质与细节一致。`;
        if (!cleanName || cleanName.length > 40) throw error('请输入 40 字以内的商品名称', 422);
        if (state.plan.characters.length >= 30) throw error('单个项目最多支持 30 个主体/人物', 422);
        const roleId = 'prod_' + crypto.randomUUID().slice(0, 8);
        const taskId = crypto.randomUUID();
        const nextPlan = {
          ...state.plan,
          characters: [...state.plan.characters, { id: roleId, name: cleanName, appearance: cleanAppearance, kind: 'product' }],
          shots: state.plan.shots.map(shot => {
            const wantBind = Array.isArray(shots) && shots.includes(shot.id);
            const locked = Boolean(state.assets.frame[shot.id] && state.assets.frame[shot.id].status !== 'failed');
            if (!wantBind || locked || shot.characters.includes(roleId)) return shot;
            return { ...shot, characters: [...shot.characters, roleId] };
          }),
        };
        sql.prepare('UPDATE projects SET plan=? WHERE id=?').run(JSON.stringify(nextPlan), id);
        const taskInput = {
          prompt: cleanAppearance,
          roleId,
          style: state.style,
          styleName: styles.find(s => s.id === state.style)?.name || state.style,
          modelId: 'uploaded-subject',
          model: '用户实拍商品图',
          uploaded: true,
        };
        sql.prepare('INSERT INTO tasks(id,project,kind,slot,status,request_key,input,confirmed) VALUES (?,?,?,?,?,?,?,1)')
          .run(taskId, id, 'role', roleId, 'completed', 'upload-' + taskId, JSON.stringify(taskInput));
        return { taskId, roleId, project: project(id) };
      }).immediate();
    },
    removeCharacter(id, roleId) {
      return sql.transaction(() => {
        const state = project(id);
        if (!state.plan) throw error('请先完成视频拉片分析');
        if (!state.plan.characters.some(c => c.id === roleId)) throw error('角色不存在', 404);
        const used = sql.prepare("SELECT input FROM tasks WHERE project=? AND kind='frame' AND status!='failed'").all(id)
          .some(row => JSON.parse(row.input).roles.some(ref => ref.slot === roleId));
        if (used) throw error('该角色已用于生成分镜首帧，无法移除');
        const nextPlan = {
          ...state.plan,
          characters: state.plan.characters.filter(c => c.id !== roleId),
          shots: state.plan.shots.map(shot => ({ ...shot, characters: shot.characters.filter(cid => cid !== roleId) })),
        };
        sql.prepare('UPDATE projects SET plan=? WHERE id=?').run(JSON.stringify(nextPlan), id);
        return project(id);
      }).immediate();
    },
    setShotCharacters(id, shotId, characterIds) {
      return sql.transaction(() => {
        const state = project(id);
        if (!state.plan) throw error('请先完成视频拉片分析');
        const shot = state.plan.shots.find(s => s.id === shotId);
        if (!shot) throw error('镜头不存在', 404);
        const frame = state.assets.frame[shotId];
        if (frame && frame.status !== 'failed') throw error('该镜头已生成首帧，无法修改出镜人物');
        if (!Array.isArray(characterIds)) throw error('出镜人物列表格式无效', 422);
        const validSet = new Set(state.plan.characters.map(c => c.id));
        const deduped = [...new Set(characterIds)].filter(cid => validSet.has(cid));
        const nextPlan = {
          ...state.plan,
          shots: state.plan.shots.map(s => (s.id === shotId ? { ...s, characters: deduped } : s)),
        };
        sql.prepare('UPDATE projects SET plan=? WHERE id=?').run(JSON.stringify(nextPlan), id);
        return project(id);
      }).immediate();
    },
    updateScript(id, body) {
      return sql.transaction(() => {
        const state = project(id);
        if (!state.plan) throw error('请先完成视频拉片分析');
        const title = typeof body?.title === 'string' ? body.title.trim() : state.plan.title;
        if (!title || title.length > 150) throw error('请输入 150 字以内的片名', 422);
        const hook = typeof body?.hook === 'string' ? body.hook.trim().slice(0, 2400) : (state.plan.hook || '');
        const continuity = typeof body?.continuity === 'string' ? body.continuity.trim().slice(0, 2400) : (state.plan.continuity || '');
        const patchById = new Map();
        if (Array.isArray(body?.shots)) {
          for (const item of body.shots) {
            if (item && typeof item.id === 'string') patchById.set(item.id, item);
          }
        }
        const nextShots = state.plan.shots.map(shot => {
          const patch = patchById.get(shot.id);
          if (!patch) return shot;
          const nextTitle = typeof patch.title === 'string' && patch.title.trim() ? patch.title.trim().slice(0, 150) : shot.title;
          const nextScene = typeof patch.scene === 'string' ? patch.scene.trim().slice(0, 200) : (shot.scene || '');
          const nextAction = typeof patch.action === 'string' ? patch.action.trim().slice(0, 2400) : (shot.action || '');
          const nextSpeaker = typeof patch.speaker === 'string' ? patch.speaker.trim().slice(0, 60) : (shot.speaker || '旁白');
          const nextAudio = typeof patch.audio === 'string' ? patch.audio.trim().slice(0, 400) : (shot.audio || '');
          const nextCaption = typeof patch.caption === 'string' ? patch.caption.trim().slice(0, 2400) : shot.caption;
          const nextFramePrompt = typeof patch.framePrompt === 'string' && patch.framePrompt.trim() ? patch.framePrompt.trim().slice(0, 2400) : shot.framePrompt;
          const nextVideoPrompt = typeof patch.videoPrompt === 'string' && patch.videoPrompt.trim() ? patch.videoPrompt.trim().slice(0, 2400) : shot.videoPrompt;
          return {
            ...shot,
            title: nextTitle,
            scene: nextScene,
            action: nextAction,
            speaker: nextSpeaker,
            audio: nextAudio,
            caption: nextCaption,
            framePrompt: nextFramePrompt,
            videoPrompt: nextVideoPrompt,
          };
        });
        const scriptText = typeof body?.scriptText === 'string' ? body.scriptText.slice(0, 20000) : (state.plan.scriptText || '');
        const nextPlan = { ...state.plan, title, hook, continuity, scriptText, shots: nextShots };
        sql.prepare('UPDATE projects SET plan=? WHERE id=?').run(JSON.stringify(nextPlan), id);
        return project(id);
      }).immediate();
    },
    rewriteScript(id, body) {
      return sql.transaction(() => {
        const state = project(id);
        if (!state.plan) throw error('请先完成视频拉片分析');
        const theme = typeof body?.theme === 'string' ? body.theme.trim() : '';
        if (!theme || theme.length > 300) throw error('请输入 300 字以内的二创改写主题', 422);
        const leadName = state.plan.characters[0]?.name || '主角';
        const secondName = state.plan.characters[1]?.name || '';
        const isCoffee = /咖啡|饮品|茶|品牌|广告/.test(theme);
        const isSuspense = /悬疑|反转|侦探|秘密/.test(theme);
        const nextTitle = isCoffee
          ? `${theme.slice(0, 14)} · 质感短片`
          : isSuspense
            ? `${theme.slice(0, 14)} · 悬疑微短剧`
            : `${theme.slice(0, 16)}（二创版）`;
        const nextHook = isCoffee
          ? `围绕「${theme}」，用 3 秒近景热气特写抓人眼球，中段聚焦${leadName}细品瞬间的满足感，结尾以暖光空镜留白强化品牌记忆。`
          : `围绕「${theme}」，保留原片 ${state.plan.shots.length} 镜切镜节奏，通过开场细节设悬、人物情绪反转与结尾留白重新编排全片故事。`;
        const nextContinuity = isCoffee
          ? `暖木色调精品空间，柔和侧逆光勾勒蒸汽与器皿质感，${leadName}服装与手持杯具跨镜保持统一。`
          : `沿用原片电影级冷暖对比光影，紧扣「${theme}」主题，保证${leadName}${secondName ? `与${secondName}` : ''}的装束、道具与情绪连贯推进。`;
        const nextShots = state.plan.shots.map((shot, idx) => {
          const isFirst = idx === 0;
          const isLast = idx === state.plan.shots.length - 1;
          if (isCoffee) {
            const presets = [
              {
                title: '热气与手冲特写',
                scene: '精品咖啡馆 · 吧台（内景/暖光）',
                action: `${leadName}双手稳稳接过刚萃取好的手冲咖啡，细腻油脂与热气在暖色灯光下缓缓升腾，镜头贴近杯口细节。`,
                speaker: '旁白',
                caption: '有些风味，值得慢下来等三分钟',
                audio: '水流注入咖啡粉的轻响、舒缓爵士钢琴',
              },
              {
                title: '品鉴瞬间近景',
                scene: '精品咖啡馆 · 窗边位（内景/暖光）',
                action: `${leadName}将咖啡杯轻抬至唇边轻嗅香气，窗外微雨映衬室内暖光，嘴角露出克制而放松的笑意。`,
                speaker: leadName,
                caption: '第一口，就能喝出雨夜里的温度',
                audio: '轻柔雨声、瓷杯轻碰声、温暖大提琴铺底',
              },
              {
                title: '暖灯留白收尾',
                scene: '精品咖啡馆 · 橱窗与吊灯（内景/夜）',
                action: `镜头从桌上咖啡杯缓缓拉远，暖黄吊灯照亮品牌质感空间，雨夜街景虚化在窗外，画面从容定格。`,
                speaker: '旁白',
                caption: `${theme}，把好时光留在这一杯`,
                audio: '舒缓钢琴尾音渐弱、环境留白',
              },
            ];
            const p = presets[Math.min(idx, presets.length - 1)];
            return {
              ...shot,
              ...p,
              framePrompt: `${p.scene}。${p.action}`,
              videoPrompt: `${isFirst ? '镜头缓慢推近。' : isLast ? '镜头平稳拉远定格。' : '镜头柔和微移跟随人物神态。'}${p.action}`,
            };
          }
          const action = isFirst
            ? `围绕「${theme}」开场：${leadName}${secondName ? `与${secondName}` : ''}在关键道具前短暂停驻，特写镜头迅速抛出核心悬念。`
            : isLast
              ? `围绕「${theme}」收尾：镜头缓缓拉远，光影明暗交替，留下耐人寻味的反转空间。`
              : `围绕「${theme}」推进：${leadName}抬头望向画外方向，眼神在克制与迟疑之间切换，情绪推向转折点。`;
          const caption = isFirst
            ? `关于「${theme}」，一切从这一刻开始`
            : isLast
              ? `真相，远比看上去更安静`
              : `她忽然意识到，这件事并不简单`;
          return {
            ...shot,
            title: isFirst ? '开场悬念特写' : isLast ? '结尾反转留白' : `情绪推进 · 镜 ${shot.id}`,
            scene: shot.scene || '电影感主场景（夜）',
            action,
            speaker: isFirst || isLast ? '旁白' : leadName,
            audio: isFirst ? '环境底噪、低频悬疑音效切入' : isLast ? '音效骤停、余韵留白' : '心跳般轻缓节奏、环境氛围声',
            caption,
            framePrompt: `${shot.scene || '电影感主场景'}。${action}`,
            videoPrompt: `${isFirst ? '镜头缓慢推近。' : isLast ? '镜头缓缓拉远。' : '镜头轻微跟移。'}${action}`,
          };
        });
        const nextPlan = { ...state.plan, title: nextTitle, hook: nextHook, continuity: nextContinuity, scriptText: '', shots: nextShots };
        sql.prepare('UPDATE projects SET plan=? WHERE id=?').run(JSON.stringify(nextPlan), id);
        return project(id);
      }).immediate();
    },
    setStyle(id, style) {
      return sql.transaction(() => {
        const state = project(id);
        if (!styles.some(option => option.id === style)) throw error('请选择可用风格', 422);
        if (state.style !== style && sql.prepare("SELECT 1 FROM tasks WHERE project=? AND kind!='analysis' AND status!='failed'").get(id)) {
          throw error('当前风格已有生成素材，请新建项目切换风格');
        }
        sql.prepare('UPDATE projects SET style=? WHERE id=?').run(style, id);
        return project(id);
      }).immediate();
    },
    // Select one completed candidate as the slot's current asset. Only one version per slot stays selected.
    confirm(id, kind, slot, taskId) {
      return sql.transaction(() => {
        const state = project(id);
        if (!['role', 'frame', 'video'].includes(kind)) throw error('该步骤不支持选择版本', 422);
        const row = sql.prepare('SELECT * FROM tasks WHERE id=? AND project=? AND kind=? AND slot=?').get(taskId, id, kind, String(slot));
        if (!row || row.status !== 'completed') throw error('请选择已生成完成的版本');
        if (row.confirmed) return state;
        const lockedReason = kind === 'role'
          ? roleUsedByFrames(id, String(slot)) && '该角色图已用于首帧，无法切换版本'
          : kind === 'frame'
            ? (latest(id, 'video', slot) && latest(id, 'video', slot).status !== 'failed') && '该首帧已用于生成视频，无法切换版本'
            : (state.film && state.film.status !== 'failed') && '该分镜视频已用于合成成片，无法切换版本';
        if (lockedReason) throw error(lockedReason);
        sql.prepare('UPDATE tasks SET confirmed=0 WHERE project=? AND kind=? AND slot=?').run(id, kind, String(slot));
        sql.prepare('UPDATE tasks SET confirmed=1 WHERE id=?').run(row.id);
        return project(id);
      }).immediate();
    },
  };
}
