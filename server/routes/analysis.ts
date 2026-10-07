import { registerUpload } from '../services/uploadAccess.js';
import { prepareVideoForDelivery } from '../services/videoCompatibilityService.js';
import { DEFAULT_TTS_CHARACTER_RATE } from '../../shared/tts.js';
import { reserveUserCharge } from '../services/billingReservation.js';
import { getEnabledPublicModels } from '../services/modelCatalogService.js';
import { Router, Response } from 'express';
import { authMiddleware, optionalAuthMiddleware, AuthRequest } from '../middleware/auth.js';
import { tierMiddleware, TierRequest } from '../middleware/tier.js';
import { quotaMiddleware, logUsage } from '../middleware/quota.js';
import { AIService } from '../services/aiService.js';
import { ContentService } from '../services/contentService.js';
import { PricingService } from '../services/pricingService.js';
import { ComicDramaProjectService } from '../services/comicDramaProjectService.js';
import { ComicDramaQueueService } from '../services/comicDramaQueueService.js';
import { ComicDramaAnalysisQueueService } from '../services/comicDramaAnalysisQueueService.js';
import { db, sqlite } from '../db/index.js';
import { users, tiers, tierModelAccess, models, settings, modelPricing } from '../db/schema.js';
import { eq, like, and } from 'drizzle-orm';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { resolveBatchArchiveFile, streamVideoZip } from '../services/videoBatchArchive.js';

const router = Router();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 150 * 1024 * 1024 } });
const comicExportTickets = new Map<string, { expires: number; userId: number; projectId: number; projectTitle: string; files: { path: string; name: string }[] }>();

router.get('/comic-drama-export/:ticket', async (req, res) => {
  const ticket = comicExportTickets.get(req.params.ticket);
  comicExportTickets.delete(req.params.ticket);
  if (!ticket || ticket.expires < Date.now()) return res.status(410).send('下载链接已失效，请重新导出');
  const owner = sqlite.prepare('SELECT is_active FROM users WHERE id=?').get(ticket.userId) as any;
  if (!owner?.is_active) return res.status(403).end();
  const safeTitle = ticket.projectTitle.replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 60) || `comic-drama-${ticket.projectId}`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${safeTitle}-视频素材.zip`)}`);
  try { await pipeline(Readable.from(streamVideoZip(ticket.files)), res); }
  catch (error) { console.warn('[comic-drama] 导出中断:', error); if (!res.destroyed) res.destroy(); }
});

/**
 * 根据用户选择 + 等级可用列表，确定实际使用的模型
 * 优先使用前端指定的 modelId（需在可用列表内），否则自动选择
 */
function resolveModel(
  req: TierRequest,
  preferImageGen = false,
  preferTts = false
): { id: number; modelId: string; apiKey: string | null } | undefined {
  const available = req.availableModels || [];
  const requestedModelId = req.body?.modelId as string | undefined;

  // 用户指定了模型 → 校验是否在可用列表中
  if (requestedModelId) {
    const found = available.find(m => m.modelId === requestedModelId);
    if (found) return found;
    if (preferTts) throw { status: 403, message: '所选语音模型不可用或当前等级无权使用，请重新选择' };
    // 指定的不在列表中，忽略，走自动选择
  }

  // 自动选择：图像生成模型 vs 语音合成模型 vs 文本分析模型
  if (preferImageGen) {
    return available.find(m => m.modelId.includes('image'));
  }
  if (preferTts) {
    const model = available.find(m => m.modelId.includes('tts'));
    if (!model) throw { status: 403, message: '当前等级没有可用的语音模型' };
    return model;
  }
  return available.find(m => m.modelId.includes('flash') && !m.modelId.includes('image') && !m.modelId.includes('tts')) || available[0];
}

