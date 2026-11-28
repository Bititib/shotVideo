import express, { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import jwt from 'jsonwebtoken';
import { optionalAuthMiddleware, type AuthRequest } from '../middleware/auth.js';
import { getEnabledPublicModels } from '../services/modelCatalogService.js';
import { getModelSpecification } from '../services/modelRoutingService.js';
import { filterUserModels } from '../services/userModelAccessService.js';
import { PricingService } from '../services/pricingService.js';
import { registerUpload, issueUploadUrl } from '../services/uploadAccess.js';
import { sqlite } from '../db/index.js';
import { env } from '../config/env.js';
// @ts-ignore
import { createStore } from '../reconstruction-demo/store.mjs';
// @ts-ignore
import { styles, generationModels, cameraMovements, aspectRatios, audioModes } from '../reconstruction-demo/fixtures.mjs';
// @ts-ignore
import { fixtureRoot, createWorker, prepareReference, taskFile } from '../reconstruction-demo/worker.mjs';
// @ts-ignore
import { probe, detectAspectRatio } from '../reconstruction-demo/media.mjs';
// @ts-ignore
import { analysisSettings } from '../reconstruction-demo/analysis-settings.mjs';
// @ts-ignore
import { websiteAnalysisCatalog } from '../reconstruction-demo/website-analysis-catalog.mjs';

const dataDir = path.resolve(process.cwd(), 'data/reconstruction-demo');
mkdirSync(dataDir, { recursive: true });
const appDbPath = path.resolve(process.cwd(), 'data/app.db');

function buildDynamicCatalog(userId?: number | null) {
  const realImageSource = filterUserModels(userId ?? undefined, getEnabledPublicModels('image'));
  const realVideoSource = filterUserModels(userId ?? undefined, getEnabledPublicModels('video'));
  const allIds = [...realImageSource.map(m => m.modelId), ...realVideoSource.map(m => m.modelId)];
  const pricingMap = new Map(
    PricingService.getPublicPricingForModels(allIds, userId ?? null).map(p => [p.model, p]),
  );

  const realImages = realImageSource.map(m => {
    const p = pricingMap.get(m.modelId);
    const rate = p?.unit_price ?? PricingService.calculateCost(m.modelId, 0, 0);
    return {
      id: m.modelId,
      name: m.displayName || m.modelId,
      tag: '真实渠道',
      description: m.description || '主站已启用图像生成渠道（按账本计费）',
      counts: [1, 2, 4],
      defaultCount: 1,
      rate,
      resolutionPrices: p?.resolution_prices || {},
      real: true,
    };
  });

  const realVideos = realVideoSource.map(m => {
    const p = pricingMap.get(m.modelId);
    const rate = p?.unit_price ?? PricingService.calculateCost(m.modelId, 0, 0);
    const resKeys = Object.keys(p?.resolution_prices || {});
    const spec = getModelSpecification(m.modelId);
    const d = spec?.limits?.duration;
    const allowedSeconds = d
      ? d.mode === 'fixed'
        ? [d.min]
        : d.mode === 'options'
          ? d.values
          : Array.from(
              { length: Math.floor((d.max - d.min) / Math.max(1, d.step || 1)) + 1 },
              (_, index) => d.min + index * Math.max(1, d.step || 1),
            )
      : [5, 10];
    return {
      id: m.modelId,
      name: m.displayName || m.modelId,
      tag: '真实渠道',
      description: m.description || '主站已启用视频生成渠道（按账本计费）',
      counts: [1, 2],
      defaultCount: 1,
      resolutions: resKeys.length ? resKeys : ['720p', '1080p'],
      allowedSeconds,
      rate,
      resolutionPrices: p?.resolution_prices || {},
      real: true,
    };
  });

  const mockImages = generationModels.image.map((m: any) => ({
    ...m,
    tag: m.tag ? `${m.tag}·模拟` : '本地模拟',
    rate: 0,
    real: false,
  }));
  const mockVideos = generationModels.video.map((m: any) => ({
    ...m,
    tag: m.tag ? `${m.tag}·模拟` : '本地模拟',
    rate: 0,
    real: false,
  }));

  return {
    image: [...realImages, ...mockImages],
    video: [...realVideos, ...mockVideos],
    cameraMovements,
    aspectRatios,
    audioModes,
    simulated: realImages.length === 0 && realVideos.length === 0,
    notice: realImages.length || realVideos.length
      ? '支持切换主站真实计费渠道（自动写入资金流水与使用记录）或本地免费模拟预览'
      : '当前未启用主站真实生图/视频渠道，使用本地模拟素材（0 元）',
  };
}

async function fileToDataUrl(filePath: string, mime = 'image/png'): Promise<string> {
  const buf = await fs.readFile(filePath);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function copyUrlToFile(resultUrl: string, destFile: string) {
  if (resultUrl.startsWith('data:')) {
    const m = resultUrl.match(/^data:[^;]+;base64,(.+)$/);
    if (!m) throw new Error('无效的 data URL 结果');
    await fs.writeFile(destFile, Buffer.from(m[1], 'base64'));
    return;
  }
  const cleanRel = resultUrl.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api\/uploads\//, '/uploads/').split('?')[0];
  if (cleanRel.startsWith('/uploads/')) {
    const localUpload = path.resolve(process.cwd(), 'data', cleanRel.slice(1));
    if (existsSync(localUpload)) {
      await fs.copyFile(localUpload, destFile);
      return;
    }
  }
  const fullUrl = resultUrl.startsWith('http') ? resultUrl : `http://127.0.0.1:${env.PORT}${resultUrl}`;
  const res = await fetch(fullUrl, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`下载生成结果失败 (HTTP ${res.status})`);
  await fs.writeFile(destFile, Buffer.from(await res.arrayBuffer()));
}

async function pollExistingContent(contentId: number, token: string): Promise<string> {
  for (let attempt = 0; attempt < 360; attempt++) {
    const res = await fetch(`http://127.0.0.1:${env.PORT}/api/contents/${contentId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const content: any = await res.json().catch(() => ({}));
    if (res.ok && content.status === 'completed' && content.resultUrl) return content.resultUrl;
    if (res.ok && content.status === 'failed') {
      throw new Error(content.metadata?.error || content.error || '上游任务执行失败');
    }
    if (res.ok && (content.status === 'review' || content.metadata?.requiresReview)) {
      throw Object.assign(new Error('原生成任务回执待核实，已冻结预扣并禁止自动重发'), { taskStatus: 'needs_review' });
    }
    await new Promise(resolve => setTimeout(resolve, 4_000));
  }
  throw Object.assign(new Error('生成任务查询超时，已转入待核实，不会重复提交'), { taskStatus: 'needs_review' });
}

async function consumeInternalSse(
  endpoint: string,
  token: string,
  body: Record<string, any>,
  resultField: 'imageUrl' | 'videoUrl',
  onContentCreated: (contentId: number) => void,
): Promise<string> {
  let contentId = 0;
  const response = await fetch(`http://127.0.0.1:${env.PORT}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(7_200_000),
  });
  if (!response.ok) {
    const payload: any = await response.json().catch(() => ({}));
    throw new Error(payload.error || `提交生成失败 (HTTP ${response.status})`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw Object.assign(new Error('生成服务未返回任务流，请核实原记录'), { taskStatus: 'needs_review' });
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let lastResult = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      let event: any = {};
      try { event = JSON.parse(line.slice(6)); } catch { continue; }
      if (event.contentId && Number(event.contentId) !== contentId) {
        contentId = Number(event.contentId);
        onContentCreated(contentId);
      }
      if (event.type === 'error') {
        if (contentId) return await pollExistingContent(contentId, token);
        throw new Error(event.message || '生成失败');
      }
      if (event[resultField]) lastResult = event[resultField];
      if (resultField === 'imageUrl' && Array.isArray(event.imageUrls) && event.imageUrls[0]) {
        lastResult = event.imageUrls[0];
      }
    }
  }
  if (lastResult) return lastResult;
  if (contentId) return await pollExistingContent(contentId, token);
  throw Object.assign(new Error('生成连接中断且未收到明确结果，请核对使用记录'), { taskStatus: 'needs_review' });
}

const store = createStore(dataDir);
const settings = analysisSettings(store, websiteAnalysisCatalog(appDbPath));
store.configureAnalysis(settings);
store.configureModels(() => buildDynamicCatalog(null));

const worker = createWorker(store, {
  settings,
  async externalExecutor({ task, input, state, directory, temp }: any) {
    if (!input.real || !['role', 'frame', 'video'].includes(task.kind)) return false;
    const ownerId = Number(state.userId || 0);
    const user = (ownerId
      ? sqlite.prepare('SELECT id, role, org_id FROM users WHERE id=? AND is_active=1').get(ownerId)
      : sqlite.prepare("SELECT id, role, org_id FROM users WHERE role='admin' AND is_active=1 ORDER BY id LIMIT 1").get()) as any;
    if (!user) throw new Error('请先登录有效账号后再使用真实计费渠道生成');
    const token = jwt.sign({ userId: user.id, role: user.role, orgId: user.org_id || null }, env.JWT_SECRET, { expiresIn: '2h' });

    // Recovery path: if contentId was already created before a restart, never re-submit!
    if (input.contentId) {
      const url = await pollExistingContent(Number(input.contentId), token);
      await copyUrlToFile(url, temp);
      return true;
    }

    const recordContentId = (contentId: number) => {
      store.sql.prepare("UPDATE tasks SET input=json_set(input,'$.contentId',?) WHERE id=?").run(contentId, task.id);
    };

    if (task.kind === 'role' || task.kind === 'frame') {
      const referenceImages: string[] = [];
      if (task.kind === 'frame') {
        for (const ref of input.roles || []) {
          const roleRow = store.sql.prepare('SELECT * FROM tasks WHERE id=?').get(ref.taskId);
          if (roleRow) {
            const roleFile = taskFile(store, roleRow);
            if (existsSync(roleFile)) referenceImages.push(await fileToDataUrl(roleFile));
          }
        }
        const origFile = path.join(directory, `original-${input.original}.png`);
        if (existsSync(origFile)) referenceImages.push(await fileToDataUrl(origFile));
      }
      const styledPrompt = input.styleName && input.style !== 'original'
        ? `【${input.styleName}画风】${input.prompt}`
        : input.prompt;
      const resultUrl = await consumeInternalSse(
        '/api/image-gen/generate',
        token,
        {
          model: input.modelId,
          prompt: styledPrompt,
          aspectRatio: state.aspectRatio || '9:16',
          count: 1,
          referenceImages,
        },
        'imageUrl',
        recordContentId,
      );
      await copyUrlToFile(resultUrl, temp);
      return true;
    }

    if (task.kind === 'video') {
      const frameRow = store.sql.prepare('SELECT * FROM tasks WHERE id=?').get(input.firstFrameTask);
      if (!frameRow) throw new Error('未找到已锁定的分镜首帧文件');
      const frameFile = taskFile(store, frameRow);
      const uploadName = `recon_frame_${task.id}.png`;
      const uploadDest = path.resolve(process.cwd(), 'data/uploads', uploadName);
      await fs.copyFile(frameFile, uploadDest);
      const signedFrameUrl = issueUploadUrl(registerUpload(`/uploads/${uploadName}`), `http://127.0.0.1:${env.PORT}`);
      const resultUrl = await consumeInternalSse(
        '/api/video/generate',
        token,
        {
          model: input.modelId,
          prompt: input.prompt,
          aspectRatio: state.aspectRatio || '9:16',
          resolution: input.resolution || '720p',
          duration: input.duration,
          imageUrl: signedFrameUrl,
        },
        'videoUrl',
        recordContentId,
      );
      await copyUrlToFile(resultUrl, temp);
      return true;
    }

    return false;
  },
});

let samplePathPromise: Promise<string> | null = null;
function getSamplePath() {
  if (!samplePathPromise) samplePathPromise = prepareReference(dataDir);
  return samplePathPromise;
}
worker.start();

function assertProjectAccess(state: any, req: AuthRequest) {
  if (!req.userId || !state.userId) return;
  if (state.userId === req.userId || req.userRole === 'admin') return;
  if (req.orgId && state.orgId && req.orgId === state.orgId) return;
  throw store.error('无权访问此复刻项目', 403);
}

const router = Router();
const upload = multer({ dest: dataDir, limits: { fileSize: 150 * 1024 * 1024, files: 1 } });
const wrap = (handler: (req: AuthRequest, res: Response) => Promise<any> | any) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve().then(() => handler(req as AuthRequest, res)).catch(next);

router.use(optionalAuthMiddleware);

router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    mode: settings.get().selected.mode === 'real' ? 'third-party-analysis' : 'local-simulation',
    externalCalls: (store.sql.prepare('SELECT count(*) AS count FROM analysis_attempts').get() as any)?.count ?? 0,
  });
});

