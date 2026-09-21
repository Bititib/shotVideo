import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { tierMiddleware, TierRequest } from '../middleware/tier.js';
import { quotaMiddleware, logUsage } from '../middleware/quota.js';
import { PricingService } from '../services/pricingService.js';
import { ChannelService } from '../services/channelService.js';
import { BalanceService } from '../services/balanceService.js';
import { ContentService } from '../services/contentService.js';
import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { contents, models } from '../db/schema.js';
import { eq, like, and } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import {
  generateSiYueTianImage,
  isSiYueTianImageChannel,
  isSiYueTianImageModel,
  SI_YUE_TIAN_IMAGE_CONTENT_BASE_URL,
} from '../services/siYueTianImageAdapter.js';

const router = Router();

/**
 * 将 base64 数据转换并存储为本地静态文件，返回可外网访问的公网 URL
 */
function convertBase64ToPublicUrl(dataUrl: string, prefix: string, req: Request): string {
  if (!dataUrl) return '';
  if (dataUrl.startsWith('http://') || dataUrl.startsWith('https://')) {
    return dataUrl;
  }

  try {
    const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) return dataUrl;

    const mimeType = matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, 'base64');

    // 获取后缀名
    let ext = mimeType.split('/')[1] || 'jpg';
    if (mimeType === 'audio/mpeg') {
      ext = 'mp3';
    } else if (mimeType.includes('wav')) {
      ext = 'wav';
    }
    const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
    const destPath = path.join(process.cwd(), 'data/uploads', filename);

    // 确保 uploads 目录存在
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(destPath, buffer);

    // 优先使用环境变量配置的公网基准 URL
    const baseUrl = process.env.BACKEND_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
    return `${baseUrl.replace(/\/+$/, '')}/uploads/${filename}`;
  } catch (err: any) {
    console.error('[imageGen] convertBase64ToPublicUrl 失败:', err.message);
    return dataUrl;
  }
}

const RATIO_TO_SIZE: Record<string, string> = {
  '16:9': '1280x720',
  '9:16': '720x1280',
  '1:1': '1024x1024',
  '4:3': '1024x768',
  '3:4': '768x1024',
  '3:2': '1080x720',
  '2:3': '720x1080',
  '21:9': '1680x720',
};

const DEFAULT_IMAGE_MODELS = [
  { id: 'gpt-image-2', name: 'gpt-image-2', description: 'OpenAI GPT Image 2 文生图/图生图（异步）', icon: '🤖' },
  { id: 'gpt-image-2.5-flare', name: 'gpt-image-2.5-flare', description: 'OpenAI GPT Image 2.5 Flare 快速通用图像（异步）', icon: '🤖' },
  { id: 'gpt-image-2.5-sunburst', name: 'gpt-image-2.5-sunburst', description: 'OpenAI GPT Image 2.5 Sunburst 高质量图像（异步）', icon: '🤖' },
  { id: 'nano-banana-2', name: 'nano-banana-2', description: 'Google Gemini 3.1 Flash 图像（异步）', icon: '🍌' },
  { id: 'nano-banana-2-lite', name: 'nano-banana-2-lite', description: 'Google Gemini 3.1 Flash Lite 轻量图像（异步）', icon: '🍌' },
  { id: 'nano-banana-pro', name: 'nano-banana-pro', description: 'Google Gemini 3 Pro 高级图像（异步）', icon: '🍌' },
  { id: 'gemini-3.1-flash-image-preview', name: '🍌 nabanana flash', description: '2k高清画质，极速生成', icon: '☄️' },
  { id: 'gemini-3-pro-image-preview', name: '🍌 nabanana pro', description: '2k高清画质，极致细节', icon: '🪐' },
];

export function storedImageUrls(record: { resultUrl?: string | null; metadata?: unknown }): string[] {
  const urls = new Set<string>();
  if (record.resultUrl) urls.add(String(record.resultUrl));
  let metadata: Record<string, any> = {};
  try {
    metadata = typeof record.metadata === 'string'
      ? JSON.parse(record.metadata || '{}')
      : ((record.metadata && typeof record.metadata === 'object') ? record.metadata as Record<string, any> : {});
  } catch { /* ignore malformed legacy metadata */ }
  if (Array.isArray(metadata.imageUrls)) {
    metadata.imageUrls.filter((url: unknown) => typeof url === 'string' && url).forEach((url: string) => urls.add(url));
  }
  if (typeof metadata.imageUrl === 'string' && metadata.imageUrl) urls.add(metadata.imageUrl);
  return [...urls];
}