// 通用辅助：执行分析请求 + 保存内容
async function handleAnalysis(
  req: TierRequest,
  res: Response,
  analysisType: string,
  handler: () => Promise<any>
) {
  const startTime = Date.now();
  try {
    const result = await handler();
    const duration = Date.now() - startTime;

    // 记录使用日志
    const modelId = req.availableModels?.[0]?.id;
    logUsage(req.userId!, analysisType, modelId, duration);

    // 保存到内容库
    try {
      const contentType = analysisType === 'copywriting' ? 'copywriting'
        : analysisType === 'generate_image' || analysisType === 'modify_prompt' ? 'image'
          : analysisType === 'generate_tts' ? 'audio'
            : 'analysis';
      const title = contentType === 'audio'
        ? `语音合成 - ${req.body?.voice || '未知'}`
        : (req.body?.videoTitle || req.body?.accountHandle || req.body?.prompt || req.body?.text || analysisType);
      const resultTextStr = typeof result === 'string' ? result : JSON.stringify(result);
      ContentService.save({
        userId: req.userId!,
        orgId: req.orgId || null,
        type: contentType,
        title: typeof title === 'string' ? title.slice(0, 200) : analysisType,
        inputText: (req.body?.videoTitle || req.body?.prompt || req.body?.text || '').slice(0, 500),
        resultText: contentType === 'audio' ? resultTextStr : resultTextStr.slice(0, 5000),
        modelId: req.availableModels?.[0]?.modelId,
        cost: result?.billing?.cost || 0,
        metadata: result?.billing ? { billingReservationId: result.billing.reservationId, billingStatus: 'settled' } : undefined,
      });
    } catch (e) { console.error('[content] 保存失败:', e); }

    res.json(result);
  } catch (err: any) {
    console.error(`Analysis error (${analysisType}):`, err);
    let errorMessage = '分析过程中发生错误，请重试。';
    const raw = err.message || '';

    // 尝试从嵌套 JSON 中提取可读信息
    let parsed: any = null;
    try { parsed = JSON.parse(raw); } catch {
      // Service errors include an operation/status prefix before the upstream JSON.
      const jsonStart = raw.indexOf('{');
      if (jsonStart >= 0) {
        try { parsed = JSON.parse(raw.slice(jsonStart)); } catch {}
      }
    }
    const deepMsg = parsed?.error?.message || parsed?.message || '';
    const combined = `${raw} ${deepMsg}`.toLowerCase();

    if (combined.includes('api key not valid') || combined.includes('invalid_argument') && combined.includes('api key')) {
      errorMessage = 'API Key 无效。请在管理后台 → 模型管理 中配置有效的 Gemini API Key，或在 .env 文件中设置 GEMINI_API_KEY。';
    } else if (combined.includes('429') || combined.includes('resource_exhausted') || combined.includes('quota')) {
      errorMessage = 'AI 接口调用频率超限或额度已耗尽，请稍后再试。';
    } else if (combined.includes('permission_denied')) {
      errorMessage = 'API Key 权限不足，请检查 Key 是否已启用 Gemini API。';
    } else if (deepMsg) {
      errorMessage = deepMsg;
    } else if (raw && raw.length < 200) {
      errorMessage = raw;
    }

    res.status(err.status || 500).json({ error: errorMessage });
  }
}

// ============ 用户可用模型列表（公开，未登录返回 free 等级模型）============
router.get('/models',
  optionalAuthMiddleware,
  (req: TierRequest, res: Response) => {
    let tierId: number | undefined;

    if (req.userId) {
      // 已登录：按用户等级
      const user = db.select().from(users).where(eq(users.id, req.userId)).get();
      if (user) tierId = user.tierId;
    }

    if (!tierId) {
      // 未登录或用户不存在：使用 free 等级
      const freeTier = db.select().from(tiers).where(eq(tiers.name, 'free')).get();
      tierId = freeTier?.id;
    }

    if (!tierId) return res.json([]);

    const accessList = db.select().from(tierModelAccess).where(eq(tierModelAccess.tierId, tierId)).all();
    const modelIds = accessList.map(a => a.modelId);
    if (modelIds.length === 0) return res.json([]);

    const allModels = getEnabledPublicModels();
    const available = allModels
      .filter(m => modelIds.includes(m.id))
      .filter(m => {
        // 分析页面只显示纯文本分析模型，排除图片生成/视频/图片类模型
        try {
          const caps: string[] = JSON.parse(m.capabilities || '[]');
          return caps.includes('text') && !caps.includes('image_gen') && !caps.includes('video') && !caps.includes('image');
        } catch { return false; }
      })
      .map(m => ({ modelId: m.modelId, displayName: m.displayName || m.modelId }));

    res.json(available);
  }
);

