import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { tierMiddleware, TierRequest } from '../middleware/tier.js';
import { quotaMiddleware, logUsage } from '../middleware/quota.js';
import { ChannelService } from '../services/channelService.js';
import { BalanceService } from '../services/balanceService.js';
import { ContentService } from '../services/contentService.js';
import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { models, settings } from '../db/schema.js';
import { eq, like } from 'drizzle-orm';

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

const DEFAULT_VIDEO_MODELS = [
  { id: 'grok-imagine-video', name: 'Grok Video', description: 'Grok AI 视频生成，支持 6-30s', maxSeconds: 30, icon: '🎬' },
  { id: 'grok-4.3-video', name: 'Grok 4.3 Video', description: 'Grok 4.3 高级视频生成', maxSeconds: 30, icon: '🎥' },
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

  const result = sourceModels.map(m => {
    const preset = DEFAULT_VIDEO_MODELS.find(d => d.id === m.id);
    return {
      id: m.id,
      name: m.name || preset?.name || m.id,
      description: preset?.description || 'AI 视频生成服务',
      available: findVideoChannel(m.id) !== null,
    };
  });

  res.json(result);
});

/** POST /api/video/generate — SSE 流式视频生成（异步轮询模式） */
router.post('/generate', authMiddleware, tierMiddleware('generate_image'), quotaMiddleware, async (req: TierRequest, res: Response) => {
  const {
    prompt,
    model = 'grok-imagine-video',
    aspect_ratio = '16:9',
    video_length = 6,
    resolution = '720p',
    reference_images = [],   // base64 dataURL 数组
  } = req.body;

  if (!prompt?.trim()) {
    return res.status(400).json({ error: '请输入视频描述' });
  }

  const channel = findVideoChannel(model);
  if (!channel) {
    return res.status(503).json({ error: '未配置视频生成渠道。请在管理后台添加渠道或设置 GROK2API_BASE_URL。' });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (data: Record<string, any>) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const startTime = Date.now();

  // 视频计费费率
  const rate480 = db.select().from(settings).where(eq(settings.key, 'video_rate_480p')).get();
  const rate720 = db.select().from(settings).where(eq(settings.key, 'video_rate_720p')).get();
  const VIDEO_RATE: Record<string, number> = {
    '480p': parseFloat(rate480?.value || '0.03'),
    '720p': parseFloat(rate720?.value || '0.05'),
  };

  // 预估费用并检查余额
  const estimatedRate = VIDEO_RATE[resolution] || VIDEO_RATE['720p'];
  const estimatedSeconds = Number(video_length) || 6;
  const estimatedCost = Math.round(estimatedRate * estimatedSeconds * 100) / 100;
  const { sufficient, balance: currentBalance } = BalanceService.checkBalance(req.userId!, estimatedCost);
  if (!sufficient) {
    sendEvent({ type: 'error', message: `余额不足，预估费用 ¥${estimatedCost.toFixed(2)}，当前余额 ¥${currentBalance.toFixed(2)}` });
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  /** 生成成功后计费 + 保存内容 */
  const billUsage = (finalVideoUrl: string) => {
    const elapsed = Date.now() - startTime;
    logUsage(req.userId!, 'generate_video', undefined, elapsed);
    const rate = VIDEO_RATE[resolution] || VIDEO_RATE['720p'];
    const seconds = Number(video_length) || 6;
    const cost = Math.round(rate * seconds * 100) / 100;
    if (cost > 0) {
      const remaining = BalanceService.deduct(req.userId!, cost, 'generate_video');
      sendEvent({ type: 'billing', cost, resolution, seconds, rate, remainingBalance: remaining ?? 0 });
    }
    try {
      ContentService.save({
        userId: req.userId!,
        orgId: req.orgId || null,
        type: 'video',
        title: (prompt as string).slice(0, 200),
        inputText: (prompt as string).slice(0, 500),
        resultUrl: finalVideoUrl || undefined,
        modelId: model,
        cost,
        metadata: { resolution, seconds, aspect_ratio },
      });
    } catch (e) { console.error('[content] 视频保存失败:', e); }
  };

  const baseUrl = channel.baseUrl.replace(/\/+$/, '');
  const size = RATIO_TO_SIZE[aspect_ratio] || '1280x720';
  const hasRef = Array.isArray(reference_images) && reference_images.length > 0;

  try {
    // ━━━ Step 1: 创建视频任务（multipart/form-data） ━━━
    sendEvent({ type: 'status', message: hasRef ? '正在上传参考图并提交任务...' : '正在提交视频生成任务...' });

    const formData = new FormData();
    formData.append('model', model);
    formData.append('prompt', prompt.trim());
    formData.append('seconds', String(video_length));
    formData.append('size', size);
    formData.append('resolution_name', resolution);

    // 参考图：将 base64 dataURL 转为 Blob 文件上传
    if (hasRef) {
      for (let i = 0; i < Math.min(reference_images.length, 5); i++) {
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
    const videoId = job.id;
    console.log(`[video] 任务已创建: id=${videoId} status=${job.status}`);
    sendEvent({ type: 'status', message: `任务已提交，等待生成... (${videoId})` });

    if (!videoId) {
      sendEvent({ type: 'error', message: '上游未返回任务 ID' });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // ━━━ Step 2: 轮询任务状态 ━━━
    const maxPollTime = Math.max(300_000, Math.ceil(video_length / 10) * 180_000); // 最长轮询时间
    const pollInterval = 5000; // 5 秒轮询
    const pollStart = Date.now();

    while (Date.now() - pollStart < maxPollTime) {
      await new Promise(r => setTimeout(r, pollInterval));

      // 检查客户端是否断开
      if (res.writableEnded || res.destroyed) {
        console.log(`[video] 客户端已断开，停止轮询`);
        return;
      }

      try {
        const pollResp = await fetch(`${baseUrl}/v1/videos/${videoId}`, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });

        if (!pollResp.ok) {
          console.warn(`[video] 轮询返回 ${pollResp.status}`);
          continue;
        }

        const status = await pollResp.json() as any;
        const progress = status.progress || 0;

        console.log(`[video] 轮询: status=${status.status} progress=${progress}%`);

        if (status.status === 'processing' || status.status === 'queued') {
          sendEvent({ type: 'progress', progress });
          sendEvent({ type: 'status', message: `视频生成中 ${progress}%` });
        } else if (status.status === 'completed') {
          // ━━━ Step 3: 生成完成 ━━━
          const videoUrl = status.url || `${baseUrl}/v1/files/video?id=${videoId}`;
          console.log(`[video] ✅ 生成完成: ${videoUrl}`);
          sendEvent({ type: 'progress', progress: 100 });
          sendEvent({ type: 'complete', videoUrl });
          billUsage(videoUrl);
          res.write('data: [DONE]\n\n');
          return res.end();
        } else if (status.status === 'failed') {
          const errMsg = status.error?.message || '视频生成失败';
          console.error(`[video] ❌ 生成失败: ${errMsg}`);
          sendEvent({ type: 'error', message: errMsg });
          res.write('data: [DONE]\n\n');
          return res.end();
        }
      } catch (pollErr: any) {
        console.warn(`[video] 轮询异常: ${pollErr.message}`);
        // 轮询失败不立即退出，继续重试
      }
    }

    // 超时
    sendEvent({ type: 'error', message: `视频生成超时（${Math.ceil(maxPollTime / 60000)}分钟）` });
    res.write('data: [DONE]\n\n');
    res.end();

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
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });
  } catch (err: any) {
    // 清理
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    console.error('[video/merge]', err.message);
    res.status(500).json({ error: err.message || '合并失败' });
  }
});

export default router;