router.get('/analysis-configuration', wrap((_req, res) => res.json(settings.get())));
router.get('/styles', (_req, res) => res.json(styles));
router.get('/generation-models', wrap((req, res) => res.json(buildDynamicCatalog(req.userId ?? null))));
router.use('/fixtures', express.static(fixtureRoot));

router.get('/sample.mp4', wrap(async (_req, res) => {
  const sample = await getSamplePath();
  res.type('video/mp4').sendFile(sample);
}));

router.get('/projects', wrap((req, res) => {
  if (req.userId && req.userRole !== 'admin') {
    const rows = store.sql
      .prepare('SELECT id,name,created FROM projects WHERE user_id=? OR user_id=0 ORDER BY rowid DESC')
      .all(req.userId);
    return res.json(rows);
  }
  res.json(store.sql.prepare('SELECT id,name,created FROM projects ORDER BY rowid DESC').all());
}));

router.get('/projects/:id', wrap((req, res) => {
  const state = store.project(req.params.id);
  assertProjectAccess(state, req);
  res.json(state);
}));

router.post('/projects/sample', wrap(async (req, res) => {
  const sample = await getSamplePath();
  const preset = req.body?.preset === 'duo' ? 'duo' : '';
  const id = store.create(preset === 'duo' ? '雨夜来信 · 双人示例素材' : '雨夜来信 · 示例素材', preset, {
    userId: req.userId || 0,
    orgId: req.orgId || null,
  });
  await fs.copyFile(sample, path.join(dataDir, id, 'source.mp4'));
  res.status(201).json(store.project(id));
}));