// ============ 语音合成可用模型列表 ============
const cloneUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
router.get('/cloned-voices', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(AIService.clonedVoices(req.userId!).getAllVoices(await AIService.getTtsVoiceCatalog()));
  } catch (error) { next(error); }
});
router.post('/cloned-voices', authMiddleware, tierMiddleware('tts'), (req, res, next) => {
  cloneUpload.single('audio')(req, res, error => {
    if (error) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? '参考音频不能超过 10MB，请压缩或裁剪' : '音频上传失败，请只上传一个音频文件' });
    next();
  });
}, async (req: TierRequest, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传参考音频' });
    const voice = await AIService.clonedVoices(req.userId!).cloneVoice(req.file.path, String(req.body.displayName || ''), req.file.originalname);
    res.json({ voiceId: voice.voiceId, displayName: voice.displayName, createdAt: voice.createdAt, state: voice.state });
  } catch (error: any) { res.status(error.status || 500).json({ error: error.message || '声音克隆失败' }); }
  finally { if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} } }
});
router.delete('/cloned-voices', authMiddleware, async (req: AuthRequest, res) => {
  try {
    await AIService.clonedVoices(req.userId!).deleteClonedVoice(String(req.body.voiceId || ''));
    res.json({ success: true });
  } catch (error: any) { res.status(error.status || 500).json({ error: error.message || '删除音色失败' }); }
});
router.get('/tts-models',
  optionalAuthMiddleware,
  async (req: TierRequest, res: Response, next) => {
    try {
      const voiceCatalog = await AIService.getTtsVoiceCatalog();
      const sourceModels = getEnabledPublicModels('tts')
        .map(m => ({ modelId: m.modelId, displayName: m.displayName || m.modelId, description: m.description || '' }));

      // 获取语音合成的费率设置
      let ttsRate = DEFAULT_TTS_CHARACTER_RATE;
      const rateSetting = db.select().from(settings).where(eq(settings.key, 'tts_rate')).get();
      if (rateSetting) {
        ttsRate = parseFloat(rateSetting.value) || DEFAULT_TTS_CHARACTER_RATE;
      } else {
        // 顺便在数据库中初始化这个设置
        try {
          db.insert(settings).values({ key: 'tts_rate', value: String(DEFAULT_TTS_CHARACTER_RATE), label: '语音合成费率(¥/字)' }).run();
        } catch { }
      }

      const result = sourceModels.map(m => {
        // 优先从 model_pricing 匹配该模型的定价规则
        const pricingRules = db.select().from(modelPricing).all();
        const matchedRule = pricingRules.find(r => r.modelPattern === m.modelId);

        let rate = ttsRate;
        if (matchedRule) {
          // 如果管理员在「计费设置」里单独配置了该模型的价格，则直接使用，不乘以任何倍率
          rate = matchedRule.inputPrice;
        } else {
          // 否则走系统默认的 tts_rate 加上倍率的兜底逻辑
          const multiplier = m.modelId.includes('pro') ? 2 : 1;
          rate = ttsRate * multiplier;
        }

        // 管理后台「计费设置」是唯一有效价格来源。
        const unifiedQuote = PricingService.quote(m.modelId, { characters: 1 }, false);
        rate = unifiedQuote.rate;

        return {
          modelId: m.modelId,
          displayName: m.displayName,
          description: m.description,
          voices: voiceCatalog.map(voice => voice.id),
          voiceDetails: voiceCatalog,
          voiceSource: voiceCatalog.length ? 'upstream' : 'unavailable',
          rate,
          billingType: unifiedQuote.billingType,
        };
      });

      res.json(result);
    } catch (error) { next(error); }
  }
);

// 通用短视频分析
router.post('/general',
  authMiddleware,
  tierMiddleware('general'),
  quotaMiddleware,
  upload.single('file'),
  async (req: TierRequest, res: Response) => {
    await handleAnalysis(req, res, 'general', async () => {
      const { videoTitle } = req.body;
      const file = req.file;
      if (!file) throw { status: 400, message: '请上传视频文件' };

      const modelConfig = resolveModel(req);
      return AIService.analyzeGeneral(file, videoTitle, modelConfig);
    });
  }
);

// 整部剧本分集规划：AI 只返回原文段落边界，确认后再批量创建剧集。
router.post('/comic-drama-series-plan',
  authMiddleware,
  tierMiddleware('video'),
  quotaMiddleware,
  async (req: TierRequest, res: Response) => {
    await handleAnalysis(req, res, 'comic_drama_series_plan', async () => {
      const script = typeof req.body?.script === 'string' ? req.body.script.trim() : '';
      if (script.length < 200) throw { status: 400, message: '整部剧本至少需要 200 个字' };
      if (script.length > 500000) throw { status: 400, message: '整部剧本最多支持 50 万字，请拆分项目导入' };
      const targetDuration = Math.max(30, Math.min(300, Number(req.body?.targetDuration || 90)));
      const requestedEpisodes = req.body?.requestedEpisodes ? Math.max(1, Math.min(100, Number(req.body.requestedEpisodes))) : undefined;
      return AIService.planComicDramaSeries(script, { targetDuration, requestedEpisodes }, resolveModel(req));
    });
  },
);

