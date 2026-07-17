import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { tierMiddleware, TierRequest } from '../middleware/tier.js';
import { quotaMiddleware, logUsage } from '../middleware/quota.js';
import { ChannelService } from '../services/channelService.js';
import { BalanceService } from '../services/balanceService.js';
import { ContentService } from '../services/contentService.js';
import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { models, settings, contents } from '../db/schema.js';
import { eq, like, and } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
const router = Router();

export const activePolls = new Set<number>();

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

    fs.writeFileSync(destPath, buffer);

    // 优先使用环境变量配置的公网基准 URL
    const baseUrl = process.env.BACKEND_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
    return `${baseUrl.replace(/\/+$/, '')}/uploads/${filename}`;
  } catch (err: any) {
    console.error('[video] convertBase64ToPublicUrl 失败:', err.message);
    return dataUrl;
  }
}

/**
 * 将 base64 数据上传到 SudaShuiAPI 文件服务
 */
async function uploadToSudaShui(dataUrl: string, apiKey: string): Promise<string> {
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

    let ext = mimeType.split('/')[1] || 'jpg';
    if (mimeType === 'audio/mpeg') ext = 'mp3';
    else if (mimeType.includes('wav')) ext = 'wav';

    const formData = new FormData();
    const blob = new Blob([buffer], { type: mimeType });
    formData.append('file', blob, `file_${Date.now()}.${ext}`);

    const resp = await fetch('https://files.sudashuiapi.com', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      body: formData,
      signal: AbortSignal.timeout(60000)
    });

    if (!resp.ok) {
      const errTxt = await resp.text().catch(() => '');
      throw new Error(`SudaShui upload failed: ${resp.status} ${errTxt}`);
    }

    const data = await resp.json() as any;
    return data.url;
  } catch (err: any) {
    console.error('[video] uploadToSudaShui 失败:', err.message);
    throw err;
  }
}