function publicBaseUrl(req: Request): string {
  return (process.env.BACKEND_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`)
    .replace(/\/+$/, '');
}

function imageExtension(contentType: string, sourceUrl: string): string {
  const normalized = contentType.toLowerCase().split(';')[0].trim();
  const byMime: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
  };
  if (byMime[normalized]) return byMime[normalized];
  try {
    const ext = path.extname(new URL(sourceUrl).pathname).slice(1).toLowerCase();
    if (/^(png|jpe?g|webp|gif|avif)$/.test(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  } catch { /* data URLs and relative URLs may not parse */ }
  return 'png';
}

function detectedImageExtension(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'gif';
  if (buffer.length >= 12 && ['avif', 'avis'].includes(buffer.subarray(8, 12).toString('ascii'))) return 'avif';
  return null;
}

export async function localizeGeneratedImage(
  sourceUrl: string,
  prefix: string,
  req: Request,
  channel?: { baseUrl?: string; apiKey?: string },
  options?: { relative?: boolean },
): Promise<string> {
  if (!sourceUrl) throw new Error('上游未返回图片 URL');
  const siteBase = publicBaseUrl(req);
  if (sourceUrl.startsWith('data:')) {
    const publicUrl = convertBase64ToPublicUrl(sourceUrl, prefix, req);
    return options?.relative ? new URL(publicUrl).pathname.replace(/^\/uploads\//, '/api/uploads/') : publicUrl;
  }
  if (sourceUrl.startsWith('/api/uploads/')) {
    return options?.relative ? sourceUrl : `${siteBase}${sourceUrl.replace(/^\/api/, '')}`;
  }
  if (sourceUrl.startsWith('/uploads/')) {
    return options?.relative ? sourceUrl.replace(/^\/uploads\//, '/api/uploads/') : `${siteBase}${sourceUrl}`;
  }
  try {
    const existing = new URL(sourceUrl);
    if ((existing.pathname.startsWith('/uploads/') || existing.pathname.startsWith('/api/uploads/'))
      && existing.origin === new URL(siteBase).origin) {
      const pathname = existing.pathname.replace(/^\/api\/uploads\//, '/uploads/');
      return options?.relative ? pathname.replace(/^\/uploads\//, '/api/uploads/') : `${siteBase}${pathname}`;
    }
  } catch { /* resolve relative upstream URLs below */ }

  const absoluteSource = new URL(sourceUrl, channel?.baseUrl || siteBase);
  if (!['http:', 'https:'].includes(absoluteSource.protocol)) throw new Error('不支持的图片 URL 协议');
  const headers: Record<string, string> = {};
  if (channel?.apiKey && channel.baseUrl) {
    try {
      const channelOrigin = new URL(channel.baseUrl).origin;
      const authorizedOrigins = new Set([channelOrigin]);
      if (isSiYueTianImageChannel(channel)) {
        authorizedOrigins.add(new URL(SI_YUE_TIAN_IMAGE_CONTENT_BASE_URL).origin);
      }
      if (authorizedOrigins.has(absoluteSource.origin)) {
        headers.Authorization = `Bearer ${channel.apiKey}`;
      }
    } catch { /* signed CDN URLs generally require no channel header */ }
  }

  const response = await fetch(absoluteSource, {
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`下载上游图片失败 (HTTP ${response.status})`);
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error('上游图片内容为空');
  const detectedExtension = detectedImageExtension(buffer);
  if (!detectedExtension) {
    const preview = buffer.subarray(0, 80).toString('utf8').replace(/\s+/g, ' ').trim();
    throw new Error(`上游返回的不是有效图片 (Content-Type: ${contentType}${preview ? `, 内容: ${preview.slice(0, 60)}` : ''})`);
  }

  const ext = detectedExtension || imageExtension(contentType, absoluteSource.toString());
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `${safePrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const uploadDir = path.join(process.cwd(), 'data/uploads');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  await fs.promises.writeFile(path.join(uploadDir, filename), buffer);
  const localUrl = `/uploads/${filename}`;
  return options?.relative ? localUrl.replace(/^\/uploads\//, '/api/uploads/') : `${siteBase}${localUrl}`;
}

/** Authenticated download proxy so cross-origin image URLs are saved instead of opened. */
router.get('/download', authMiddleware, async (req: TierRequest, res: Response) => {
  const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  if (!rawUrl) return res.status(400).json({ error: 'Missing url parameter' });

  const ownedRecords = db.select({
    resultUrl: contents.resultUrl,
    metadata: contents.metadata,
    modelId: contents.modelId,
  }).from(contents).where(and(
    eq(contents.userId, req.userId!),
    eq(contents.type, 'image'),
  )).all();
  const ownedRecord = ownedRecords.find(record => storedImageUrls(record).includes(rawUrl));
  if (!ownedRecord) return res.status(403).json({ error: 'Image does not belong to the current user' });

  try {
    const requestUrl = new URL(rawUrl, `${req.protocol}://${req.get('host')}`);
    if (!['http:', 'https:'].includes(requestUrl.protocol)) {
      return res.status(400).json({ error: 'Unsupported image URL protocol' });
    }

    const headers: Record<string, string> = {};
    const channel = ownedRecord.modelId ? ChannelService.findChannelForModel(ownedRecord.modelId) : null;
    if (channel?.apiKey) {
      try {
        if (new URL(channel.baseUrl).origin === requestUrl.origin) {
          headers.Authorization = `Bearer ${channel.apiKey}`;
        }
      } catch { /* public signed URLs do not require the channel key */ }
    }

    const upstream = await fetch(requestUrl, {
      headers,
      signal: AbortSignal.timeout(60_000),
    });
    if (!upstream.ok) throw new Error(`Image source returned HTTP ${upstream.status}`);

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const requestedName = typeof req.query.filename === 'string' ? req.query.filename : 'generated-image.png';
    const filename = path.basename(requestedName).replace(/[^\w.\-\u4e00-\u9fff]/g, '_') || 'generated-image.png';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="generated-image"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const reader = upstream.body?.getReader();
    if (!reader) throw new Error('Image source returned an empty body');
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      reader.releaseLock();
    }
    return res.end();
  } catch (error: any) {
    console.error('[imageGen/download] failed:', error.message);
    if (!res.headersSent) return res.status(502).json({ error: `Image download failed: ${error.message}` });
    return res.end();
  }
});

/** 查找支持指定图片模型的渠道 */
function findImageChannel(modelId: string) {
  // HM Studio currently exposes video generation only. Never select an HM
  // channel for an image model even if an administrator accidentally adds an
  // overlapping model id to its supported-model list.
  const candidates = ChannelService.findChannelsForModel(modelId)
    .filter(candidate => candidate.type !== 'hmstudio');
  const channel = (isSiYueTianImageModel(modelId)
    ? candidates.find(candidate => isSiYueTianImageChannel(candidate, modelId))
    : null) || candidates[0];
  if (channel) return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    baseUrl: channel.baseUrl,
    apiKey: channel.apiKey,
    timeout: channel.timeout,
    modelMapping: channel.modelMapping,
  };
  return null;
}

/** GET /api/image-gen/models — 可用的图片模型列表（公开，不需要登录） */
router.get('/models', (_req: Request, res: Response) => {
  // 从数据库动态拉取所有启用且具备 'image' 能力的模型
  const dbModels = db.select().from(models)
    .where(and(eq(models.isActive, 1), like(models.capabilities, '%"image"%')))
    .all();

  // 获取所有在数据库中被禁用的模型 ID，用作后备过滤
  const disabledModelIds = new Set<string>();
  try {
    const inactive = db.select().from(models).where(eq(models.isActive, 0)).all();
    inactive.forEach(m => disabledModelIds.add(m.modelId));
  } catch {}

  // 如果数据库里还没配置，提供一个过滤了禁用模型的默认后备
  const sourceModels = dbModels.length > 0
    ? dbModels.map(m => ({ id: m.modelId, name: m.displayName }))
    : DEFAULT_IMAGE_MODELS.filter(m => !disabledModelIds.has(m.id));

  const result = sourceModels.map(m => {
    const preset = DEFAULT_IMAGE_MODELS.find(d => d.id === m.id);
    const rate = PricingService.calculateCost(m.id, 0, 0);
    return {
      id: m.id,
      name: m.name || preset?.name || m.id,
      description: preset?.description || 'AI 图片生成服务',
      available: findImageChannel(m.id) !== null,
      rate,
    };
  });

  res.json(result);
});

/** POST /api/image-gen/generate — 图片生成（支持多图 + 参考图） */
router.post('/generate', authMiddleware, tierMiddleware('generate_image'), quotaMiddleware, async (req: TierRequest, res: Response) => {
  const {
    prompt,
    model = 'gpt-image-2',
    aspect_ratio = '1:1',
    resolution = '2K',
    n = 1,                       // 生成数量 1~4
    reference_images = [],       // base64 数据 URL 数组
    quality,
    output_format,
    background,
    output_compression,
  } = req.body;

  if (!prompt?.trim()) {
    return res.status(400).json({ error: '请输入图片描述' });
  }

  const count = Math.max(1, Math.min(4, Number(n) || 1));

  const channel = findImageChannel(model);
  if (!channel) {
    return res.status(503).json({ error: '未配置图片生成渠道。请在管理后台添加渠道。' });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (data: Record<string, any>) => {
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const finishStream = () => {
    if (res.writableEnded || res.destroyed) return;
    res.write('data: [DONE]\n\n');
    res.end();
  };

  const size = RATIO_TO_SIZE[aspect_ratio] || '1024x1024';
  const baseUrl = channel.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (channel.apiKey) headers['Authorization'] = `Bearer ${channel.apiKey}`;

  // 判断是否有参考图
  const hasRef = Array.isArray(reference_images) && reference_images.length > 0;

  const startTime = Date.now();

  // 预估费用并检查余额
  const unitCostEst = PricingService.calculateCost(model, 0, 0);
  const estimatedCost = Math.round(unitCostEst * count * 100) / 100;
  const { sufficient, balance: currentBalance } = BalanceService.checkBalance(req.userId!, estimatedCost);
  if (!sufficient) {
    sendEvent({ type: 'error', message: `余额不足，预估费用 ¥${estimatedCost.toFixed(2)}，当前余额 ¥${currentBalance.toFixed(2)}` });
    finishStream();
    return;
  }

  const persistedMetadata: Record<string, any> = {
    aspect_ratio,
    aspectRatio: aspect_ratio,
    resolution,
    count,
    imageUrls: [],
    progresses: new Array(count).fill(0),
    channelId: channel.id,
    channelName: channel.name,
    actualChannel: isSiYueTianImageChannel(channel, model) ? 'siyuetian' : channel.type,
    upstreamModel: channel.modelMapping?.[model] || model,
    upstreamTaskId: '',
    taskId: '',
    upstreamTaskIds: [],
    progressText: '图片任务已提交，正在生成',
  };
  const contentId = ContentService.save({
    userId: req.userId!,
    orgId: req.orgId || null,
    type: 'image',
    title: (prompt as string).slice(0, 200),
    inputText: (prompt as string).slice(0, 500),
    modelId: model,
    metadata: persistedMetadata,
    status: 'processing',
  });
  sendEvent({ type: 'status', message: '图片任务已提交，正在后台生成...', contentId, total: count });

  const persistJob = (patch: Record<string, any>, status = 'processing') => {
    Object.assign(persistedMetadata, patch);
    db.update(contents).set({
      status,
      metadata: JSON.stringify(persistedMetadata),
    }).where(eq(contents.id, contentId)).run();
  };
  const persistFailure = (message: string) => persistJob({
    progressText: message,
    failureReason: message,
    failedAt: new Date().toISOString(),
  }, 'failed');

  /** 生成完成后统一计费 + 保存内容 */
  const billUsage = (actualCount: number, imageUrls?: string[], extraMetadata: Record<string, any> = {}) => {
    const duration = Date.now() - startTime;
    for (let i = 0; i < actualCount; i++) {
      logUsage(req.userId!, 'generate_image', undefined, duration);
    }
    const unitCost = PricingService.calculateCost(model, 0, 0);
    const totalCost = Math.round(unitCost * actualCount * 100) / 100;
    if (totalCost > 0) {
      const remaining = BalanceService.deduct(req.userId!, totalCost, 'generate_image');
      sendEvent({ type: 'billing', cost: totalCost, count: actualCount, unitCost, remainingBalance: remaining ?? 0 });
    }
    // 完成持久化任务；即使浏览器刷新，结果也会保留在内容库。
    try {
      Object.assign(persistedMetadata, {
        imageUrls: imageUrls || [],
        progresses: new Array(count).fill(actualCount > 0 ? 100 : 0),
        progressText: actualCount > 0 ? '图片生成完成' : '图片生成失败',
        ...extraMetadata,
      });
      db.update(contents).set({
        resultUrl: imageUrls?.[0] || undefined,
        cost: totalCost,
        metadata: JSON.stringify(persistedMetadata),
        status: actualCount > 0 ? 'completed' : 'failed',
      }).where(eq(contents.id, contentId)).run();
    } catch (e) { console.error('[content] 图片保存失败:', e); }
  };

  try {
    if (isSiYueTianImageChannel(channel, model)) {
      const referenceUrls = hasRef
        ? reference_images.slice(0, 9).map((image: string, index: number) => convertBase64ToPublicUrl(image, `image_ref_${index}`, req))
        : [];
      const completedImages: string[] = new Array(count).fill('');
      const upstreamTaskIds: string[] = new Array(count).fill('');
      sendEvent({
        type: 'status',
        message: hasRef ? '正在提交参考图并等待四月天生成...' : `正在提交 ${count} 个四月天图片任务...`,
        total: count,
      });

      await Promise.all(Array.from({ length: count }, async (_, index) => {
        try {
          const result = await generateSiYueTianImage({
            baseUrl,
            apiKey: channel.apiKey,
            model,
            prompt: prompt.trim(),
            aspectRatio: aspect_ratio,
            resolution,
            referenceImages: referenceUrls,
            quality,
            maxAttempts: 3,
            onSubmitted: (taskId) => {
              upstreamTaskIds[index] = taskId;
              persistJob({
                upstreamTaskId: upstreamTaskIds.find(Boolean) || '',
                taskId: upstreamTaskIds.find(Boolean) || '',
                upstreamTaskIds: upstreamTaskIds.filter(Boolean),
                progressText: '四月天图片任务生成中',
              });
            },
            onProgress: (progress, status) => {
              const progresses = [...persistedMetadata.progresses];
              progresses[index] = progress;
              persistJob({ progresses, progressText: `图片生成中 ${Math.max(...progresses)}%` });
              sendEvent({ type: 'progress', progress, status, index, total: count, contentId });
            },
            onRetry: (attempt, maxAttempts, delayMs, message) => {
              const retryMessage = maxAttempts > 0
                ? `上游繁忙，${Math.ceil(delayMs / 1000)} 秒后自动重试（${attempt}/${maxAttempts}）`
                : `上游查询暂时繁忙，${Math.ceil(delayMs / 1000)} 秒后继续查询`;
              persistJob({ progressText: retryMessage, lastRetryReason: message });
              sendEvent({ type: 'status', message: retryMessage, index, total: count, contentId });
            },
          });
          const localizedUrl = await localizeGeneratedImage(result.imageUrl, `siyuetian_image_${index}`, req, channel, { relative: true });
          completedImages[index] = localizedUrl;
          upstreamTaskIds[index] = result.taskId;
          const progresses = [...persistedMetadata.progresses];
          progresses[index] = 100;
          persistJob({
            imageUrls: [...completedImages],
            progresses,
            upstreamTaskId: upstreamTaskIds.find(Boolean) || '',
            taskId: upstreamTaskIds.find(Boolean) || '',
            upstreamTaskIds: upstreamTaskIds.filter(Boolean),
          });
          sendEvent({ type: 'image_ready', imageUrl: localizedUrl, index, total: count });
        } catch (error: any) {
          const message = error?.name === 'AbortError' ? '生成超时或已取消' : (error?.message || '生成失败');
          console.error(`[imageGen/siyuetian] #${index} 失败:`, message);
          const failedIndexes = Array.isArray(persistedMetadata.failedIndexes)
            ? [...persistedMetadata.failedIndexes]
            : [];
          if (!failedIndexes.includes(index)) failedIndexes.push(index);
          persistJob({ failedIndexes, progressText: message });
          sendEvent({ type: 'image_error', index, message: `图片 #${index + 1}: ${message}` });
        }
      }));

      const imageUrls = completedImages.filter(Boolean);
      const taskIds = upstreamTaskIds.filter(Boolean);
      sendEvent({ type: 'complete', imageUrls, total: count });
      billUsage(imageUrls.length, imageUrls, {
        upstreamTaskId: taskIds[0] || '',
        taskId: taskIds[0] || '',
        upstreamTaskIds: taskIds,
      });
      finishStream();
      return;
    }

    const isEditModel = model === 'gpt-image-2';
    let editModel = model;
    if (hasRef && !isEditModel) {
      editModel = 'gpt-image-2';
      sendEvent({ type: 'status', message: `检测到参考图，已自动切换为 GPT Image 2 模式生成...`, total: count });
    } else {
      sendEvent({ type: 'status', message: hasRef ? '正在上传参考图并生成...' : `正在生成 ${count} 张图片...`, total: count });
    }

    if (hasRef) {
      // ===== 有参考图：走 POST /v1/images/edits (multipart/form-data) =====
      const upstreamUrl = baseUrl + '/v1/images/edits';
      const completedImages: string[] = new Array(count).fill('');
      let completedCount = 0;

      // 将 base64 data URI 转为 Blob
      const refBlobs: Blob[] = [];
      for (const refImg of reference_images.slice(0, 5)) {
        try {
          if (typeof refImg === 'string' && refImg.startsWith('data:')) {
            const [meta, b64] = refImg.split(',');
            const mime = meta.match(/data:([^;]+)/)?.[1] || 'image/png';
            const buf = Buffer.from(b64, 'base64');
            refBlobs.push(new Blob([buf], { type: mime }));
          } else if (typeof refImg === 'string' && refImg.startsWith('http')) {
            // URL 类型：下载后转 Blob
            const dl = await fetch(refImg);
            if (dl.ok) refBlobs.push(await dl.blob());
          }
        } catch (e) {
          console.error('[imageGen/edit] 参考图处理失败:', e);
        }
      }

      if (refBlobs.length === 0) {
        sendEvent({ type: 'error', message: '参考图解析失败，请重新上传' });
        persistFailure('参考图解析失败，请重新上传');
        finishStream();
        return;
      }

      console.log(`[imageGen/edit] 参考图 ${refBlobs.length} 张, 并发 ${count} 个请求, model=${editModel}`);

      const runSingle = async (index: number) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 180_000);

        try {
          // 发送生成中进度
          sendEvent({ type: 'progress', progress: 10, index });

          const formData = new FormData();
          formData.append('model', editModel);
          formData.append('prompt', prompt.trim());
          formData.append('n', '1');
          formData.append('size', size);
          formData.append('response_format', 'url');
          if (quality) formData.append('quality', quality);
          if (output_format) formData.append('output_format', output_format);
          // 添加所有参考图
          for (let ri = 0; ri < refBlobs.length; ri++) {
            formData.append('image[]', refBlobs[ri], `ref_${ri}.png`);
          }

          sendEvent({ type: 'progress', progress: 30, index });

          const upstream = await fetch(upstreamUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${channel.apiKey}` },
            body: formData,
            signal: controller.signal,
          });
          clearTimeout(timer);

          sendEvent({ type: 'progress', progress: 70, index });

          if (!upstream.ok) {
            const errText = await upstream.text().catch(() => '');
            console.error(`[imageGen/edit] #${index} 上游返回 ${upstream.status}: ${errText.slice(0, 200)}`);
            sendEvent({ type: 'image_error', index, message: `请求 #${index + 1} 失败 (${upstream.status})` });
            return;
          }

          const result = await upstream.json() as any;
          const imageUrl = result?.data?.[0]?.url || '';
          console.log(`[imageGen/edit] #${index} 完成, url=${imageUrl ? '有' : '无'}`);

          sendEvent({ type: 'progress', progress: 100, index });

          if (imageUrl) {
            const localizedUrl = await localizeGeneratedImage(imageUrl, `edited_image_${index}`, req, channel, { relative: true });
            completedImages[index] = localizedUrl;
            sendEvent({ type: 'image_ready', imageUrl: localizedUrl, index, total: count });
          } else {
            sendEvent({ type: 'image_error', index, message: `图片 #${index + 1} 未返回结果` });
          }
        } catch (err: any) {
          clearTimeout(timer);
          const msg = err.name === 'AbortError' ? '超时' : (err.message || '请求失败');
          console.error(`[imageGen/edit] #${index} 异常:`, msg);
          sendEvent({ type: 'image_error', index, message: `图片 #${index + 1}: ${msg}` });
        } finally {
          completedCount++;
          if (completedCount === count) {
            const allUrls = completedImages.filter(Boolean);
            sendEvent({ type: 'complete', imageUrls: allUrls, total: count });
            billUsage(allUrls.length, allUrls);
            finishStream();
          }
        }
      };

      // 并发启动
      for (let i = 0; i < count; i++) {
        runSingle(i);
      }
    } else {
      const isGptImageModel = model.startsWith('gpt-image');
      if (isGptImageModel) {
        // ===== GPT Image 2 无参考图：并发 n 个独立的 v1/images/generations 请求 =====
        const upstreamUrl = baseUrl + '/v1/images/generations';
        const completedImages: string[] = new Array(count).fill('');
        let completedCount = 0;

        const runSingle = async (index: number) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 120_000);

          const requestBody: Record<string, any> = {
            model,
            prompt,
            n: 1,
            size,
            response_format: 'url',
          };
          if (quality) requestBody.quality = quality;
          if (output_format) requestBody.output_format = output_format;
          if (background) requestBody.background = background;
          if (typeof output_compression === 'number') {
            requestBody.output_compression = output_compression;
          }

          try {
            sendEvent({ type: 'progress', progress: 15, index });

            const upstream = await fetch(upstreamUrl, {
              method: 'POST',
              headers,
              body: JSON.stringify(requestBody),
              signal: controller.signal,
            });
            clearTimeout(timer);

            sendEvent({ type: 'progress', progress: 60, index });

            if (!upstream.ok) {
              const errText = await upstream.text().catch(() => '');
              console.error(`[imageGen/gpt] #${index} 上游返回 ${upstream.status}: ${errText.slice(0, 200)}`);
              sendEvent({ type: 'image_error', index, message: `请求 #${index + 1} 失败 (${upstream.status})` });
              return;
            }

            const result = await upstream.json() as any;
            let imageUrl = result?.data?.[0]?.url || '';

            // 兼容 b64_json 返回格式
            if (!imageUrl && result?.data?.[0]?.b64_json) {
              const b64 = result.data[0].b64_json;
              const mime = 'image/png';
              imageUrl = `data:${mime};base64,${b64}`;
            }

            sendEvent({ type: 'progress', progress: 100, index });

             if (imageUrl) {
               const localizedUrl = await localizeGeneratedImage(imageUrl, `gpt_image_${index}`, req, channel, { relative: true });
               completedImages[index] = localizedUrl;
               sendEvent({ type: 'image_ready', imageUrl: localizedUrl, index, total: count });
            } else {
              sendEvent({ type: 'image_error', index, message: `图片 #${index + 1} 未返回结果` });
            }
          } catch (err: any) {
            clearTimeout(timer);
            const msg = err.name === 'AbortError' ? '超时' : (err.message || '请求失败');
            console.error(`[imageGen/gpt] #${index} 异常:`, msg);
            sendEvent({ type: 'image_error', index, message: `图片 #${index + 1}: ${msg}` });
          } finally {
            completedCount++;
            if (completedCount === count) {
              const allUrls = completedImages.filter(Boolean);
              sendEvent({ type: 'complete', imageUrls: allUrls, total: count });
              billUsage(allUrls.length, allUrls);
              finishStream();
            }
          }
        };

        for (let i = 0; i < count; i++) {
          runSingle(i);
        }
      } else {
        // ===== 无参考图：并发 n 个独立的 chat/completions SSE 请求 =====
        const upstreamUrl = baseUrl + '/v1/chat/completions';
        const completedImages: string[] = new Array(count).fill('');
        let completedCount = 0;

        const runSingle = async (index: number) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 120_000);

          const requestBody: Record<string, any> = {
            model,
            messages: [{ role: 'user', content: prompt }],
            stream: true,
            image_config: { n: 1, size, response_format: 'url' },
          };
          if (quality) requestBody.image_config.quality = quality;
          if (output_format) requestBody.image_config.output_format = output_format;
          if (background) requestBody.image_config.background = background;
          if (typeof output_compression === 'number') {
            requestBody.image_config.output_compression = output_compression;
          }

          try {
            const upstream = await fetch(upstreamUrl, {
              method: 'POST',
              headers,
              body: JSON.stringify(requestBody),
              signal: controller.signal,
            });
            clearTimeout(timer);

            if (!upstream.ok) {
              sendEvent({ type: 'image_error', index, message: `请求 #${index + 1} 失败 (${upstream.status})` });
              return;
            }

            const reader = upstream.body?.getReader();
            if (!reader) return;

            const decoder = new TextDecoder();
            let buffer = '';
            let imageUrl = '';
            let lastProgress = -1;

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;

                try {
                  const data = JSON.parse(line.slice(6));
                  const delta = data.choices?.[0]?.delta || {};
                  const msg = data.choices?.[0]?.message || {};

                  // 提取进度
                  const reasoning = delta.reasoning_content || '';
                  if (reasoning) {
                    const m = reasoning.match(/(\d+)%/);
                    if (m) {
                      const p = parseInt(m[1]);
                      if (p !== lastProgress) {
                        lastProgress = p;
                        sendEvent({ type: 'progress', progress: p, index });
                      }
                    }
                  }

                  // 提取图片 URL
                  const content = delta.content || msg.content || '';
                  if (content) {
                    const urlMatch = content.match(/https?:\/\/[^\s"'<>]+/);
                    if (urlMatch) imageUrl = urlMatch[0];
                    const srcMatch = content.match(/src="([^"]+)"/);
                    if (srcMatch) imageUrl = srcMatch[1];
                    const localMatch = content.match(/(\/v1\/files\/image[^\s"'<>]*)/);
                    if (localMatch) imageUrl = baseUrl + localMatch[1];
                    const mdMatch = content.match(/!\[[^\]]*\]\(([^)]+)\)/);
                    if (mdMatch) {
                      imageUrl = mdMatch[1];
                      if (imageUrl.startsWith('/')) imageUrl = baseUrl + imageUrl;
                    }
                  }
                } catch { /* ignore parse errors */ }
              }
            }

            // 流结束但未通过 [DONE] 发送的情况
            if (imageUrl) {
              const localizedUrl = await localizeGeneratedImage(imageUrl, `stream_image_${index}`, req, channel, { relative: true });
              completedImages[index] = localizedUrl;
              sendEvent({ type: 'image_ready', imageUrl: localizedUrl, index, total: count });
            } else {
              sendEvent({ type: 'image_error', index, message: `图片 #${index + 1} 未返回结果` });
            }
          } catch (err: any) {
            clearTimeout(timer);
            const msg = err.name === 'AbortError' ? '超时' : (err.message || '请求失败');
            sendEvent({ type: 'image_error', index, message: `图片 #${index + 1}: ${msg}` });
          } finally {
            completedCount++;
            // 所有任务完成后发送 complete
            if (completedCount === count) {
              const allUrls = completedImages.filter(Boolean);
              sendEvent({ type: 'complete', imageUrls: allUrls, total: count });
              billUsage(allUrls.length, allUrls);
              finishStream();
            }
          }
        };

        // 并发启动所有请求
        for (let i = 0; i < count; i++) {
          runSingle(i);
        }
      }
    }
  } catch (err: any) {
    const msg = err.name === 'AbortError' ? '图片生成超时' : (err.message || '请求失败');
    persistFailure(msg);
    sendEvent({ type: 'error', message: msg });
    finishStream();
  }
});

export default router;