router.post('/comic-drama-series', authMiddleware, (req: AuthRequest, res: Response) => {
  const originalScript = typeof req.body?.originalScript === 'string' ? req.body.originalScript : '';
  const plan = req.body?.plan || {}; const episodes = Array.isArray(plan.episodes) ? plan.episodes : [];
  if (!originalScript || originalScript.length > 500000) return res.status(400).json({ error: '整部剧本内容无效或超过 50 万字' });
  if (!episodes.length || episodes.length > 100) return res.status(400).json({ error: '剧集数量需要在 1 到 100 集之间' });
  if (episodes.some((episode: any) => typeof episode.script !== 'string' || episode.script.trim().length < 20 || episode.script.length > 50000)) return res.status(400).json({ error: '每集剧本需要在 20 到 50000 字之间' });
  const project = ComicDramaProjectService.createSeries({
    userId: req.userId!, orgId: req.orgId, title: String(req.body?.title || plan.title || '未命名漫剧').slice(0, 120), originalScript,
    plan: { logline: plan.logline, genre: plan.genre, visualStyle: plan.visualStyle, episodes: episodes.map((episode: any, index: number) => ({
      title: String(episode.title || `第${index + 1}集`).slice(0, 120), summary: String(episode.summary || '').slice(0, 1000),
      hook: String(episode.hook || '').slice(0, 500), estimatedDuration: Number(episode.estimatedDuration || 0), script: episode.script,
    })) },
  });
  res.status(201).json(project);
});

// 漫剧剧本自动拆解
router.post('/comic-drama-script',
  authMiddleware,
  tierMiddleware('video'),
  quotaMiddleware,
  async (req: TierRequest, res: Response) => {
    await handleAnalysis(req, res, 'comic_drama_script', async () => {
      const script = typeof req.body?.script === 'string' ? req.body.script.trim() : '';
      if (script.length < 20) throw { status: 400, message: '剧本内容太短，请至少输入 20 个字' };
      if (script.length > 50000) throw { status: 400, message: '单次最多分析 5 万字，请分集提交' };

      const modelConfig = resolveModel(req);
      const blueprint = await AIService.analyzeComicDramaScript(script, modelConfig);
      const project = ComicDramaProjectService.create({ userId: req.userId!, orgId: req.orgId, script, blueprint });
      return { ...blueprint, projectId: project?.id, episodeId: project?.episodeId };
    });
  }
);

router.get('/comic-drama-projects', authMiddleware, (req: AuthRequest, res: Response) => {
  res.json(ComicDramaProjectService.list(req.userId!));
});

router.get('/comic-drama-projects/:id', authMiddleware, (req: AuthRequest, res: Response) => {
  const project = ComicDramaProjectService.get(Number(req.params.id), req.userId!);
  if (!project) return res.status(404).json({ error: '漫剧项目不存在' });
  res.json(project);
});

router.get('/comic-drama-projects/:id/export-summary', authMiddleware, (req: AuthRequest, res: Response) => {
  const projectId = Number(req.params.id); const episodeId = Number(req.query.episodeId || 0);
  const project = sqlite.prepare('SELECT id FROM comic_drama_projects WHERE id=? AND user_id=?').get(projectId, req.userId!);
  if (!project) return res.status(404).json({ error: '漫剧项目不存在' });
  const rows = episodeId
    ? sqlite.prepare("SELECT task.status, task.result_url FROM comic_drama_tasks task JOIN comic_drama_episodes episode ON episode.id=task.episode_id WHERE task.project_id=? AND task.user_id=? AND task.kind='video' AND episode.id=?").all(projectId, req.userId!, episodeId) as any[]
    : sqlite.prepare("SELECT task.status, task.result_url FROM comic_drama_tasks task WHERE task.project_id=? AND task.user_id=? AND task.kind='video'").all(projectId, req.userId!) as any[];
  const completed = rows.filter(row => row.status === 'done' && row.result_url).length;
  const unapproved = rows.filter(row => row.status === 'review_required' && row.result_url).length;
  const running = rows.filter(row => row.status === 'running').length;
  res.json({ total: rows.length, completed, unapproved, running, missing: Math.max(0, rows.length - completed - unapproved - running) });
});