/** 上传素材到 Pidoi（Sora V3 Pro）文件存储 */
async function uploadToPidoi(dataUrl: string, apiKey: string, baseUrl?: string): Promise<string> {
  if (!dataUrl) return '';
  if (dataUrl.startsWith('http://') || dataUrl.startsWith('https://')) {
    return dataUrl;
  }
  try {
    const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) throw new Error('Invalid data URL format');
    const mimeType = matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, 'base64');

    let ext = mimeType.split('/')[1] || 'jpg';
    if (mimeType === 'audio/mpeg') ext = 'mp3';
    else if (mimeType.includes('wav')) ext = 'wav';
    else if (mimeType.includes('mp4')) ext = 'mp4';

    const formData = new FormData();
    const blob = new Blob([buffer], { type: mimeType });
    formData.append('file', blob, `file_${Date.now()}.${ext}`);

    const uploadBase = baseUrl ? baseUrl.replace(/\/v1\/?$/, '') : 'https://pidoi.com';
    const resp = await fetch(`${uploadBase}/seedance-assets/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      body: formData,
      signal: AbortSignal.timeout(60000)
    });

    if (!resp.ok) {
      const errTxt = await resp.text().catch(() => '');
      throw new Error(`Pidoi upload failed: ${resp.status} ${errTxt}`);
    }

    // 防御性检查：网关可能以 200 返回 HTML 页面（鉴权失败等情况）
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      const htmlSnippet = await resp.text().catch(() => '');
      throw new Error(`Pidoi upload 返回了 HTML 而非 JSON（可能是鉴权失败或地址错误）: ${htmlSnippet.slice(0, 200)}`);
    }

    const data = await resp.json() as any;
    return data.url || data.assetUrl;
  } catch (err: any) {
    console.error('[video] uploadToPidoi 失败:', err.message);
    throw err;
  }
}

/** 模型系列信息：计费、时长限制、是否强制参考图 */
interface ModelMeta {
  series: string;
  allowedSeconds: number[] | null;   // null = 不限制
  requireRef: boolean;               // 是否必须传参考图
}
const MODEL_META: Record<string, ModelMeta> = {
  'grok-imagine-video-1.5-preview': { series: '1.5', allowedSeconds: [6, 10], requireRef: true },
  'grok-imagine-1.0-video': { series: '1.0', allowedSeconds: [6, 10], requireRef: false },
  'grok-imagine-video-1.5-fast': { series: '1.5', allowedSeconds: [6, 10], requireRef: false },
  'grok-imagine-video': { series: 'legacy', allowedSeconds: null, requireRef: false },
  'grok-4.3-video': { series: 'legacy', allowedSeconds: null, requireRef: false },
  'omni-flash': { series: 'omni-flash', allowedSeconds: [4, 6, 8, 10], requireRef: false },
  'omni-flash-vref': { series: 'omni-flash-vref', allowedSeconds: [10], requireRef: false },
  'sora-v3-pro': { series: 'sora-v3', allowedSeconds: [14], requireRef: false },
  'sora-v4-fast': { series: 'sora-v4', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'sora-v4-pro': { series: 'sora-v4', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'lg-seedance-2.0-fast': { series: 'sudashui', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'sdas-d7-seedance-2.0-face-720p': { series: 'sudashui', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'sdas-mo-seedance-2.0-dj-fast': { series: 'sudashui', allowedSeconds: [5, 10, 15], requireRef: false },
  'seedance-2.0-fast': { series: 'seedance-fast', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
};

const DEFAULT_VIDEO_MODELS = [
  { id: 'grok-imagine-video-1.5-preview', name: 'Grok 1.5 Preview', description: '图生视频，必须提供参考图，6/10秒', maxSeconds: 10, icon: '🖼️' },
  { id: 'grok-imagine-1.0-video', name: 'Grok 1.0 Video', description: '文生/图生视频，6/10秒', maxSeconds: 10, icon: '🎥' },
  { id: 'grok-imagine-video-1.5-fast', name: 'Grok 1.5 Fast', description: '快速文生/图生视频，6/10秒', maxSeconds: 10, icon: '⚡' },
  { id: 'omni-flash', name: 'Omni Flash', description: '多参考图生成/纯文生视频，4/6/8/10秒，支持 1080p', maxSeconds: 10, icon: '⚡' },
  { id: 'omni-flash-vref', name: 'Omni Flash Vref', description: '视频风格编辑/改写，支持 1080p', maxSeconds: 10, icon: '✂️' },
  { id: 'sora-v3-pro', name: 'Sora V3 Pro', description: '支持933字符，不卡脸，支持9图3视频3音频参考，固定14s', maxSeconds: 14, icon: '🎬' },
  { id: 'sora-v4-fast', name: 'Sora V4 Fast', description: '支持433字符，不卡脸，支持4图3视频1音频参考，5-15s', maxSeconds: 15, icon: '⚡' },
  { id: 'sora-v4-pro', name: 'Sora V4 Pro', description: '支持433字符，不卡脸，支持4图3视频1音频参考，5-15s', maxSeconds: 15, icon: '🚀' },
  { id: 'lg-seedance-2.0-fast', name: 'seedance2.0 fast-LG版', description: '支持9图3视频3音频的参考，不限字符，4-15s', maxSeconds: 15, icon: '⚡' },
  { id: 'sdas-d7-seedance-2.0-face-720p', name: 'seedance2.0满血-D7版', description: '支持99图3视频3音频的参考，支持真人，4-15s', maxSeconds: 15, icon: '🚀' },
  { id: 'sdas-mo-seedance-2.0-dj-fast', name: 'seedance2.0极速-DJ版', description: '支持9图参考，不支持音视频，支持5/10/15s', maxSeconds: 15, icon: '⚡' },
  { id: 'seedance-2.0-fast', name: 'Seedance 2.0 Fast', description: '高画质视频生成，支持5-15s', maxSeconds: 15, icon: '🚀' },
];

/** 查找支持指定视频模型的渠道 */
function findVideoChannel(modelId: string) {
  const channel = ChannelService.findChannelForModel(modelId);
  if (channel) return { baseUrl: channel.baseUrl, apiKey: channel.apiKey };
  if (env.GROK2API_BASE_URL) return { baseUrl: env.GROK2API_BASE_URL, apiKey: env.GROK2API_API_KEY };
  return null;
}

/** GET /api/video/models — 可用的视频模型列表（公开，不需要登录） */
router.get('/models', (_req: Request, res: Response) => {
  // 从数据库动态拉取所有启用且具备 'video' 能力的模型
  const dbModels = db.select().from(models)
    .where(and(eq(models.isActive, 1), like(models.capabilities, '%"video"%')))
    .all();

  // 获取所有在数据库中被禁用的模型 ID，用作后备过滤
  const disabledModelIds = new Set<string>();
  try {
    const inactive = db.select().from(models).where(eq(models.isActive, 0)).all();
    inactive.forEach(m => disabledModelIds.add(m.modelId));
  } catch { }

  // 如果数据库里还没配置视频模型，提供一个过滤了禁用模型的默认后备
  const sourceModels = dbModels.length > 0
    ? dbModels.map(m => ({ id: m.modelId, name: m.displayName }))
    : DEFAULT_VIDEO_MODELS.filter(m => !disabledModelIds.has(m.id));

  const rate480 = db.select().from(settings).where(eq(settings.key, 'video_rate_480p')).get();
  const rate720 = db.select().from(settings).where(eq(settings.key, 'video_rate_720p')).get();
  const base480 = parseFloat(rate480?.value || '0.03');
  const base720 = parseFloat(rate720?.value || '0.05');

  const omniFlash720 = parseFloat(db.select().from(settings).where(eq(settings.key, 'omni_flash_rate_720p')).get()?.value || '0.90');
  const omniFlash1080 = parseFloat(db.select().from(settings).where(eq(settings.key, 'omni_flash_rate_1080p')).get()?.value || '1.50');
  const omniVref720 = parseFloat(db.select().from(settings).where(eq(settings.key, 'omni_vref_rate_720p')).get()?.value || '1.60');
  const omniVref1080 = parseFloat(db.select().from(settings).where(eq(settings.key, 'omni_vref_rate_1080p')).get()?.value || '2.20');
  const lgSeedanceFastRate = parseFloat(db.select().from(settings).where(eq(settings.key, 'lg_seedance_fast_rate')).get()?.value || '5.10');
  const sdasD7FaceRate = parseFloat(db.select().from(settings).where(eq(settings.key, 'sdas_d7_face_rate')).get()?.value || '5.80');
  const sdasMoDjRate = parseFloat(db.select().from(settings).where(eq(settings.key, 'sdas_mo_dj_rate')).get()?.value || '3.90');
  const soraV3ProRate = parseFloat(db.select().from(settings).where(eq(settings.key, 'sora_v3_pro_rate')).get()?.value || '4.00');
  const soraV4FastRate = parseFloat(db.select().from(settings).where(eq(settings.key, 'sora_v4_fast_rate')).get()?.value || '0.189');
  const soraV4ProRate = parseFloat(db.select().from(settings).where(eq(settings.key, 'sora_v4_pro_rate')).get()?.value || '0.25');
  const seedance20FastRate = parseFloat(db.select().from(settings).where(eq(settings.key, 'seedance_2_0_fast_rate')).get()?.value || '4.00');

  const result = sourceModels.map(m => {
    const preset = DEFAULT_VIDEO_MODELS.find(d => d.id === m.id);
    const meta = MODEL_META[m.id];
    const multiplier = meta?.series === '1.5' ? 1.2 : 1.0;

    let rates: Record<string, number>;
    if (m.id === 'omni-flash') {
      rates = {
        '720p': omniFlash720,
        '1080p': omniFlash1080,
      };
    } else if (m.id === 'omni-flash-vref') {
      rates = {
        '720p': omniVref720,
        '1080p': omniVref1080,
      };
    } else if (m.id === 'lg-seedance-2.0-fast') {
      rates = {
        '720p': lgSeedanceFastRate,
      };
    } else if (m.id === 'sdas-d7-seedance-2.0-face-720p') {
      rates = {
        '720p': sdasD7FaceRate,
      };
    } else if (m.id === 'sdas-mo-seedance-2.0-dj-fast') {
      rates = {
        '720p': sdasMoDjRate,
      };
    } else if (m.id === 'sora-v3-pro') {
      rates = {
        '720p': soraV3ProRate,
      };
    } else if (m.id === 'sora-v4-fast') {
      rates = {
        '720p': soraV4FastRate,
      };
    } else if (m.id === 'sora-v4-pro') {
      rates = {
        '720p': soraV4ProRate,
      };
    } else if (m.id === 'seedance-2.0-fast') {
      rates = {
        '720p': seedance20FastRate,
      };
    } else {
      rates = {
        '480p': Math.round(base480 * multiplier * 100) / 100,
        '720p': Math.round(base720 * multiplier * 100) / 100,
      };
    }

    return {
      id: m.id,
      name: m.name || preset?.name || m.id,
      description: preset?.description || 'AI 视频生成服务',
      available: findVideoChannel(m.id) !== null,
      maxSeconds: preset?.maxSeconds,
      allowedSeconds: meta?.allowedSeconds || null,
      requireRef: meta?.requireRef || false,
      series: meta?.series || 'legacy',
      rates,
    };
  });

  res.json(result.filter(m => m.available));
});

/** POST /api/video/generate — SSE 流式视频生成（异步轮询模式） */
router.post('/generate', authMiddleware, tierMiddleware('video'), quotaMiddleware, async (req: TierRequest, res: Response) => {
  const {
    prompt,
    model = 'grok-imagine-video',
    aspect_ratio = '16:9',
    video_length = 6,
    resolution = '720p',
    reference_images = [],   // base64 dataURL 数组
    reference_video = '',    // Base64 video data URL or URL
    audio_url = '',          // Base64 audio data URL or URL
    first_frame = '',        // Base64 首帧图片
    last_frame = '',         // Base64 尾帧图片
  } = req.body;

  if (!prompt?.trim()) {
    return res.status(400).json({ error: '请输入视频描述' });
  }

  const meta = MODEL_META[model];

  // 模型时长限制校验
  if (meta?.allowedSeconds && !meta.allowedSeconds.includes(Number(video_length))) {
    return res.status(400).json({ error: `模型 ${model} 只支持 ${meta.allowedSeconds.join('/')} 秒` });
  }

  // 强制参考图校验（grok-imagine-video-1.5-preview 必须提供且只能 1 张）
  const hasRef = Array.isArray(reference_images) && reference_images.length > 0;
  if (meta?.requireRef && !hasRef) {
    return res.status(400).json({ error: `模型 ${model} 必须提供参考图` });
  }

  if (model === 'omni-flash-vref' && !reference_video) {
    return res.status(400).json({ error: '视频编辑/重绘模型必须提供参考视频' });
  }

  const channel = findVideoChannel(model);
  if (!channel) {
    return res.status(503).json({ error: '未配置视频生成渠道。请在管理后台添加渠道或设置 GROK2API_BASE_URL。' });
  }

  // Get the mapped model name from the database channel configuration
  const dbChannel = ChannelService.findChannelForModel(model);
  let upstreamModel = model;
  if (dbChannel?.modelMapping) {
    try {
      const mapping = typeof dbChannel.modelMapping === 'string' ? JSON.parse(dbChannel.modelMapping) : dbChannel.modelMapping;
      upstreamModel = mapping[model] || model;
    } catch { /* skip */ }
  }



  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (data: Record<string, any>) => {
    if (!res.destroyed && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  const startTime = Date.now();

  // 视频计费费率——按模型系列分级
  let rate = 0.05;
  if (model === 'omni-flash') {
    const key = resolution === '1080p' ? 'omni_flash_rate_1080p' : 'omni_flash_rate_720p';
    const row = db.select().from(settings).where(eq(settings.key, key)).get();
    rate = parseFloat(row?.value || (resolution === '1080p' ? '1.50' : '0.90'));
  } else if (model === 'omni-flash-vref') {
    const key = resolution === '1080p' ? 'omni_vref_rate_1080p' : 'omni_vref_rate_720p';
    const row = db.select().from(settings).where(eq(settings.key, key)).get();
    rate = parseFloat(row?.value || (resolution === '1080p' ? '2.20' : '1.60'));

  } else if (model === 'lg-seedance-2.0-fast') {
    const row = db.select().from(settings).where(eq(settings.key, 'lg_seedance_fast_rate')).get();
    rate = parseFloat(row?.value || '5.10');
  } else if (model === 'sdas-d7-seedance-2.0-face-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_d7_face_rate')).get();
    rate = parseFloat(row?.value || '5.80');
  } else if (model === 'sdas-mo-seedance-2.0-dj-fast') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_mo_dj_rate')).get();
    rate = parseFloat(row?.value || '3.90');
  } else if (model === 'sora-v3-pro') {
    const row = db.select().from(settings).where(eq(settings.key, 'sora_v3_pro_rate')).get();
    rate = parseFloat(row?.value || '4.00');
  } else if (model === 'seedance-2.0-fast') {
    const row = db.select().from(settings).where(eq(settings.key, 'seedance_2_0_fast_rate')).get();
    rate = parseFloat(row?.value || '4.00');
  } else if (model === 'sora-v4-fast') {
    const row = db.select().from(settings).where(eq(settings.key, 'sora_v4_fast_rate')).get();
    rate = parseFloat(row?.value || '0.189');
  } else if (model === 'sora-v4-pro' || model === 'seedance-2.0') {
    const row = db.select().from(settings).where(eq(settings.key, 'sora_v4_pro_rate')).get();
    rate = parseFloat(row?.value || '0.25');
  } else {
    const rate480 = db.select().from(settings).where(eq(settings.key, 'video_rate_480p')).get();
    const rate720 = db.select().from(settings).where(eq(settings.key, 'video_rate_720p')).get();
    const BASE_RATE: Record<string, number> = {
      '480p': parseFloat(rate480?.value || '0.03'),
      '720p': parseFloat(rate720?.value || '0.05'),
    };
    const seriesMultiplier = meta?.series === '1.5' ? 1.2 : 1.0;
    rate = Math.round((BASE_RATE[resolution] || BASE_RATE['720p']) * seriesMultiplier * 100) / 100;
  }

  // 预估费用并检查余额
  const isFlatRate = ['sora-v3-pro', 'lg-seedance-2.0-fast', 'sdas-d7-seedance-2.0-face-720p', 'sdas-mo-seedance-2.0-dj-fast', 'seedance-2.0-fast'].includes(model);
  const estimatedRate = rate;
  const estimatedSeconds = model === 'omni-flash-vref' ? 10 : (Number(video_length) || 6);
  const estimatedCost = isFlatRate ? estimatedRate : (Math.round(estimatedRate * estimatedSeconds * 100) / 100);
  const { sufficient, balance: currentBalance } = BalanceService.checkBalance(req.userId!, estimatedCost);
  if (!sufficient) {
    sendEvent({ type: 'error', message: `余额不足，预估费用 ¥${estimatedCost.toFixed(2)}，当前余额 ¥${currentBalance.toFixed(2)}` });
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // 插入初始的 'processing' 内容记录，确保刷新页面时正在生成中的记录不会丢失
  let contentId: number | null = null;
  try {
    contentId = ContentService.save({
      userId: req.userId!,
      orgId: req.orgId || null,
      type: 'video',
      title: (prompt as string).slice(0, 200),
      inputText: (prompt as string).slice(0, 500),
      modelId: model,
      cost: estimatedCost,
      status: 'processing',
      metadata: {
        resolution,
        seconds: estimatedSeconds,
        aspect_ratio,
        model,
        reference_images,
        reference_video: reference_video || null,
        audio_url: audio_url || null
      }
    });
    if (contentId !== null) {
      sendEvent({ type: 'content_id', contentId });
    }
  } catch (e) {
    console.error('[content] 初始视频记录保存失败:', e);
  }

  /** 生成成功后计费 + 更新内容 */
  const billUsage = (finalVideoUrl: string) => {
    const elapsed = Date.now() - startTime;
    logUsage(req.userId!, 'generate_video', undefined, elapsed);
    const cost = isFlatRate ? rate : (Math.round(rate * estimatedSeconds * 100) / 100);
    if (cost > 0) {
      const remaining = BalanceService.deduct(req.userId!, cost, 'generate_video');
      sendEvent({ type: 'billing', cost, resolution, seconds: estimatedSeconds, rate, remainingBalance: remaining ?? 0 });
    }
    if (contentId !== null) {
      try {
        db.update(contents).set({
          status: 'completed',
          resultUrl: finalVideoUrl || null,
          cost: cost
        }).where(eq(contents.id, contentId)).run();
      } catch (e) { console.error('[content] 视频记录更新失败:', e); }
    }
  };

  const baseUrl = channel.baseUrl.replace(/\/+$/, '');
  const size = RATIO_TO_SIZE[aspect_ratio] || '1280x720';
  const isOmni = model.startsWith('omni-flash');
  const isSoraV3 = model === 'sora-v3-pro';
  const isSeedanceFast = model === 'seedance-2.0-fast';
  const isSoraV4 = model === 'sora-v4-fast' || model === 'sora-v4-pro' || model === 'seedance-2.0';
  const isSudaShui = meta?.series === 'sudashui';

  try {
    let videoId = '';

    if (isOmni) {
      sendEvent({ type: 'status', message: '正在提交 Omni 视频生成任务...' });

      const getOmniAspectRatio = (ratio: string): 'landscape' | 'portrait' => {
        if (['9:16', '3:4', '2:3'].includes(ratio)) return 'portrait';
        return 'landscape';
      };

      const payload: Record<string, any> = {
        model,
        prompt: prompt.trim(),
        duration: model === 'omni-flash-vref' ? 10 : Number(video_length),
        aspect_ratio: getOmniAspectRatio(aspect_ratio),
        resolution,
        images: reference_images || [],
      };
      if (model === 'omni-flash-vref') {
        payload.video = reference_video;
      }

      console.log(`[video] Step1 Omni 创建任务: model=${model} duration=${payload.duration} resolution=${resolution}`);

      const createResp = await fetch(`${baseUrl}/v1/video/generations`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${channel.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
      });

      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        console.error(`[video] Omni 创建任务失败: ${createResp.status} ${errText.slice(0, 300)}`);
        sendEvent({ type: 'error', message: `创建视频任务失败 (${createResp.status}): ${errText.slice(0, 200)}` });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const job = await createResp.json() as any;
      videoId = job.id || job.task_id;
    } else if (isSudaShui) {
      sendEvent({ type: 'status', message: '正在上传素材并提交 SudaShui 任务...' });

      const imageUrls: string[] = [];
      for (const img of (reference_images || [])) {
        imageUrls.push(await uploadToSudaShui(img, channel.apiKey));
      }
      const videoUrl = reference_video ? await uploadToSudaShui(reference_video, channel.apiKey) : undefined;
      const audioUrl = audio_url ? await uploadToSudaShui(audio_url, channel.apiKey) : undefined;

      let finalPrompt = prompt.trim();
      finalPrompt = finalPrompt.replace(/\[ref_(\d+)(?:\.[a-zA-Z0-9]+)?\]/g, (match, idxStr) => {
        const idx = parseInt(idxStr, 10);
        return `@image${idx + 1}`;
      });

      const payloadMetadata = {
        aspectRatio: aspect_ratio,
        mode: 'references',
        imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
        videoUrls: videoUrl ? [videoUrl] : undefined,
        audioUrls: audioUrl ? [audioUrl] : undefined,
      };

      const payload: Record<string, any> = {
        model: upstreamModel,
        prompt: finalPrompt,
        duration: Number(video_length) || 6,
        metadata: {
          payload: JSON.stringify(payloadMetadata)
        }
      };

      console.log(`[video] Step1 SudaShui 创建任务: model=${model} duration=${payload.duration} resolution=${resolution}`);

      const createResp = await fetch(`${baseUrl}/v1/video/generations`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${channel.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
      });

      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        console.error(`[video] SudaShui 创建任务失败: ${createResp.status} ${errText.slice(0, 300)}`);
        sendEvent({ type: 'error', message: `创建视频任务失败 (${createResp.status}): ${errText.slice(0, 200)}` });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const job = await createResp.json() as any;
      videoId = job.task_id || job.id;
    } else if (isSoraV3) {
      sendEvent({ type: 'status', message: '正在处理素材并提交 Sora V3 Pro 任务...' });

      // 将 base64 素材保存到本地并生成自托管公网 URL（Pidoi 网关不路由 /seedance-assets/upload）
      const imageUrls: string[] = [];
      for (const img of (reference_images || []).slice(0, 9)) {
        const url = convertBase64ToPublicUrl(img, 'sora_ref', req);
        if (url) imageUrls.push(url);
      }
      const videoUrl = reference_video ? convertBase64ToPublicUrl(reference_video, 'sora_vid', req) : undefined;
      const audioUrl = audio_url ? convertBase64ToPublicUrl(audio_url, 'sora_aud', req) : undefined;
      const firstFrameUrl = first_frame ? convertBase64ToPublicUrl(first_frame, 'sora_ff', req) : undefined;
      const lastFrameUrl = last_frame ? convertBase64ToPublicUrl(last_frame, 'sora_lf', req) : undefined;

      const payload: Record<string, any> = {
        model: upstreamModel,
        prompt: prompt.trim(),
        seconds: String(Number(video_length) || 8),
        aspect_ratio: aspect_ratio,
        resolution: resolution,
      };

      if (imageUrls.length > 0) payload.reference_image_urls = imageUrls;
      if (videoUrl) payload.reference_videos = [videoUrl];
      if (audioUrl) payload.reference_audios = [audioUrl];
      if (firstFrameUrl) payload.first_frame_url = firstFrameUrl;
      if (lastFrameUrl) payload.last_frame_url = lastFrameUrl;

      console.log(`[video] Step1 SoraV3Pro 创建任务: model=${model} seconds=${payload.seconds} resolution=${resolution} refs=${imageUrls.length} video=${!!videoUrl} audio=${!!audioUrl} firstFrame=${!!firstFrameUrl} lastFrame=${!!lastFrameUrl}`);

      const createResp = await fetch(`${baseUrl}/v1/videos`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${channel.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
      });

      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        console.error(`[video] SoraV3Pro 创建任务失败: ${createResp.status} ${errText.slice(0, 300)}`);
        sendEvent({ type: 'error', message: `创建视频任务失败 (${createResp.status}): ${errText.slice(0, 200)}` });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const job = await createResp.json() as any;
      videoId = job.task_id || job.id;
    } else if (isSoraV4) {
      sendEvent({ type: 'status', message: '正在处理素材并提交 Sora V4 任务...' });

      // 将 base64 素材保存到本地并生成自托管公网 URL
      const imageUrls: string[] = [];
      for (const img of (reference_images || []).slice(0, 4)) {
        const url = convertBase64ToPublicUrl(img, 'sora_ref', req);
        if (url) imageUrls.push(url);
      }
      const videoUrl = reference_video ? convertBase64ToPublicUrl(reference_video, 'sora_vid', req) : undefined;
      const firstFrameUrl = first_frame ? convertBase64ToPublicUrl(first_frame, 'sora_ff', req) : undefined;
      const lastFrameUrl = last_frame ? convertBase64ToPublicUrl(last_frame, 'sora_lf', req) : undefined;

      // 确定参考模式和要传入的图片列表
      let referenceMode = 'auto';
      const refImages: string[] = [];
      if (firstFrameUrl && lastFrameUrl) {
        refImages.push(firstFrameUrl, lastFrameUrl);
        referenceMode = 'start_end';
      } else if (firstFrameUrl) {
        refImages.push(firstFrameUrl);
        referenceMode = 'start_frame';
      } else if (imageUrls.length > 0) {
        refImages.push(...imageUrls);
        referenceMode = 'image_reference';
      }

      const payload: Record<string, any> = {
        model: upstreamModel,
        prompt: prompt.trim(),
        duration: Number(video_length) || 5,
        video_config: {
          aspect_ratio: aspect_ratio,
          resolution_name: resolution || '720p',
          reference_mode: referenceMode
        }
      };

      if (refImages.length > 0) {
        payload.reference_images = refImages;
      }
      if (videoUrl) {
        payload.reference_video = videoUrl;
      }

      console.log(`[video] Step1 SoraV4 创建任务: model=${model} upstreamModel=${upstreamModel} duration=${payload.duration} refs=${refImages.length} mode=${referenceMode} video=${!!videoUrl}`);

      const createResp = await fetch(`${baseUrl}/v1/videos`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${channel.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
      });

      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        console.error(`[video] SoraV4 创建任务失败: ${createResp.status} ${errText.slice(0, 300)}`);
        sendEvent({ type: 'error', message: `创建视频任务失败 (${createResp.status}): ${errText.slice(0, 200)}` });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const job = await createResp.json() as any;
      videoId = job.task_id || job.id;
    } else if (isSeedanceFast) {
      sendEvent({ type: 'status', message: '正在处理素材并提交 Seedance 2.0 Fast 任务...' });

      // 将 base64 素材保存到本地并生成自托管公网 URL
      const imageUrls: string[] = [];
      for (const img of (reference_images || [])) {
        const url = convertBase64ToPublicUrl(img, 'seedance_ref', req);
        if (url) imageUrls.push(url);
      }

      const idempotencyKey = globalThis.crypto ? globalThis.crypto.randomUUID() : `idemp_${Date.now()}_${Math.random().toString(36).substring(2)}`;

      const payload: Record<string, any> = {
        model: 'seedance-2.0-fast',
        prompt: prompt.trim(),
        duration: Number(video_length) || 5,
        seconds: String(Number(video_length) || 5),
        metadata: {
          ratio: aspect_ratio,
          resolution: resolution || '720p',
        }
      };

      if (imageUrls.length > 0) {
        payload.images = imageUrls;
      }

      console.log(`[video] Step1 SeedanceFast 创建任务: model=${model} duration=${payload.duration} resolution=${resolution} refs=${imageUrls.length}`);

      const createResp = await fetch(`${baseUrl}/v1/video/generations`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${channel.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
      });

      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        console.error(`[video] Seedance 2.0 Fast 创建任务失败: ${createResp.status} ${errText.slice(0, 300)}`);
        sendEvent({ type: 'error', message: `创建视频任务失败 (${createResp.status}): ${errText.slice(0, 200)}` });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const job = await createResp.json() as any;
      videoId = job.task_id || job.id;
    } else {
      // ━━━ Step 1: 创建视频任务（multipart/form-data） ━━━
      sendEvent({ type: 'status', message: hasRef ? '正在上传参考图并提交任务...' : '正在提交视频生成任务...' });

      const formData = new FormData();
      formData.append('model', model);
      formData.append('prompt', prompt.trim());
      formData.append('seconds', String(video_length));
      formData.append('size', size);
      formData.append('resolution_name', resolution);

      // 参考图：将 base64 dataURL 转为 Blob 文件上传
      // 1.5-preview 只允许 1 张，其他模型最多 5 张
      const maxRefs = meta?.requireRef ? 1 : 5;
      if (hasRef) {
        for (let i = 0; i < Math.min(reference_images.length, maxRefs); i++) {
          const dataUrl: string = reference_images[i];
          const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (matches) {
            const mimeType = matches[1];
            const base64Data = matches[2];
            const buffer = Buffer.from(base64Data, 'base64');
            const blob = new Blob([buffer], { type: mimeType });
            const ext = mimeType.includes('png') ? 'png' : 'jpg';
            formData.append('input_reference[]', blob, `ref_${i}.${ext}`);
          }
        }
      }

      const headers: Record<string, string> = {};
      if (channel.apiKey) headers['Authorization'] = `Bearer ${channel.apiKey}`;

      console.log(`[video] Step1 创建任务: model=${model} seconds=${video_length} hasRef=${hasRef} refCount=${hasRef ? Math.min(reference_images.length, 5) : 0}`);

      const createResp = await fetch(`${baseUrl}/v1/videos`, {
        method: 'POST',
        headers,
        body: formData,
        signal: AbortSignal.timeout(60_000),
      });

      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        console.error(`[video] 创建任务失败: ${createResp.status} ${errText.slice(0, 300)}`);
        sendEvent({ type: 'error', message: `创建视频任务失败 (${createResp.status}): ${errText.slice(0, 200)}` });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const job = await createResp.json() as any;
      videoId = job.id;
    }

    console.log(`[video] 任务已创建: id=${videoId}`);
    sendEvent({ type: 'status', message: `任务已提交，等待生成... (${videoId})` });

    if (contentId !== null) {
      activePolls.add(contentId);
      if (videoId) {
        try {
          const row = db.select().from(contents).where(eq(contents.id, contentId)).get();
          if (row) {
            const meta = JSON.parse(row.metadata || '{}');
            meta.videoId = videoId;
            db.update(contents).set({ metadata: JSON.stringify(meta) }).where(eq(contents.id, contentId)).run();
          }
        } catch (dbErr) {
          console.error('[video] 写入 videoId 失败:', dbErr);
        }
      }
    }

    if (!videoId) {
      if (contentId !== null) activePolls.delete(contentId);
      sendEvent({ type: 'error', message: '上游未返回任务 ID' });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // ━━━ Step 2: 轮询任务状态（无超时，直到上游返回完成或失败） ━━━
    const pollInterval = 5000; // 5 秒轮询

    const headers: Record<string, string> = {};
    if (channel.apiKey) headers['Authorization'] = `Bearer ${channel.apiKey}`;

    while (true) {
      await new Promise(r => setTimeout(r, pollInterval));

      // 检查客户端是否断开仅进行日志记录，不终止后台轮询以完成计费和数据库更新
      if (res.writableEnded || res.destroyed) {
        console.log(`[video] 客户端已断开，后台继续轮询任务 ${videoId}...`);
      }

      try {
        let pollUrl = `${baseUrl}/v1/videos/${videoId}`;
        if (isOmni || isSudaShui) {
          pollUrl = `${baseUrl}/v1/video/generations/${videoId}`;
        }

        const pollResp = await fetch(pollUrl, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });

        if (!pollResp.ok) {
          console.warn(`[video] 轮询返回 ${pollResp.status}`);
          continue;
        }

        const status = await pollResp.json() as any;
        let taskStatus = status.status;
        let progress = status.progress || 0;
        let resultUrl = '';
        let errMsg = '';

        if (isOmni || isSudaShui) {
          const dataBlock = status.data || {};
          taskStatus = (dataBlock.status || status.status || '').toLowerCase();

          const progressStr = dataBlock.progress || status.progress || '0%';
          progress = parseInt(progressStr) || 0;

          if (taskStatus === 'success' || taskStatus === 'completed') {
            resultUrl = dataBlock.result_url || (dataBlock.data && dataBlock.data.url) || status.result_url || status.url;
          } else if (taskStatus === 'failure' || taskStatus === 'failed') {
            const errVal = dataBlock.error || status.error;
            const detailMsg = (typeof errVal === 'object' && errVal) ? errVal.message : errVal;
            errMsg = dataBlock.fail_reason || detailMsg || '视频生成失败';
          }
        } else if (isSeedanceFast) {
          const outerData = status.data || {};
          const isNested = status.data && status.data.status !== undefined;
          
          if (isNested) {
            const rawStatus = (outerData.status || '').toLowerCase();
            if (rawStatus === 'not_start') {
              taskStatus = 'pending';
              progress = 0;
            } else if (rawStatus === 'in_progress') {
              taskStatus = 'in_progress';
              progress = status.progress || outerData.progress || 50;
            } else if (rawStatus === 'success') {
              taskStatus = 'success';
              progress = 100;
              const innerData = outerData.data || {};
              const content = innerData.content || {};
              resultUrl = content.video_url || '';
            } else if (rawStatus === 'failure') {
              taskStatus = 'failure';
              errMsg = '视频生成失败';
            } else {
              taskStatus = rawStatus;
            }
          } else {
            taskStatus = (status.status || '').toLowerCase();
            const rawProgress = status.progress;
            if (rawProgress !== undefined && rawProgress !== null) {
              progress = typeof rawProgress === 'number' ? rawProgress : (parseInt(String(rawProgress)) || 0);
            }
            if (taskStatus === 'completed' || taskStatus === 'success') {
              resultUrl = status.video_url || status.url || status.result_url
                || (Array.isArray(status.outputs) && status.outputs[0]?.url)
                || `${baseUrl}/v1/files/video?id=${videoId}`;
            } else if (taskStatus === 'failed' || taskStatus === 'failure') {
              const errVal = status.error;
              const detailMsg = (typeof errVal === 'object' && errVal) ? errVal.message : errVal;
              errMsg = detailMsg || status.failure_reason || status.fail_reason || '视频生成失败';
            }
          }
        } else {
          taskStatus = (status.status || '').toLowerCase();
          // 解析进度：支持数字 (16) 和百分比字符串 ("16%") 两种格式
          const rawProgress = status.progress;
          if (rawProgress !== undefined && rawProgress !== null) {
            progress = typeof rawProgress === 'number' ? rawProgress : (parseInt(String(rawProgress)) || 0);
          }
          if (taskStatus === 'completed' || taskStatus === 'success') {
            resultUrl = status.video_url || status.url || status.result_url
              || (Array.isArray(status.outputs) && status.outputs[0]?.url)
              || `${baseUrl}/v1/files/video?id=${videoId}`;
          } else if (taskStatus === 'failed' || taskStatus === 'failure') {
            const errVal = status.error;
            const detailMsg = (typeof errVal === 'object' && errVal) ? errVal.message : errVal;
            errMsg = detailMsg || status.failure_reason || status.fail_reason || '视频生成失败';
          }
        }

        console.log(`[video] 轮询 (${isOmni ? 'Omni' : isSudaShui ? 'SudaShui' : isSoraV3 ? 'SoraV3' : isSoraV4 ? 'SoraV4' : isSeedanceFast ? 'SeedanceFast' : 'Grok'}): status=${taskStatus} progress=${progress}%`);

        if (taskStatus === 'processing' || taskStatus === 'queued' || taskStatus === 'pending' || taskStatus === 'submitted' || taskStatus === 'in_progress') {
          sendEvent({ type: 'progress', progress });
          sendEvent({ type: 'status', message: `视频生成中 ${progress}%` });
          // 将实时进度写入数据库，以便前端刷新页面后恢复时能读取
          if (contentId !== null && progress > 0) {
            try {
              const row = db.select().from(contents).where(eq(contents.id, contentId)).get();
              if (row) {
                const meta = JSON.parse(row.metadata || '{}');
                meta.progress = progress;
                db.update(contents).set({ metadata: JSON.stringify(meta) }).where(eq(contents.id, contentId)).run();
              }
            } catch { }
          }
        } else if (taskStatus === 'completed' || taskStatus === 'success') {
          console.log(`[video] ✅ 生成完成: ${resultUrl}`);
          sendEvent({ type: 'progress', progress: 100 });
          sendEvent({ type: 'complete', videoUrl: resultUrl });
          billUsage(resultUrl);
          if (contentId !== null) activePolls.delete(contentId);
          if (!res.destroyed && !res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
          }
          return;
        } else if (taskStatus === 'failed' || taskStatus === 'failure') {
          console.error(`[video] ❌ 生成失败: ${errMsg}`);
          sendEvent({ type: 'error', message: errMsg });
          if (contentId !== null) {
            activePolls.delete(contentId);
            try {
              db.update(contents).set({ status: 'failed' }).where(eq(contents.id, contentId)).run();
            } catch (dbErr) { console.error('[video] 失败状态更新错误:', dbErr); }
          }
          if (!res.destroyed && !res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
          }
          return;
        }
      } catch (pollErr: any) {
        console.warn(`[video] 轮询异常: ${pollErr.message}`);
        // 轮询失败不立即退出，继续重试
      }
    }

  } catch (err: any) {
    console.error(`[video] 生成失败:`, err.name, err.message, err.cause?.message || '');
    const msg = err.name === 'AbortError'
      ? '请求超时'
      : (err.cause?.message || err.message || '请求失败');
    sendEvent({ type: 'error', message: msg });
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// 视频下载代理，解决浏览器跨域下载变成播放的问题
router.get('/download', async (req: Request, res: Response) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  try {
    const filename = req.query.filename as string || 'video.mp4';
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch video: ${response.statusText}`);

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', response.headers.get('Content-Type') || 'video/mp4');
    const contentLength = response.headers.get('Content-Length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const reader = response.body?.getReader();
    if (!reader) return res.status(500).send('No video stream body');

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      reader.releaseLock();
    }
    res.end();
  } catch (err: any) {
    console.error('[video/download] error:', err.message);
    res.status(502).send(`Download failed: ${err.message}`);
  }
});

