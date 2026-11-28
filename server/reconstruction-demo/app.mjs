import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createStore } from './store.mjs';
import { styles, generationModels, cameraMovements, aspectRatios, audioModes } from './fixtures.mjs';
import { fixtureRoot, createWorker, prepareReference, taskFile } from './worker.mjs';
import { probe, detectAspectRatio } from './media.mjs';
import { analysisSettings } from './analysis-settings.mjs';
import { websiteAnalysisCatalog } from './website-analysis-catalog.mjs';

export async function createDemo({ directory, port, frontend = true, analysisTransport, websiteDatabase }) {
  const store = createStore(directory);
  const settings = analysisSettings(store, websiteAnalysisCatalog(websiteDatabase));
  store.configureAnalysis(settings);
  const worker = createWorker(store, { settings, analysisTransport });
  const sample = await prepareReference(directory);
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.get('host') || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return res.status(403).json({ error: '模拟服务仅限本机使用' });
    const origin = req.get('origin');
    if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: '仅接受本机工作台操作' });
    if (origin && origin !== 'http://' + host) return res.status(403).json({ error: '模拟服务仅接受本页操作' });
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  const upload = multer({ dest: directory, limits: { fileSize: 150 * 1024 * 1024, files: 1 } });
  const wrap = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
  app.get('/demo/health', (req, res) => res.json({ ok: true, mode: settings.get().selected.mode === 'real' ? 'third-party-analysis' : 'local-simulation',
    externalCalls: store.sql.prepare('SELECT count(*) AS count FROM analysis_attempts').get().count }));
  app.get('/demo/analysis-configuration', wrap((req, res) => res.json(settings.get())));
  app.get('/app/video-reconstruction/settings', (_req,res) => res.redirect(303,'/app/video-reconstruction'));
  app.get('/demo/styles', (req, res) => res.json(styles));
  app.get('/demo/generation-models', (req, res) => res.json({ ...generationModels, cameraMovements, aspectRatios, audioModes, simulated: true,
    notice: '本地模拟：模型与运镜列表仅用于界面演示，生成结果均为本地素材，不产生费用' }));
  app.use('/demo/fixtures', express.static(fixtureRoot));
  app.get('/demo/sample.mp4', (req, res) => res.type('video/mp4').sendFile(sample));
  app.get('/demo/projects', (req, res) => res.json(store.sql.prepare('SELECT id,name,created FROM projects ORDER BY rowid DESC').all()));
  app.get('/demo/projects/:id', wrap((req, res) => res.json(store.project(req.params.id))));
  app.post('/demo/projects/sample', wrap(async (req, res) => {
    const preset = req.body?.preset === 'duo' ? 'duo' : '';
    const id = store.create(preset === 'duo' ? '雨夜来信 · 双人示例素材' : '雨夜来信 · 示例素材', preset);
    await fs.copyFile(sample, path.join(directory, id, 'source.mp4'));
    res.status(201).json(store.project(id));
  }));
  app.post('/demo/projects/import', wrap(async (req, res) => {
    if (!['https://sample.local/rainy-letter.mp4', '/demo/sample.mp4'].includes(req.body.url?.trim())) {
      throw store.error('模拟链接请使用 https://sample.local/rainy-letter.mp4；也可上传本地视频', 422);
    }
    const id = store.create('链接导入 · 示例视频');
    await fs.copyFile(sample, path.join(directory, id, 'source.mp4'));
    res.status(201).json(store.project(id));
  }));
  app.post('/demo/projects/upload', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw store.error('请上传视频', 422);
    try {
      const info = await probe(req.file.path);
      const duration = Number(info.format.duration);
      const real = settings.get().selected.mode === 'real';
      if (!info.streams.some(stream => stream.codec_type === 'video') || !Number.isFinite(duration) || duration <= 0 || duration > (real ? 600 : 30) || (!real && duration < 15)) {
        throw store.error(real ? '视频分析验证支持 10 分钟以内的视频' : '模拟样例需上传 15–30 秒的视频，也可以使用示例视频', 422);
      }
      if (real && req.file.size > 18 * 1024 * 1024) throw store.error('当前内联验证支持 18 MB 以内的视频，请使用较小测试视频', 422);
      const id = store.create(req.file.originalname.slice(0, 100), '', { aspectRatio: detectAspectRatio(info) });
      await fs.copyFile(req.file.path, path.join(directory, id, 'source.mp4'));
      res.status(201).json(store.project(id));
    } finally { await fs.rm(req.file.path, { force: true }); }
  }));
  app.post('/demo/projects/from-script', wrap((req, res) => {
    const selectedVideo = generationModels.video.find(m => m.id === req.body?.videoModel);
    const id = store.createFromScript(req.body, {
      videoModel: selectedVideo?.id || req.body?.videoModel,
      allowedSeconds: selectedVideo?.allowedSeconds || req.body?.allowedSeconds,
    });
    res.status(201).json(store.project(id));
  }));
  app.get('/demo/projects/:id/source', wrap((req, res) => {
    const state = store.project(req.params.id);
    const file = path.join(directory, state.id, 'source.mp4');
    if (!existsSync(file)) throw store.error('纯剧本模式无原片视频', 404);
    res.type('video/mp4').sendFile(file);
  }));
  app.get('/demo/projects/:id/original/:shot', wrap((req, res) => {
    const state = store.project(req.params.id);
    if (!state.plan?.shots.some(shot => shot.id === req.params.shot)) throw store.error('原片首帧不存在', 404);
    const file = path.join(directory, state.id, 'original-' + req.params.shot + '.png');
    if (!existsSync(file)) throw store.error('原片首帧不存在', 404);
    res.type('image/png').sendFile(file);
  }));
  app.post('/demo/projects/:id/style', wrap((req, res) => res.json(store.setStyle(req.params.id, req.body.style))));
  app.post('/demo/projects/:id/aspect-ratio', wrap((req, res) => res.json(store.setAspectRatio(req.params.id, req.body?.aspectRatio))));
  app.post('/demo/projects/:id/audio-mode', wrap((req, res) => res.json(store.setAudioMode(req.params.id, req.body?.audioMode))));
  app.post('/demo/projects/:id/characters', wrap((req, res) => res.status(201).json(store.addCharacter(req.params.id, req.body))));
  app.post('/demo/projects/:id/subjects/upload', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw store.error('请上传商品/主体图片（JPG / PNG / WebP）', 422);
    try {
      let pngBuffer;
      try {
        pngBuffer = await sharp(req.file.path)
          .resize(576, 720, { fit: 'contain', background: { r: 245, g: 242, b: 234, alpha: 1 } })
          .png()
          .toBuffer();
      } catch {
        throw store.error('图片格式无效，请上传 JPG / PNG / WebP 商品图', 422);
      }
      let shots = [];
      if (typeof req.body?.shots === 'string' && req.body.shots.trim()) {
        try { shots = JSON.parse(req.body.shots); } catch { shots = []; }
      }
      const { taskId } = store.attachUploadedSubject(req.params.id, {
        name: req.body?.name,
        appearance: req.body?.appearance,
        shots,
      });
      await fs.writeFile(path.join(directory, req.params.id, taskId + '.png'), pngBuffer);
      res.status(201).json(store.project(req.params.id));
    } finally {
      await fs.rm(req.file.path, { force: true });
    }
  }));
  app.delete('/demo/projects/:id/characters/:roleId', wrap((req, res) => res.json(store.removeCharacter(req.params.id, req.params.roleId))));
  app.post('/demo/projects/:id/shots/:shotId/characters', wrap((req, res) => res.json(store.setShotCharacters(req.params.id, req.params.shotId, req.body?.characters))));
  app.post('/demo/projects/:id/script', wrap((req, res) => res.json(store.updateScript(req.params.id, req.body))));
  app.post('/demo/projects/:id/script/rewrite', wrap((req, res) => res.json(store.rewriteScript(req.params.id, req.body))));
  app.post('/demo/projects/:id/:kind/:slot/quote', wrap((req, res) => {
    const input = store.prepare(req.params.id, req.params.kind, req.params.slot, req.body);
    res.json({ cost: 0, input, model: input.model, currency: 'CNY' });
  }));
  app.post('/demo/projects/:id/:kind/:slot/generate', wrap((req, res) => {
    const taskIds = store.enqueueBatch(req.params.id, req.params.kind, req.params.slot, req.body);
    res.json({ ...store.project(req.params.id), taskId: taskIds[0], taskIds });
    void worker.tick().catch(console.error);
  }));
  app.post('/demo/projects/:id/:kind/:slot/confirm', wrap((req, res) => {
    res.json(store.confirm(req.params.id, req.params.kind, req.params.slot, req.body.taskId));
  }));
  app.get('/demo/media/:id', wrap((req, res) => {
    const row = store.sql.prepare("SELECT * FROM tasks WHERE id=? AND status='completed'").get(req.params.id);
    if (!row || row.kind === 'analysis') throw store.error('素材尚未完成', 404);
    if (req.query.captions === '1' && row.kind === 'film') return res.type('text/vtt').sendFile(path.join(directory, row.project, 'captions.vtt'));
    const file = taskFile(store, row);
    if (req.query.download === '1') res.attachment(row.kind === 'film' ? '雨夜来信-模拟成片.mp4' : path.basename(file));
    res.type(['video', 'film'].includes(row.kind) ? 'video/mp4' : 'image/png').sendFile(file);
  }));
  app.use('/demo', (req, res) => res.status(404).json({ error: '模拟接口不存在' }));
  let vite;
  if (frontend) {
    const { createServer } = await import('vite');
    const react = (await import('@vitejs/plugin-react')).default;
    const root = path.resolve('client');
    vite = await createServer({ configFile: false, root, plugins: [react()], appType: 'custom', server: {
      middlewareMode: true, hmr: false, allowedHosts: ['127.0.0.1', 'localhost'], fs: { allow: [path.resolve('.'), path.resolve('../..')],
        deny: ['**/.env*', '**/*.db', '**/*.db-*', '**/*.sqlite*', '**/*.receipt.json', '**/data/**', '**/.git/**', '**/*.{crt,pem}', '**/secrets/**'] },
    } });
    app.use(vite.middlewares);
    app.get(['/app/video-reconstruction*', '/'], wrap(async (req, res) => {
      const html = await fs.readFile(path.join(root, 'reconstruction-demo.html'), 'utf8');
      res.type('text/html').send(await vite.transformIndexHtml(req.originalUrl, html));
    }));
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const message = error.code === 'LIMIT_FILE_SIZE' ? '视频不能超过 150 MB' : error.message || '本地模拟处理失败';
    res.status(error.status || 400).json({ error: message });
  });
  worker.start();
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, '127.0.0.1', () => resolve(listener));
    listener.on('error', reject);
  });
  return { store, worker, server, url: 'http://127.0.0.1:' + server.address().port,
    async close() { worker.stop(); await worker.idle(); await vite?.close(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); store.sql.close(); } };
}