router.post('/comic-drama-projects/:id/export-videos', authMiddleware, async (req: AuthRequest, res: Response) => {
  const projectId = Number(req.params.id); const episodeId = Number(req.body?.episodeId || 0);
  const scope = req.body?.scope === 'all' ? 'all' : 'current'; const includeUnapproved = req.body?.includeUnapproved === true;
  const project = sqlite.prepare('SELECT id, title FROM comic_drama_projects WHERE id=? AND user_id=?').get(projectId, req.userId!) as any;
  if (!project) return res.status(404).json({ error: '漫剧项目不存在' });
  if (scope === 'current' && !episodeId) return res.status(400).json({ error: '请选择要导出的剧集' });
  const rows = scope === 'current'
    ? sqlite.prepare("SELECT task.*, episode.episode_number FROM comic_drama_tasks task JOIN comic_drama_episodes episode ON episode.id=task.episode_id WHERE task.project_id=? AND task.user_id=? AND task.kind='video' AND episode.id=? ORDER BY episode.episode_number, task.sort_order, task.id").all(projectId, req.userId!, episodeId) as any[]
    : sqlite.prepare("SELECT task.*, episode.episode_number FROM comic_drama_tasks task JOIN comic_drama_episodes episode ON episode.id=task.episode_id WHERE task.project_id=? AND task.user_id=? AND task.kind='video' ORDER BY episode.episode_number, task.sort_order, task.id").all(projectId, req.userId!) as any[];
  const exportable = rows.filter(row => row.result_url && (row.status === 'done' || (includeUnapproved && row.status === 'review_required')));
  if (!exportable.length) return res.status(400).json({ error: includeUnapproved ? '暂无可导出的视频' : '暂无质检通过的视频' });
  const files: { path: string; name: string }[] = []; let totalBytes = 0; const usedNames = new Set<string>();
  try {
    for (const row of exportable) {
      const archiveUrl = String(row.result_url).startsWith('/api/uploads/') ? String(row.result_url).slice(4) : row.result_url;
      const file = await prepareVideoForDelivery(resolveBatchArchiveFile(archiveUrl, path.resolve('data/uploads')));
      const payload = (() => { try { return JSON.parse(row.payload || '{}'); } catch { return {}; } })();
      const episode = String(Number(row.episode_number || 1)).padStart(2, '0');
      const scene = String(Number(payload.sceneNumber || 1)).padStart(2, '0');
      const shot = String(Number(payload.shot?.shotNumber || 1)).padStart(2, '0');
      let baseName = `E${episode}_S${scene}_C${shot}${path.extname(file).toLowerCase() || '.mp4'}`;
      if (usedNames.has(`${episode}/${baseName}`)) baseName = `E${episode}_S${scene}_C${shot}_${row.id}${path.extname(file).toLowerCase() || '.mp4'}`;
      usedNames.add(`${episode}/${baseName}`);
      totalBytes += fs.statSync(file).size;
      files.push({ path: file, name: `第${episode}集/${baseName}` });
    }
  } catch {
    return res.status(409).json({ error: '部分视频尚未保存到本站，暂时无法打包，请稍后重试或单独下载' });
  }
  if (totalBytes > 3 * 1024 ** 3) return res.status(413).json({ error: '视频合计超过 3GB，请按单集分别导出' });
  for (const [key, value] of comicExportTickets) if (value.expires < Date.now() || value.userId === req.userId) comicExportTickets.delete(key);
  const ticket = randomBytes(32).toString('hex');
  comicExportTickets.set(ticket, { expires: Date.now() + 60_000, userId: req.userId!, projectId, projectTitle: project.title, files });
  res.json({ url: `/api/analysis/comic-drama-export/${ticket}`, count: files.length });
});

router.post('/comic-drama-projects/:id/episodes', authMiddleware, (req: AuthRequest, res: Response) => {
  const episode = ComicDramaProjectService.createEpisode(Number(req.params.id), req.userId!, {
    title: req.body?.title, script: req.body?.script,
  });
  if (!episode) return res.status(404).json({ error: '漫剧项目不存在' });
  res.status(201).json(episode);
});

router.get('/comic-drama-projects/:id/episodes/:episodeId', authMiddleware, (req: AuthRequest, res: Response) => {
  const episode = ComicDramaProjectService.getEpisode(Number(req.params.id), Number(req.params.episodeId), req.userId!);
  if (!episode) return res.status(404).json({ error: '剧集不存在' });
  res.json(episode);
});

router.put('/comic-drama-projects/:id/episodes/:episodeId', authMiddleware, (req: AuthRequest, res: Response) => {
  const script = typeof req.body?.script === 'string' ? req.body.script : undefined;
  if (script && script.length > 50000) return res.status(400).json({ error: '单集剧本不能超过 5 万字' });
  const episode = ComicDramaProjectService.saveEpisodeDraft(Number(req.params.id), Number(req.params.episodeId), req.userId!, { script, title: req.body?.title });
  if (!episode) return res.status(404).json({ error: '剧集不存在' });
  res.json({ id: episode.id, title: episode.title, status: episode.status, updatedAt: episode.updatedAt });
});