router.post('/projects/from-script', wrap((req, res) => {
  const catalog = buildDynamicCatalog(req.userId || null);
  const selectedVideo = catalog.video.find((m: any) => m.id === req.body?.videoModel);
  const id = store.createFromScript(req.body, {
    userId: req.userId || 0,
    orgId: req.orgId || null,
    aspectRatio: req.body?.aspectRatio,
    videoModel: selectedVideo?.id || req.body?.videoModel,
    allowedSeconds: selectedVideo?.allowedSeconds || req.body?.allowedSeconds,
  });
  res.status(201).json(store.project(id));
}));

router.post('/projects/import', wrap(async (req, res) => {
  if (!['https://sample.local/rainy-letter.mp4', '/demo/sample.mp4'].includes(req.body?.url?.trim())) {
    throw store.error('示例链接请使用 https://sample.local/rainy-letter.mp4；也可直接上传本地视频文件', 422);
  }
  const sample = await getSamplePath();
  const id = store.create('链接导入 · 示例视频', '', { userId: req.userId || 0, orgId: req.orgId || null });
  await fs.copyFile(sample, path.join(dataDir, id, 'source.mp4'));
  res.status(201).json(store.project(id));
}));

router.post('/projects/upload', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw store.error('请上传视频', 422);
  try {
    const info = await probe(req.file.path);
    const duration = Number(info.format.duration);
    const real = settings.get().selected.mode === 'real';
    if (!info.streams.some((s: any) => s.codec_type === 'video') || !Number.isFinite(duration) || duration <= 0 || duration > (real ? 600 : 60)) {
      throw store.error(real ? '视频分析支持 10 分钟以内的视频' : '请上传 60 秒以内的短视频，或使用示例视频', 422);
    }
    if (real && req.file.size > 150 * 1024 * 1024) {
      throw store.error('原片超过 150 MB 上传上限', 422);
    }
    const id = store.create(req.file.originalname.slice(0, 100), '', {
      aspectRatio: detectAspectRatio(info),
      userId: req.userId || 0,
      orgId: req.orgId || null,
    });
    await fs.copyFile(req.file.path, path.join(dataDir, id, 'source.mp4'));
    res.status(201).json(store.project(id));
  } finally {
    await fs.rm(req.file.path, { force: true });
  }
}));

