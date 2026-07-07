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
import { eq, like } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';

const router = Router();

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
    const ext = mimeType.split('/')[1] || 'jpg';
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
  'sora-v4-fast': { series: 'sora-v4-fast', allowedSeconds: [10, 15], requireRef: false },
};

const DEFAULT_VIDEO_MODELS = [
  { id: 'grok-imagine-video-1.5-preview', name: 'Grok 1.5 Preview', description: '图生视频，必须提供参考图，6/10秒', maxSeconds: 10, icon: '🖼️' },
  { id: 'grok-imagine-1.0-video', name: 'Grok 1.0 Video', description: '文生/图生视频，6/10秒', maxSeconds: 10, icon: '🎥' },
  { id: 'grok-imagine-video-1.5-fast', name: 'Grok 1.5 Fast', description: '快速文生/图生视频，6/10秒', maxSeconds: 10, icon: '⚡' },
  { id: 'omni-flash', name: 'Omni Flash', description: '多参考图生成/纯文生视频，4/6/8/10秒，支持 1080p', maxSeconds: 10, icon: '⚡' },
  { id: 'omni-flash-vref', name: 'Omni Flash Vref', description: '视频风格编辑/改写，支持 1080p', maxSeconds: 10, icon: '✂️' },
  { id: 'sora-v4-fast', name: 'Seedance 2.0 Fast', description: 'Seedance 2.0 Fast，10/15秒，支持4图3视频1音频', maxSeconds: 15, icon: '⚡' },
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
  // 从数据库动态拉取所有具备 'video' 能力的模型
  const dbModels = db.select().from(models).where(like(models.capabilities, '%"video"%')).all();

  // 如果数据库里还没配置视频模型，提供一个极简默认后备
  const sourceModels = dbModels.length > 0
    ? dbModels.map(m => ({ id: m.modelId, name: m.displayName }))
    : DEFAULT_VIDEO_MODELS;

  const rate480 = db.select().from(settings).where(eq(settings.key, 'video_rate_480p')).get();
  const rate720 = db.select().from(settings).where(eq(settings.key, 'video_rate_720p')).get();
  const base480 = parseFloat(rate480?.value || '0.03');
  const base720 = parseFloat(rate720?.value || '0.05');

  const omniFlash720 = parseFloat(db.select().from(settings).where(eq(settings.key, 'omni_flash_rate_720p')).get()?.value || '0.90');
  const omniFlash1080 = parseFloat(db.select().from(settings).where(eq(settings.key, 'omni_flash_rate_1080p')).get()?.value || '1.50');
  const omniVref720 = parseFloat(db.select().from(settings).where(eq(settings.key, 'omni_vref_rate_720p')).get()?.value || '1.60');
  const omniVref1080 = parseFloat(db.select().from(settings).where(eq(settings.key, 'omni_vref_rate_1080p')).get()?.value || '2.20');

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
    } else if (m.id === 'sora-v4-fast') {
      const row = db.select().from(settings).where(eq(settings.key, 'sora_v4_rate_720p')).get();
      rates = { '720p': parseFloat(row?.value || '1.50') };
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

  res.json(result);
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
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
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
  } else if (model === 'sora-v4-fast') {
    const row = db.select().from(settings).where(eq(settings.key, 'sora_v4_rate_720p')).get();
    rate = parseFloat(row?.value || '1.50');
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
  const estimatedRate = rate;
  const estimatedSeconds = model === 'omni-flash-vref' ? 10 : (Number(video_length) || 6);
  const estimatedCost = Math.round(estimatedRate * estimatedSeconds * 100) / 100;
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
  } catch (e) {
    console.error('[content] 初始视频记录保存失败:', e);
  }

  /** 生成成功后计费 + 更新内容 */
  const billUsage = (finalVideoUrl: string) => {
    const elapsed = Date.now() - startTime;
    logUsage(req.userId!, 'generate_video', undefined, elapsed);
    const cost = Math.round(rate * estimatedSeconds * 100) / 100;
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
  const isSoraV4 = model === 'sora-v4-fast';

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
    } else if (isSoraV4) {
      sendEvent({ type: 'status', message: '正在上传多模态素材并提交任务...' });

      // Convert images (up to 4) to public URLs
      const referenceImagesUrls = reference_images
        ? reference_images.slice(0, 4).map((img: string, idx: number) => convertBase64ToPublicUrl(img, `sora_img_${idx}`, req))
        : [];

      // Convert reference video to public URL
      const referenceVideoUrl = reference_video ? convertBase64ToPublicUrl(reference_video, 'sora_vid', req) : undefined;

      // Convert reference audio (audio_url) to public URL
      const referenceAudioUrl = audio_url ? convertBase64ToPublicUrl(audio_url, 'sora_aud', req) : undefined;

      const payload: Record<string, any> = {
        model: upstreamModel,
        prompt: prompt.trim(),
        duration: Number(video_length) || 5,
        video_config: {
          aspect_ratio: aspect_ratio,
          resolution_name: resolution
        },
        reference_images: referenceImagesUrls.length > 0 ? referenceImagesUrls : undefined,
      };

      if (referenceVideoUrl) {
        payload.reference_video = referenceVideoUrl;
        payload.reference_videos = [referenceVideoUrl];
      }
      if (referenceAudioUrl) {
        payload.audio_url = referenceAudioUrl;
      }

      console.log(`[video] Step1 SoraV4 创建任务: model=${model} duration=${payload.duration} resolution=${resolution}`);

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
      videoId = job.id;
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

    if (!videoId) {
      sendEvent({ type: 'error', message: '上游未返回任务 ID' });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // ━━━ Step 2: 轮询任务状态 ━━━
    const maxPollTime = Math.max(300_000, Math.ceil(estimatedSeconds / 10) * 180_000); // 最长轮询时间
    const pollInterval = 5000; // 5 秒轮询
    const pollStart = Date.now();

    const headers: Record<string, string> = {};
    if (channel.apiKey) headers['Authorization'] = `Bearer ${channel.apiKey}`;

    while (Date.now() - pollStart < maxPollTime) {
      await new Promise(r => setTimeout(r, pollInterval));

      // 检查客户端是否断开仅进行日志记录，不终止后台轮询以完成计费和数据库更新
      if (res.writableEnded || res.destroyed) {
        console.log(`[video] 客户端已断开，后台继续轮询任务 ${videoId}...`);
      }

      try {
        let pollUrl = `${baseUrl}/v1/videos/${videoId}`;
        if (isOmni) {
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

        if (isOmni) {
          const dataBlock = status.data || {};
          taskStatus = (dataBlock.status || status.status || '').toLowerCase();

          const progressStr = dataBlock.progress || status.progress || '0%';
          progress = parseInt(progressStr) || 0;

          if (taskStatus === 'success' || taskStatus === 'completed') {
            resultUrl = dataBlock.result_url || (dataBlock.data && dataBlock.data.url) || status.result_url || status.url;
          } else if (taskStatus === 'failure' || taskStatus === 'failed') {
            errMsg = dataBlock.fail_reason || dataBlock.error || '视频生成失败';
          }
        } else {
          taskStatus = (status.status || '').toLowerCase();
          if (taskStatus === 'completed' || taskStatus === 'success') {
            resultUrl = status.url || status.video_url || status.result_url || `${baseUrl}/v1/files/video?id=${videoId}`;
          } else if (taskStatus === 'failed' || taskStatus === 'failure') {
            errMsg = status.error?.message || '视频生成失败';
          }
        }

        console.log(`[video] 轮询 (${isOmni ? 'Omni' : 'Grok'}): status=${taskStatus} progress=${progress}%`);

        if (taskStatus === 'processing' || taskStatus === 'queued' || taskStatus === 'pending') {
          sendEvent({ type: 'progress', progress });
          sendEvent({ type: 'status', message: `视频生成中 ${progress}%` });
        } else if (taskStatus === 'completed' || taskStatus === 'success') {
          console.log(`[video] ✅ 生成完成: ${resultUrl}`);
          sendEvent({ type: 'progress', progress: 100 });
          sendEvent({ type: 'complete', videoUrl: resultUrl });
          billUsage(resultUrl);
          if (!res.destroyed && !res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
          }
          return;
        } else if (taskStatus === 'failed' || taskStatus === 'failure') {
          console.error(`[video] ❌ 生成失败: ${errMsg}`);
          sendEvent({ type: 'error', message: errMsg });
          if (contentId !== null) {
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

    // 超时
    sendEvent({ type: 'error', message: `视频生成超时（${Math.ceil(maxPollTime / 60000)}分钟）` });
    if (contentId !== null) {
      try {
        db.update(contents).set({ status: 'failed' }).where(eq(contents.id, contentId)).run();
      } catch (dbErr) { console.error('[video] 超时状态更新错误:', dbErr); }
    }
    if (!res.destroyed && !res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
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

export default router;