router.post('/comic-drama-projects/:id/episodes/:episodeId/analyze',
  authMiddleware,
  tierMiddleware('video'),
  quotaMiddleware,
  async (req: TierRequest, res: Response) => {
    await handleAnalysis(req, res, 'comic_drama_script', async () => {
      const script = typeof req.body?.script === 'string' ? req.body.script.trim() : '';
      if (script.length < 20) throw { status: 400, message: '剧本内容太短，请至少输入 20 个字' };
      if (script.length > 50000) throw { status: 400, message: '单集最多分析 5 万字，请拆分后提交' };
      const project: any = ComicDramaProjectService.get(Number(req.params.id), req.userId!);
      if (!project) throw { status: 404, message: '漫剧项目不存在' };
      const blueprint = await AIService.analyzeComicDramaScript(script, resolveModel(req), {
        visualStyle: project.blueprint?.visualStyle,
        sharedAssets: project.state?.sharedAssets || [],
      });
      const episode = ComicDramaProjectService.saveEpisodeAnalysis(Number(req.params.id), Number(req.params.episodeId), req.userId!, script, blueprint);
      if (!episode) throw { status: 404, message: '剧集不存在' };
      return { ...blueprint, projectId: Number(req.params.id), episodeId: episode.id };
    });
  },
);

// 批量分析尚未分析或上次失败的剧集。请求立即返回，具体进度通过项目总览轮询。
router.post('/comic-drama-projects/:id/analyze-episodes',
  authMiddleware,
  tierMiddleware('video'),
  quotaMiddleware,
  (req: TierRequest, res: Response) => {
    const projectId = Number(req.params.id);
    const project: any = ComicDramaProjectService.get(projectId, req.userId!);
    if (!project) return res.status(404).json({ error: '漫剧项目不存在' });
    if (['queued', 'producing'].includes(project.status)) return res.status(409).json({ error: '项目正在生成素材，请停止托管后再分析剧集' });
    const requestedIds = Array.isArray(req.body?.episodeIds)
      ? [...new Set(req.body.episodeIds.map(Number).filter((id: number) => Number.isInteger(id) && id > 0))].slice(0, 100)
      : undefined;
    const requestedSet = requestedIds?.length ? new Set(requestedIds) : null;
    const candidates = (sqlite.prepare("SELECT id, script, status FROM comic_drama_episodes WHERE project_id = ? AND user_id = ? ORDER BY episode_number").all(projectId, req.userId!) as any[])
      .filter(row => (!requestedSet || requestedSet.has(Number(row.id))) && ['draft', 'analysis_failed'].includes(row.status) && String(row.script || '').trim().length >= 20);
    if (!candidates.length) return res.status(400).json({ error: '没有可分析的剧集；请选择待分析或分析失败的剧集' });

    const dailyQuota = Number(req.userTier?.dailyQuota ?? -1);
    if (dailyQuota >= 0) {
      const usage = sqlite.prepare("SELECT count(*) AS count FROM usage_logs WHERE user_id = ? AND date(created_at) = date('now')").get(req.userId!) as any;
      const remaining = Math.max(0, dailyQuota - Number(usage?.count || 0));
      if (remaining < candidates.length) return res.status(429).json({
        error: `今日剩余分析次数为 ${remaining}，不足以批量分析 ${candidates.length} 集`,
        remaining, required: candidates.length,
      });
    }

    const episodeIds = ComicDramaProjectService.queueEpisodeAnalysis(projectId, req.userId!, candidates.map(row => Number(row.id)));
    ComicDramaAnalysisQueueService.enqueue({ projectId, userId: req.userId!, episodeIds, modelConfig: resolveModel(req) });
    res.status(202).json({ projectId, queued: episodeIds.length, episodeIds });
  },
);

router.put('/comic-drama-projects/:id/episodes/:episodeId/state', authMiddleware, (req: AuthRequest, res: Response) => {
  const serialized = JSON.stringify(req.body?.state || {});
  if (serialized.length > 2_000_000) return res.status(413).json({ error: '剧集状态过大' });
  const episode = ComicDramaProjectService.saveEpisodeState(Number(req.params.id), Number(req.params.episodeId), req.userId!, req.body?.state, req.body?.status);
  if (!episode) return res.status(404).json({ error: '剧集不存在' });
  res.json({ id: episode.id, projectId: episode.projectId, status: episode.status, updatedAt: episode.updatedAt });
});

router.put('/comic-drama-projects/:id/state', authMiddleware, (req: AuthRequest, res: Response) => {
  const serialized = JSON.stringify(req.body?.state || {});
  if (serialized.length > 2_000_000) return res.status(413).json({ error: '项目状态过大' });
  const project = ComicDramaProjectService.saveProjectState(Number(req.params.id), req.userId!, req.body?.state, req.body?.status);
  if (!project) return res.status(404).json({ error: '漫剧项目不存在' });
  res.json({ id: project.id, status: project.status, updatedAt: project.updatedAt });
});