router.get('/projects/:id/source', wrap((req, res) => {
  const state = store.project(req.params.id);
  assertProjectAccess(state, req);
  const file = path.join(dataDir, state.id, 'source.mp4');
  if (!existsSync(file)) throw store.error('纯剧本模式无原片视频', 404);
  res.type('video/mp4').sendFile(file);
}));

router.get('/projects/:id/original/:shot', wrap((req, res) => {
  const state = store.project(req.params.id);
  assertProjectAccess(state, req);
  if (!state.plan?.shots.some((shot: any) => shot.id === req.params.shot)) throw store.error('原片首帧不存在', 404);
  const file = path.join(dataDir, state.id, 'original-' + req.params.shot + '.png');
  if (!existsSync(file)) throw store.error('原片首帧不存在', 404);
  res.type('image/png').sendFile(file);
}));

router.post('/projects/:id/style', wrap((req, res) => {
  assertProjectAccess(store.project(req.params.id), req);
  res.json(store.setStyle(req.params.id, req.body?.style));
}));

router.post('/projects/:id/aspect-ratio', wrap((req, res) => {
  assertProjectAccess(store.project(req.params.id), req);
  res.json(store.setAspectRatio(req.params.id, req.body?.aspectRatio));
}));

router.post('/projects/:id/audio-mode', wrap((req, res) => {
  assertProjectAccess(store.project(req.params.id), req);
  res.json(store.setAudioMode(req.params.id, req.body?.audioMode));
}));

