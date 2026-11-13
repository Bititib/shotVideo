import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { authMiddleware } from '../middleware/auth.js';
import { tierMiddleware, type TierRequest } from '../middleware/tier.js';
import { imageAnalysisJobs, wakeImageAnalysisJobs } from '../services/imageAnalysisJobs.js';
import { sanitizedGenerationReason } from '../../shared/generationErrorPrivacy.js';

export const imageAnalysisJobsRouter = Router();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 10 * 1024 * 1024, files: 100, fields: 4 } });
imageAnalysisJobsRouter.use(authMiddleware);
imageAnalysisJobsRouter.get('/:id', (req: TierRequest, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const job = imageAnalysisJobs.get(req.userId!, req.params.id);
  if (!job) return res.status(404).json({ error: '图片分析记录不存在' });
  res.json(job);
});
imageAnalysisJobsRouter.get('/:id/images/:index', async (req: TierRequest, res, next) => {
  const item: any = imageAnalysisJobs.database.prepare('SELECT file_path FROM image_analysis_items WHERE owner=? AND job_id=? AND position=?').get(req.userId, req.params.id, Number(req.params.index));
  if (!item) return res.status(404).json({ error: '图片不存在' });
  try {
    const preview = await sharp(item.file_path).resize(640, 640, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    res.setHeader('Cache-Control', 'no-store'); res.type('jpeg').send(preview);
  } catch (error) { next(error); }
});
imageAnalysisJobsRouter.post('/', tierMiddleware('image'), upload.array('files', 100), async (req: TierRequest, res) => {
  const files = (req.files || []) as Express.Multer.File[];
  const copied: string[] = [];
  let retained = false;
  try {
    const id = String(req.body.requestId || '');
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(id)) throw Object.assign(new Error('缺少有效的分析请求编号'), { status: 400 });
    if (!files.length) throw Object.assign(new Error('请先导入或上传图片'), { status: 400 });
    const model = req.availableModels?.find(model => model.modelId === req.body.modelId);
    if (!model) throw Object.assign(new Error('所选分析模型不可用，请重新选择'), { status: 403 });
    const folder = path.resolve('data', 'image-analysis-inputs'); fs.mkdirSync(folder, { recursive: true });
    const prepared = [];
    for (const file of files) {
      const meta = await sharp(file.path, { limitInputPixels: 40_000_000 }).metadata();
      if (!['jpeg', 'png', 'webp'].includes(meta.format || '')) throw Object.assign(new Error('请上传 JPG、PNG 或 WebP 图片'), { status: 400 });
      const target = path.join(folder, `${randomUUID()}.${meta.format}`);
      fs.copyFileSync(file.path, target); copied.push(target);
      prepared.push({ path: target, mime: `image/${meta.format}`, hash: createHash('sha256').update(fs.readFileSync(target)).digest('hex') });
    }
    retained = imageAnalysisJobs.create({ id, owner: req.userId!, orgId: req.orgId, modelId: model.id,
      requiresText: req.body.imageRequiresText === 'true', files: prepared, quota: req.userTier!.dailyQuota });
    const job = imageAnalysisJobs.get(req.userId!, id);
    res.status(retained ? 202 : 200).json(job);
    wakeImageAnalysisJobs();
  } catch (error: any) {
    res.status(error.status || 500).json({ error: sanitizedGenerationReason(error.message) });
  } finally {
    for (const file of files) try { fs.unlinkSync(file.path); } catch {}
    if (!retained) for (const file of copied) try { fs.unlinkSync(file); } catch {}
  }
});
