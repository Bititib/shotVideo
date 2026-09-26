import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { resolveBatchArchiveFile, streamVideoZip } from '../services/videoBatchArchive.js';
import type { Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { tierMiddleware, type TierRequest } from '../middleware/tier.js';
import { quotaMiddleware } from '../middleware/quota.js';
import { sqlite } from '../db/index.js';
import { env } from '../config/env.js';
import { batchStore, tickVideoBatches } from '../services/videoBatchService.js';
import { materializeContentMetadataAssets } from '../services/contentService.js';
import { validateVideoPrompt } from '../services/videoPromptValidation.js';
import type { VideoBatchInput } from '../../shared/videoBatch.js';

const router = Router();
// Short-lived, single-use capabilities: no account JWT in a URL or browser memory
// buffering. A browser can stream this archive straight to its download manager.
const downloadTickets = new Map<string, { expires: number; batchId: number; userId: number; files: { path: string; name: string }[] }>();
router.get('/download/:ticket', async (req, res) => {
  const ticket = downloadTickets.get(req.params.ticket);
  downloadTickets.delete(req.params.ticket);
  if (!ticket || ticket.expires < Date.now()) { res.status(410).send('下载链接已失效，请重新点击打包下载'); return; }
  const owner = sqlite.prepare('SELECT is_active FROM users WHERE id=?').get(ticket.userId) as any;
  if (!owner?.is_active) { res.status(403).end(); return; }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Disposition', `attachment; filename="batch-${ticket.batchId}.zip"`);
  try { await pipeline(Readable.from(streamVideoZip(ticket.files)), res); }
  catch (error) { console.warn('[video-batch] archive interrupted:', error); if (!res.destroyed) res.destroy(); }
});
router.use(authMiddleware);
const handle = (fn: (req: TierRequest, res: Response) => any) => (req: TierRequest, res: Response, next: NextFunction) => {
  Promise.resolve().then(() => fn(req, res)).catch(error => {
    if (res.headersSent) return next(error);
    res.status(error.status || 400).json({ error: error.message || '批量任务操作失败' });
  });
};

export function validateBatchInput(body: any): VideoBatchInput {
  if (!body || typeof body.model !== 'string' || !body.model) throw new Error('请选择视频模型');
  if (!['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].includes(body.aspect_ratio)) throw new Error('请选择正确画面比例');
  if (!Number.isInteger(body.video_length) || body.video_length < 1 || body.video_length > 120) throw new Error('视频时长必须为 1–120 秒的整数');
  if (!['480p', '720p', '1080p', '2k', '4k'].includes(body.resolution)) throw new Error('请选择正确分辨率');
  if (typeof body.autoRetry !== 'boolean' || !Number.isInteger(body.maxRetries) || body.maxRetries < 0 || body.maxRetries > 3) throw new Error('自动重试最多 3 次');
  if (!Array.isArray(body.creatives) || body.creatives.length < 1 || body.creatives.length > 20) throw new Error('每个批次支持 1–20 组创意');
  const media = (value: unknown, max: number, images: boolean): string[] => {
    if (value === undefined) return [];
    if (Array.isArray(value)) value = value.filter(v => typeof v !== 'string' || v.trim()).map(v => typeof v === 'string' ? v.trim() : v);
    if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== 'string' || v.length > 20_000_000 ||
      !( /^https?:\/\//i.test(v) || (images && /^data:image\//i.test(v)) || /^\/(?:api\/)?uploads\//.test(v)))) throw new Error('素材格式或数量不正确，请使用图片文件或可访问的素材链接');
    return value;
  };
  const creatives = body.creatives.map((c: any, index: number) => {
    const error = validateVideoPrompt(c?.prompt);
    if (error) throw new Error(`创意 ${index + 1}：${error}`);
    if (!Number.isInteger(c.count) || c.count < 1 || c.count > 100) throw new Error('每组生成数量需为 1–100 的整数');
    return { prompt: c.prompt, count: c.count, reference_images: media(c.reference_images, 10, true),
      reference_videos: media(c.reference_videos, 10, false), audio_urls: media(c.audio_urls, 10, false) };
  });
  if (creatives.reduce((n, c) => n + c.count, 0) > 100) throw new Error('单批次最多生成 100 条视频');
  return { name: typeof body.name === 'string' ? body.name.slice(0, 80) || '批量视频' : '批量视频',
    model: body.model, aspect_ratio: body.aspect_ratio, video_length: body.video_length, resolution: body.resolution,
    autoRetry: body.autoRetry, maxRetries: body.maxRetries, creatives };
}

const originFor = (req: TierRequest) => (process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

async function preflight(req: TierRequest, input: VideoBatchInput) {
  const model = sqlite.prepare('SELECT * FROM models WHERE model_id=? AND is_active=1').get(input.model) as any;
  if (!model || !JSON.parse(model.capabilities || '[]').includes('video')) throw new Error('该视频模型已下架或不可用');
  let unitCost = -1;
  const { creatives, ...config } = input;
  for (let index = 0; index < creatives.length; index++) {
    const response = await fetch(`http://127.0.0.1:${env.PORT}/api/video/validate`, {
      method: 'POST', headers: { Authorization: req.headers.authorization!, 'Content-Type': 'application/json',
        Host: new URL(originFor(req)).host, 'X-Forwarded-Proto': new URL(originFor(req)).protocol.slice(0, -1) },
      body: JSON.stringify({ ...config, ...creatives[index] }), signal: AbortSignal.timeout(120000),
    });
    const result: any = await response.json();
    if (!response.ok) throw new Error(`创意 ${index + 1}：${result.error || '参数校验失败'}`);
    if (!Number.isFinite(result.unitCost) || result.unitCost < 0) throw new Error('费用配置异常');
    if (unitCost >= 0 && unitCost !== result.unitCost) throw new Error('价格正在调整，请重新预估');
    unitCost = result.unitCost;
  }
  const total = input.creatives.reduce((n, c) => n + c.count, 0);
  return { unitCost, total, totalCost: Math.round(unitCost * total * 1e6) / 1e6 };
}

router.post('/quote', tierMiddleware('video'), quotaMiddleware, handle(async (req, res) => {
  res.json(await preflight(req, validateBatchInput(req.body)));
}));
router.post('/', tierMiddleware('video'), quotaMiddleware, handle(async (req, res) => {
  const key = req.body?.requestKey;
  if (typeof key !== 'string' || !/^[\w-]{16,100}$/.test(key)) throw new Error('缺少有效的提交标识，请刷新页面');
  const old = batchStore.existing(req.userId!, key);
  if (old) return res.json(batchStore.detail(old.id, req.userId!));
  const input = validateBatchInput(req.body);
  const quote = await preflight(req, input);
  if (req.body.expectedUnitCost !== quote.unitCost) throw new Error('价格已变化，请重新预估并确认费用');
  const active = sqlite.prepare("SELECT count(*) AS n FROM video_batch_items WHERE user_id=? AND billing_state='reserved'").get(req.userId!) as any;
  if (active.n + quote.total > 200) throw new Error('您尚有较多未完成任务，请等待现有批次完成（最多 200 条）');
  // Store each creative's assets once instead of duplicating base64 for 100 tasks.
  input.creatives = input.creatives.map(c => ({ ...c, ...materializeContentMetadataAssets(c, { publicBaseUrl: originFor(req) }).metadata }));
  const id = batchStore.create(req.userId!, key, input, quote.unitCost, originFor(req));
  res.json(batchStore.detail(id, req.userId!));
  tickVideoBatches();
}));
router.get('/', handle((req, res) => {
  res.json(sqlite.prepare(`SELECT id,name,model,total,created_at FROM video_batches WHERE user_id=? ORDER BY id DESC LIMIT 100`).all(req.userId!));
}));
router.get('/:id', handle((req, res) => { res.json(batchStore.detail(Number(req.params.id), req.userId!)); }));
router.post('/:id/cancel-pending', handle((req, res) => {
  batchStore.cancelPending(Number(req.params.id), req.userId!);
  res.json(batchStore.detail(Number(req.params.id), req.userId!));
}));
router.post('/:id/stop-retries', handle((req, res) => {
  batchStore.stopRetries(Number(req.params.id), req.userId!);
  res.json(batchStore.detail(Number(req.params.id), req.userId!));
}));
router.post('/:id/retry-failed', tierMiddleware('video'), quotaMiddleware, handle((req, res) => {
  const key = req.body?.requestKey;
  if (typeof key !== 'string' || !/^[\w-]{16,100}$/.test(key)) throw new Error('缺少有效操作标识');
  batchStore.retryFailed(Number(req.params.id), req.userId!, key);
  res.json(batchStore.detail(Number(req.params.id), req.userId!));
  tickVideoBatches();
}));
router.post('/:id/download', handle((req, res) => {
  const detail = batchStore.detail(Number(req.params.id), req.userId!);
  const completed = detail.items.filter(i => i.status === 'completed' && i.result_url);
  if (!completed.length) throw new Error('暂无已成功的视频');
  let totalBytes = 0;
  const files = completed.map(i => {
    let file: string;
    try { file = resolveBatchArchiveFile(i.result_url, path.resolve('data/uploads')); }
    catch { throw new Error(`视频 #${i.content_id} 缓存已过期或尚未本地保存，请先在资产管理中心恢复后下载`); }
    totalBytes += fs.statSync(file).size;
    return { path: file, name: `creative-${i.creative_index + 1}-video-${i.ordinal}${path.extname(file)}` };
  });
  if (totalBytes > 3 * 1024 ** 3) throw new Error('视频合计超过 3 GB，请分批单独下载');
  for (const [key, value] of downloadTickets) if (value.expires < Date.now() || value.userId === req.userId) downloadTickets.delete(key);
  const key = randomBytes(32).toString('hex');
  downloadTickets.set(key, { expires: Date.now() + 60000, userId: req.userId!, batchId: detail.id, files });
  res.json({ url: `/api/video-batches/download/${key}` });
}));
export default router;