router.post('/projects/:id/characters', wrap((req, res) => {
  assertProjectAccess(store.project(req.params.id), req);
  res.status(201).json(store.addCharacter(req.params.id, req.body));
}));

router.post('/projects/:id/subjects/upload', upload.single('file'), wrap(async (req, res) => {
  assertProjectAccess(store.project(req.params.id), req);
  if (!req.file) throw store.error('请上传商品/主体图片（JPG / PNG / WebP）', 422);
  try {
    let pngBuffer: Buffer;
    try {
      pngBuffer = await sharp(req.file.path)
        .resize(576, 720, { fit: 'contain', background: { r: 245, g: 242, b: 234, alpha: 1 } })
        .png()
        .toBuffer();
    } catch {
      throw store.error('图片格式无效，请上传 JPG / PNG / WebP 商品图', 422);
    }
    let shots: string[] = [];
    if (typeof req.body?.shots === 'string' && req.body.shots.trim()) {
      try { shots = JSON.parse(req.body.shots); } catch { shots = []; }
    }
    const { taskId } = store.attachUploadedSubject(req.params.id, {
      name: req.body?.name,
      appearance: req.body?.appearance,
      shots,
    });
    await fs.writeFile(path.join(dataDir, req.params.id, taskId + '.png'), pngBuffer);
    res.status(201).json(store.project(req.params.id));
  } finally {
    await fs.rm(req.file.path, { force: true });
  }
}));

router.delete('/projects/:id/characters/:roleId', wrap((req, res) => {
  assertProjectAccess(store.project(req.params.id), req);
  res.json(store.removeCharacter(req.params.id, req.params.roleId));
}));

router.post('/projects/:id/shots/:shotId/characters', wrap((req, res) => {
  assertProjectAccess(store.project(req.params.id), req);
  res.json(store.setShotCharacters(req.params.id, req.params.shotId, req.body?.characters));
}));

router.post('/projects/:id/script', wrap((req, res) => {
  assertProjectAccess(store.project(req.params.id), req);
  res.json(store.updateScript(req.params.id, req.body));
}));

router.post('/projects/:id/script/rewrite', wrap((req, res) => {
  assertProjectAccess(store.project(req.params.id), req);
  res.json(store.rewriteScript(req.params.id, req.body));
}));

router.post('/projects/:id/:kind/:slot/quote', wrap((req, res) => {
  assertProjectAccess(store.project(req.params.id), req);
  const input = store.prepare(req.params.id, req.params.kind, req.params.slot, req.body);
  let cost = 0;
  if (input.real && input.modelId) {
    const count = Number(req.body?.count || 1);
    const quoteFn = (PricingService as any).quotePrice;
    cost = typeof quoteFn === 'function'
      ? quoteFn.call(
          PricingService,
          input.modelId,
          { count, seconds: (input.duration || 0) * count, resolution: input.resolution || undefined },
          req.userId ?? null,
        ).cost
      : PricingService.calculateCost(input.modelId, count, (input.duration || 0) * count);
  }
  res.json({ cost, input, model: input.model, currency: 'CNY' });
}));

router.post('/projects/:id/:kind/:slot/generate', wrap((req, res) => {
  assertProjectAccess(store.project(req.params.id), req);
  const taskIds = store.enqueueBatch(req.params.id, req.params.kind, req.params.slot, req.body);
  res.json({ ...store.project(req.params.id), taskId: taskIds[0], taskIds });
  void worker.tick().catch(console.error);
}));

router.post('/projects/:id/:kind/:slot/confirm', wrap((req, res) => {
  assertProjectAccess(store.project(req.params.id), req);
  res.json(store.confirm(req.params.id, req.params.kind, req.params.slot, req.body?.taskId));
}));

router.get('/media/:id', wrap((req, res) => {
  const row = store.sql.prepare("SELECT * FROM tasks WHERE id=? AND status='completed'").get(req.params.id) as any;
  if (!row || row.kind === 'analysis') throw store.error('素材尚未完成', 404);
  if (req.query.captions === '1' && row.kind === 'film') {
    return res.type('text/vtt').sendFile(path.join(dataDir, row.project, 'captions.vtt'));
  }
  const file = taskFile(store, row);
  if (req.query.download === '1') {
    res.attachment(row.kind === 'film' ? '复刻成片.mp4' : path.basename(file));
  }
  res.type(['video', 'film'].includes(row.kind) ? 'video/mp4' : 'image/png').sendFile(file);
}));

router.use((error: any, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(error);
  const message = error.code === 'LIMIT_FILE_SIZE' ? '视频不能超过 150 MB' : error.message || '处理失败';
  res.status(error.status || 400).json({ error: message });
});

export default router;