router.post('/comic-drama-assets/upload', authMiddleware, upload.single('file'), (req: AuthRequest, res: Response) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: '请选择资产图片' });
  const extensions: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  const extension = extensions[file.mimetype];
  if (!extension || file.size > 12 * 1024 * 1024) {
    try { fs.unlinkSync(file.path); } catch {}
    return res.status(400).json({ error: '仅支持 12MB 以内的 JPG、PNG 或 WebP 图片' });
  }
  const directory = path.resolve(process.cwd(), 'data', 'uploads', 'comic-drama');
  fs.mkdirSync(directory, { recursive: true });
  const filename = `${req.userId}-${randomUUID()}.${extension}`;
  fs.renameSync(file.path, path.join(directory, filename));
  res.status(201).json({ url: registerUpload(`/uploads/comic-drama/${filename}`,req.userId) });
});

router.post('/comic-drama-projects/:id/managed', authMiddleware, tierMiddleware('video'), (req: TierRequest, res: Response) => {
  const state = req.body?.state || {};
  const episodeId = Number(req.body?.episodeId || 0);
  const scope = req.body?.scope === 'all' ? 'all' : 'current';
  if (!episodeId) return res.status(400).json({ error: '请选择要托管的剧集' });
  if (!state.imageModel && (state.selected?.assets !== false || state.selected?.storyboards !== false)) return res.status(400).json({ error: '请选择图片模型' });
  if (!state.videoModel && state.selected?.videos !== false) return res.status(400).json({ error: '请选择视频模型' });
  const project = ComicDramaProjectService.startManaged(Number(req.params.id), req.userId!, episodeId, state, scope);
  if (!project) return res.status(404).json({ error: '漫剧项目不存在' });
  ComicDramaQueueService.enqueue(project.id);
  res.status(202).json({ id: project.id, status: 'queued' });
});

router.post('/comic-drama-projects/:id/managed/stop', authMiddleware, (req: AuthRequest, res: Response) => {
  const project = ComicDramaProjectService.get(Number(req.params.id), req.userId!);
  if (!project) return res.status(404).json({ error: '漫剧项目不存在' });
  ComicDramaQueueService.cancel(project.id);
  res.json({ id: project.id, status: 'pausing' });
});

router.post('/comic-drama-quality-review',
  authMiddleware,
  tierMiddleware('video'),
  quotaMiddleware,
  async (req: TierRequest, res: Response) => {
    await handleAnalysis(req, res, 'comic_drama_visual_qa', async () => {
      const { imageUrl, kind, name, expectedPrompt, visualStyle } = req.body || {};
      if (!imageUrl || !expectedPrompt) throw { status: 400, message: '缺少质检图片或预期画面说明' };
      const modelConfig = resolveModel(req);
      return AIService.reviewComicDramaImage({ imageUrl, kind: kind || '分镜', name: name || '', expectedPrompt, visualStyle: visualStyle || '' }, modelConfig);
    });
  }
);

router.post('/comic-drama-video-quality-review',
  authMiddleware,
  tierMiddleware('video'),
  quotaMiddleware,
  async (req: TierRequest, res: Response) => {
    await handleAnalysis(req, res, 'comic_drama_video_qa', async () => {
      const { videoUrl, name, expectedPrompt, continuityStart, continuityEnd, visualStyle } = req.body || {};
      if (!videoUrl || !expectedPrompt) throw { status: 400, message: '缺少质检视频或预期动作说明' };
      return AIService.reviewComicDramaVideo({ videoUrl, name: name || '漫剧镜头', expectedPrompt, continuityStart, continuityEnd, visualStyle: visualStyle || '' }, resolveModel(req));
    });
  },
);

// 带货视频分析
router.post('/ecommerce',
  authMiddleware,
  tierMiddleware('ecommerce'),
  quotaMiddleware,
  upload.single('file'),
  async (req: TierRequest, res: Response) => {
    await handleAnalysis(req, res, 'ecommerce', async () => {
      const { videoTitle } = req.body;
      const file = req.file;
      if (!file) throw { status: 400, message: '请上传视频文件' };

      const modelConfig = resolveModel(req);
      return AIService.analyzeEcommerce(file, videoTitle, modelConfig);
    });
  }
);

// 图片逆向分析
router.post('/image',
  authMiddleware,
  tierMiddleware('image'),
  quotaMiddleware,
  upload.single('file'),
  async (req: TierRequest, res: Response) => {
    await handleAnalysis(req, res, 'image', async () => {
      const { imageRequiresText } = req.body;
      const file = req.file;
      if (!file) throw { status: 400, message: '请上传图片文件' };

      const modelConfig = resolveModel(req);
      return AIService.analyzeImage(file, imageRequiresText === 'true', modelConfig);
    });
  }
);

