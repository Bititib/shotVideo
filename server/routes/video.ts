import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { tierMiddleware, TierRequest } from '../middleware/tier.js';
import { quotaMiddleware, logUsage } from '../middleware/quota.js';
import { ChannelService } from '../services/channelService.js';
import { BalanceService } from '../services/balanceService.js';
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

/** GET /api/video/models — 可用的视频模型列表 */
router.get('/models', authMiddleware, (_req: Request, res: Response) => {
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

/** POST /api/video/generate — SSE 流式视频生成 */
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

  // 视频计费费率：从 settings 表读取，管理后台可动态调整
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

  /** 生成成功后计费：按 分辨率 × 秒数，实际扣减用户余额 */
  const billUsage = () => {
    const elapsed = Date.now() - startTime;
    logUsage(req.userId!, 'generate_video', undefined, elapsed);
    const rate = VIDEO_RATE[resolution] || VIDEO_RATE['720p'];
    const seconds = Number(video_length) || 6;
    const cost = Math.round(rate * seconds * 100) / 100;
    if (cost > 0) {
      const remaining = BalanceService.deduct(req.userId!, cost, 'generate_video');
      sendEvent({ type: 'billing', cost, resolution, seconds, rate, remainingBalance: remaining ?? 0 });
    }
  };

  const upstreamUrl = channel.baseUrl.replace(/\/+$/, '') + '/v1/chat/completions';
  const size = RATIO_TO_SIZE[aspect_ratio] || '1280x720';

  // 有参考图时构建多模态 content（image_url + text）
  const hasRef = Array.isArray(reference_images) && reference_images.length > 0;
  let messageContent: any = prompt;
  if (hasRef) {
    messageContent = [
      ...reference_images.slice(0, 10).map((img: string) => ({
        type: 'image_url',
        image_url: { url: img },
      })),
      { type: 'text', text: prompt },
    ];
  }

  const requestBody = {
    model,
    messages: [{ role: 'user', content: messageContent }],
    stream: true,
    video_config: { seconds: video_length, size, resolution_name: resolution },
  };

  try {
    const controller = new AbortController();
    // 根据视频时长动态调整超时：每 10 秒视频给 3 分钟
    const timeoutMs = Math.max(300_000, Math.ceil(video_length / 10) * 180_000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (channel.apiKey) headers['Authorization'] = `Bearer ${channel.apiKey}`;

    console.log(`[video] 开始生成: model=${model} seconds=${video_length} timeout=${timeoutMs/1000}s url=${upstreamUrl}`);
    sendEvent({ type: 'status', message: '正在连接视频生成服务...' });

    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      sendEvent({ type: 'error', message: `上游服务返回 ${upstream.status}: ${errText.slice(0, 200)}` });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    const reader = upstream.body?.getReader();
    if (!reader) {
      sendEvent({ type: 'error', message: '上游无响应体' });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let videoUrl = '';
    let lastProgress = -1;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') {
          if (line === 'data: [DONE]') {
            if (videoUrl) {
              sendEvent({ type: 'complete', videoUrl });
              billUsage();
            }
            else sendEvent({ type: 'error', message: '视频生成完成但未获取到视频地址' });
          }
          continue;
        }

        try {
          const data = JSON.parse(line.slice(6));
          const delta = data.choices?.[0]?.delta || {};
          const msg = data.choices?.[0]?.message || {};

          // 提取进度（reasoning_content 中的百分比）
          const reasoning = delta.reasoning_content || '';
          if (reasoning) {
            const m = reasoning.match(/(\d+)%/);
            if (m) {
              const p = parseInt(m[1]);
              if (p !== lastProgress) {
                lastProgress = p;
                sendEvent({ type: 'progress', progress: p });
              }
            }
          }

          // 提取视频 URL（content 中的链接）
          const content = delta.content || msg.content || '';
          if (content) {
            // 匹配 URL
            const urlMatch = content.match(/https?:\/\/[^\s"'<>]+/);
            if (urlMatch) videoUrl = urlMatch[0];
            // 匹配 <video> 标签中的 src
            const srcMatch = content.match(/src="([^"]+)"/);
            if (srcMatch) videoUrl = srcMatch[1];
            // 匹配 /v1/files/video 路径
            const localMatch = content.match(/(\/v1\/files\/video[^\s"'<>]*)/);
            if (localMatch) {
              videoUrl = channel.baseUrl.replace(/\/+$/, '') + localMatch[1];
            }
          }
        } catch { /* ignore parse errors */ }
      }
    }

    // 流结束后兜底
    if (videoUrl && lastProgress < 100) {
      sendEvent({ type: 'complete', videoUrl });
      billUsage();
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err: any) {
    console.error(`[video] 生成失败:`, err.name, err.message, err.cause?.message || '');
    const msg = err.name === 'AbortError'
      ? `视频生成超时（${Math.ceil(video_length / 10) * 3}分钟）`
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