// ═══ 视频合并接口 ═══
router.post('/merge', authMiddleware, async (req: Request, res: Response) => {
  const { urls } = req.body;
  if (!Array.isArray(urls) || urls.length < 2) return res.status(400).json({ error: '至少需要 2 个视频 URL' });
  if (urls.length > 20) return res.status(400).json({ error: '最多支持 20 段' });

  const { execSync } = await import('child_process');
  const fs = await import('fs');
  const path = await import('path');
  const os = await import('os');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-merge-'));
  const files: string[] = [];

  try {
    // 1. 下载所有视频
    for (let i = 0; i < urls.length; i++) {
      const filePath = path.join(tmpDir, `seg_${i}.mp4`);
      const resp = await fetch(urls[i]);
      if (!resp.ok) throw new Error(`下载第 ${i + 1} 段失败: ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(filePath, buf);
      files.push(filePath);
    }

    // 2. 生成 concat 文件
    const listFile = path.join(tmpDir, 'list.txt');
    fs.writeFileSync(listFile, files.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));

    // 3. ffmpeg 合并
    const outputFile = path.join(tmpDir, 'merged.mp4');
    execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${outputFile}"`, { timeout: 120000 });

    // 4. 返回合并文件
    const stat = fs.statSync(outputFile);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', 'attachment; filename="merged.mp4"');
    const stream = fs.createReadStream(outputFile);
    stream.pipe(res);
    stream.on('end', () => {
      // 清理临时文件
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
    });
  } catch (err: any) {
    // 清理
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
    console.error('[video/merge]', err.message);
    res.status(500).json({ error: err.message || '合并失败' });
  }
});

export function resumePollForTask(contentId: number, record: any) {
  if (activePolls.has(contentId)) return;
  activePolls.add(contentId);

  const model = record.modelId || '';
  const meta = MODEL_META[model];
  const channel = findVideoChannel(model);
  if (!channel) {
    console.error(`[video-recover] No channel found for model ${model} in task ${contentId}`);
    activePolls.delete(contentId);
    return;
  }

  let videoId = '';
  let metadata: any = {};
  try {
    metadata = typeof record.metadata === 'string' ? JSON.parse(record.metadata) : (record.metadata || {});
    videoId = metadata.videoId || '';
  } catch (e) {
    console.error(`[video-recover] Parse metadata failed for task ${contentId}:`, e);
  }

  if (!videoId) {
    console.error(`[video-recover] No videoId found in metadata for task ${contentId}`);
    activePolls.delete(contentId);
    return;
  }

  const resolution = metadata.resolution || '720p';
  const video_length = metadata.seconds || 6;

  // Calculate billing rate
  let rate = 0.05;
  if (model === 'omni-flash') {
    const key = resolution === '1080p' ? 'omni_flash_rate_1080p' : 'omni_flash_rate_720p';
    const row = db.select().from(settings).where(eq(settings.key, key)).get();
    rate = parseFloat(row?.value || (resolution === '1080p' ? '1.50' : '0.90'));
  } else if (model === 'omni-flash-vref') {
    const key = resolution === '1080p' ? 'omni_vref_rate_1080p' : 'omni_vref_rate_720p';
    const row = db.select().from(settings).where(eq(settings.key, key)).get();
    rate = parseFloat(row?.value || (resolution === '1080p' ? '2.20' : '1.60'));
  } else if (model === 'lg-seedance-2.0-fast') {
    const row = db.select().from(settings).where(eq(settings.key, 'lg_seedance_fast_rate')).get();
    rate = parseFloat(row?.value || '5.10');
  } else if (model === 'sdas-d7-seedance-2.0-face-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_d7_face_rate')).get();
    rate = parseFloat(row?.value || '5.80');
  } else if (model === 'sdas-mo-seedance-2.0-dj-fast') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_mo_dj_rate')).get();
    rate = parseFloat(row?.value || '3.90');
  } else if (model === 'sora-v3-pro') {
    const row = db.select().from(settings).where(eq(settings.key, 'sora_v3_pro_rate')).get();
    rate = parseFloat(row?.value || '4.00');
  } else if (model === 'seedance-2.0-fast') {
    const row = db.select().from(settings).where(eq(settings.key, 'seedance_2_0_fast_rate')).get();
    rate = parseFloat(row?.value || '4.00');
  } else if (model === 'sora-v4-fast') {
    const row = db.select().from(settings).where(eq(settings.key, 'sora_v4_fast_rate')).get();
    rate = parseFloat(row?.value || '0.189');
  } else if (model === 'sora-v4-pro' || model === 'seedance-2.0') {
    const row = db.select().from(settings).where(eq(settings.key, 'sora_v4_pro_rate')).get();
    rate = parseFloat(row?.value || '0.25');
  } else {
    const rate480 = db.select().from(settings).where(eq(settings.key, 'video_rate_480p')).get();
    const rate720 = db.select().from(settings).where(eq(settings.key, 'video_rate_720p')).get();
    const BASE_RATE: Record<string, number> = {
      '480p': parseFloat(rate480?.value || '0.03'),
      '720p': parseFloat(rate720?.value || '0.05'),
    };
    const seriesMultiplier = meta?.series === '1.5' ? 1.2 : 1.0;
    rate = Math.round((BASE_RATE[resolution] || BASE_RATE['720p']) * seriesMultiplier * 100) / 100;
  }

  const isFlatRate = ['sora-v3-pro', 'lg-seedance-2.0-fast', 'sdas-d7-seedance-2.0-face-720p', 'sdas-mo-seedance-2.0-dj-fast', 'seedance-2.0-fast'].includes(model);

  const baseUrl = channel.baseUrl.replace(/\/+$/, '');
  const isOmni = model.startsWith('omni-flash');
  const isSoraV3 = model === 'sora-v3-pro';
  const isSeedanceFast = model === 'seedance-2.0-fast';
  const isSoraV4 = model === 'sora-v4-fast' || model === 'sora-v4-pro' || model === 'seedance-2.0';
  const isSudaShui = meta?.series === 'sudashui';

  const headers: Record<string, string> = {};
  if (channel.apiKey) headers['Authorization'] = `Bearer ${channel.apiKey}`;

  (async () => {
    console.log(`[video-recover] Starting polling for video task ${contentId} (videoId: ${videoId})`);
    const pollInterval = 5000;
    const startTime = Date.now();

    while (true) {
      const currentRecord = db.select().from(contents).where(eq(contents.id, contentId)).get();
      if (!currentRecord || currentRecord.status !== 'processing') {
        console.log(`[video-recover] Task ${contentId} is no longer in processing status (or was deleted)`);
        break;
      }

      await new Promise(r => setTimeout(r, pollInterval));

      try {
        let pollUrl = `${baseUrl}/v1/videos/${videoId}`;
        if (isOmni || isSudaShui) {
          pollUrl = `${baseUrl}/v1/video/generations/${videoId}`;
        }

        const pollResp = await fetch(pollUrl, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });

        if (!pollResp.ok) {
          console.warn(`[video-recover] Poll returned ${pollResp.status}`);
          continue;
        }

        const statusData = await pollResp.json() as any;
        let taskStatus = statusData.status;
        let progress = statusData.progress || 0;
        let resultUrl = '';
        let errMsg = '';

        if (isOmni || isSudaShui) {
          const dataBlock = statusData.data || {};
          taskStatus = (dataBlock.status || statusData.status || '').toLowerCase();
          const progressStr = dataBlock.progress || statusData.progress || '0%';
          progress = parseInt(progressStr) || 0;
          if (taskStatus === 'success' || taskStatus === 'completed') {
            resultUrl = dataBlock.result_url || (dataBlock.data && dataBlock.data.url) || statusData.result_url || statusData.url;
          } else if (taskStatus === 'failure' || taskStatus === 'failed') {
            const errVal = dataBlock.error || statusData.error;
            const detailMsg = (typeof errVal === 'object' && errVal) ? errVal.message : errVal;
            errMsg = dataBlock.fail_reason || detailMsg || '视频生成失败';
          }
        } else if (isSeedanceFast) {
          const outerData = statusData.data || {};
          const isNested = statusData.data && statusData.data.status !== undefined;
          if (isNested) {
            const rawStatus = (outerData.status || '').toLowerCase();
            if (rawStatus === 'not_start') {
              taskStatus = 'pending';
              progress = 0;
            } else if (rawStatus === 'in_progress') {
              taskStatus = 'in_progress';
              progress = statusData.progress || outerData.progress || 50;
            } else if (rawStatus === 'success') {
              taskStatus = 'success';
              progress = 100;
              const innerData = outerData.data || {};
              const content = innerData.content || {};
              resultUrl = content.video_url || '';
            } else if (rawStatus === 'failure') {
              taskStatus = 'failure';
              errMsg = '视频生成失败';
            } else {
              taskStatus = rawStatus;
            }
          } else {
            taskStatus = (statusData.status || '').toLowerCase();
            const rawProgress = statusData.progress;
            if (rawProgress !== undefined && rawProgress !== null) {
              progress = typeof rawProgress === 'number' ? rawProgress : (parseInt(String(rawProgress)) || 0);
            }
            if (taskStatus === 'completed' || taskStatus === 'success') {
              resultUrl = statusData.video_url || statusData.url || statusData.result_url
                || (Array.isArray(statusData.outputs) && statusData.outputs[0]?.url)
                || `${baseUrl}/v1/files/video?id=${videoId}`;
            } else if (taskStatus === 'failed' || taskStatus === 'failure') {
              const errVal = statusData.error;
              const detailMsg = (typeof errVal === 'object' && errVal) ? errVal.message : errVal;
              errMsg = detailMsg || statusData.failure_reason || statusData.fail_reason || '视频生成失败';
            }
          }
        } else {
          taskStatus = (statusData.status || '').toLowerCase();
          const rawProgress = statusData.progress;
          if (rawProgress !== undefined && rawProgress !== null) {
            progress = typeof rawProgress === 'number' ? rawProgress : (parseInt(String(rawProgress)) || 0);
          }
          if (taskStatus === 'completed' || taskStatus === 'success') {
            resultUrl = statusData.video_url || statusData.url || statusData.result_url
              || (Array.isArray(statusData.outputs) && statusData.outputs[0]?.url)
              || `${baseUrl}/v1/files/video?id=${videoId}`;
          } else if (taskStatus === 'failed' || taskStatus === 'failure') {
            const errVal = statusData.error;
            const detailMsg = (typeof errVal === 'object' && errVal) ? errVal.message : errVal;
            errMsg = detailMsg || statusData.failure_reason || statusData.fail_reason || '视频生成失败';
          }
        }

        console.log(`[video-recover] Polling task ${contentId}: status=${taskStatus} progress=${progress}%`);

        if (taskStatus === 'processing' || taskStatus === 'queued' || taskStatus === 'pending' || taskStatus === 'submitted' || taskStatus === 'in_progress') {
          try {
            const meta = JSON.parse(currentRecord.metadata || '{}');
            meta.progress = progress;
            db.update(contents).set({ metadata: JSON.stringify(meta) }).where(eq(contents.id, contentId)).run();
          } catch {}
        } else if (taskStatus === 'completed' || taskStatus === 'success') {
          console.log(`[video-recover] ✅ Generating completed: ${resultUrl}`);
          logUsage(record.userId, 'generate_video', undefined, Date.now() - startTime);
          const cost = isFlatRate ? rate : (Math.round(rate * video_length * 100) / 100);
          if (cost > 0) {
            BalanceService.deduct(record.userId, cost, 'generate_video');
          }
          db.update(contents).set({
            status: 'completed',
            resultUrl: resultUrl || null,
            cost: cost
          }).where(eq(contents.id, contentId)).run();
          break;
        } else if (taskStatus === 'failed' || taskStatus === 'failure') {
          console.error(`[video-recover] ❌ Generating failed: ${errMsg}`);
          db.update(contents).set({ status: 'failed' }).where(eq(contents.id, contentId)).run();
          break;
        }
      } catch (err: any) {
        console.warn(`[video-recover] Polling exception: ${err.message}`);
      }
    }

    activePolls.delete(contentId);
    console.log(`[video-recover] Task ${contentId} polling terminated.`);
  })();
}

export function resumeAllPendingVideoTasks() {
  console.log('🔍 [video-recover] Scanning for stuck processing video tasks...');
  try {
    const pendingTasks = db.select().from(contents)
      .where(and(eq(contents.status, 'processing'), eq(contents.type, 'video')))
      .all();
    console.log(`🔍 [video-recover] Found ${pendingTasks.length} pending video tasks to recover`);

    pendingTasks.forEach((record: any) => {
      const contentId = record.id;
      if (!activePolls.has(contentId)) {
        resumePollForTask(contentId, record);
      }
    });
  } catch (err: any) {
    console.error('⚠️ [video-recover] Scan pending tasks failed:', err.message);
  }
}

export default router;