// 电商文案生成
router.post('/copywriting',
  authMiddleware,
  tierMiddleware('copywriting'),
  quotaMiddleware,
  upload.array('files', 10),
  async (req: TierRequest, res: Response) => {
    await handleAnalysis(req, res, 'copywriting', async () => {
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) throw { status: 400, message: '请上传产品图片或视频' };

      const modelConfig = resolveModel(req);
      return AIService.analyzeCopywriting(files, modelConfig);
    });
  }
);

// 账号全方位分析
router.post('/account',
  authMiddleware,
  tierMiddleware('account'),
  quotaMiddleware,
  upload.array('files', 5),
  async (req: TierRequest, res: Response) => {
    await handleAnalysis(req, res, 'account', async () => {
      const { accountHandle, accountDescription } = req.body;
      const files = req.files as Express.Multer.File[];

      if (!accountHandle && (!files || files.length === 0)) {
        throw { status: 400, message: '请至少输入账号名称或上传截图' };
      }

      const modelConfig = resolveModel(req);
      return AIService.analyzeAccount(accountHandle, accountDescription, files || [], modelConfig);
    });
  }
);

// 换品修改提示词
router.post('/modify-prompt',
  authMiddleware,
  tierMiddleware('modify_prompt'),
  quotaMiddleware,
  upload.single('file'),
  async (req: TierRequest, res: Response) => {
    await handleAnalysis(req, res, 'modify_prompt', async () => {
      const { existingPrompt } = req.body;
      const file = req.file;
      if (!file || !existingPrompt) throw { status: 400, message: '请上传产品图片和现有提示词' };

      const modelConfig = resolveModel(req);
      return AIService.modifyPrompt(file, existingPrompt, modelConfig);
    });
  }
);

// AI 图像生成
router.post('/generate-image',
  authMiddleware,
  tierMiddleware('generate_image'),
  quotaMiddleware,
  upload.single('reference'),
  async (req: TierRequest, res: Response) => {
    await handleAnalysis(req, res, 'generate_image', async () => {
      const { prompt, aspectRatio } = req.body;
      if (!prompt) throw { status: 400, message: '请提供图像生成提示词' };

      const modelConfig = resolveModel(req, true);
      if (!modelConfig) throw { status: 403, message: '当前等级无法使用图像生成模型' };

      const cost = PricingService.quote(modelConfig.modelId, { count: 1 }, false).cost;
      const reservation = reserveUserCharge(req.userId!, cost, 'generate_image');
      try {
        const result = await AIService.generateImage(prompt, aspectRatio || '16:9', req.file, modelConfig);
        reservation.settle(cost);
        return { ...result, billing: { cost, reservationId: reservation.id } };
      } finally { reservation.cancel(); }
    });
  }
);

// 语音合成 (TTS)
router.post('/generate-tts',
  authMiddleware,
  tierMiddleware('tts'),
  quotaMiddleware,
  async (req: TierRequest, res: Response) => {
    await handleAnalysis(req, res, 'generate_tts', async () => {
      const { text, voice } = req.body;
      if (!text) throw { status: 400, message: '请提供合成文本' };
      if (typeof voice !== 'string' || !voice.trim()) throw { status: 400, message: '请提供音色名称' };

      const modelConfig = resolveModel(req, false, true);
      if (typeof text !== 'string' || !text.trim()) throw { status: 400, message: '请提供合成文本' };
      const model = modelConfig!.modelId;
      if (voice.startsWith('voices/')) AIService.clonedVoices(req.userId!).requireVoice(voice);
      const cost = PricingService.quote(model, { characters: text.length }, false).cost;
      const reservation = reserveUserCharge(req.userId!, cost, 'generate_tts');
      try {
        let result;
        let usedVoice = voice;
        let warning: string | undefined;
        try { result = await AIService.generateTts(text, voice, modelConfig); }
        catch (error: any) {
          const invalidVoice = /(?:voice|speaker)[\s\S]*(?:not found|expired|deleted|invalid)|(?:not found|expired|deleted|invalid)[\s\S]*(?:voice|speaker)/i.test(error.message || '');
          if (!voice.startsWith('voices/') || ![400, 404, 410].includes(error.upstreamStatus) || !invalidVoice) throw error;
          const catalog = await AIService.getTtsVoiceCatalog();
          usedVoice = catalog.find(v => v.id === 'Zephyr')?.id || catalog.find(v => !v.id.startsWith('voices/'))?.id;
          if (!usedVoice) throw error;
          result = await AIService.generateTts(text, usedVoice, modelConfig);
          warning = `该克隆音色已失效，本次已使用 ${usedVoice} 合成，请重新克隆声音。`;
        }
        reservation.settle(cost);
        return { ...result, usedVoice, warning, billing: { cost, reservationId: reservation.id } };
      } finally { reservation.cancel(); }
    });
  }
);

export default router;
