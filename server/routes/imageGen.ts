import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { tierMiddleware, TierRequest } from '../middleware/tier.js';
import { quotaMiddleware, logUsage } from '../middleware/quota.js';
import { PricingService } from '../services/pricingService.js';
import { ChannelService } from '../services/channelService.js';
import { BalanceService } from '../services/balanceService.js';
import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { models } from '../db/schema.js';
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

const DEFAULT_IMAGE_MODELS = [
  { id: 'grok-imagine-image', name: 'Grok Image', description: 'Grok AI 高质量图片生成', icon: '🎨' },
  { id: 'grok-imagine-image-lite', name: 'Grok Image Lite', description: '快速出图，适合草图和灵感', icon: '⚡' },
  { id: 'grok-imagine-image-pro', name: 'Grok Image Pro', description: '专业级高质量图片生成', icon: '💎' },
  { id: 'grok-imagine-image-edit', name: 'Grok Image Edit', description: '图片编辑与局部重绘', icon: '🖌️' },
];

/** 查找支持指定图片模型的渠道 */
function findImageChannel(modelId: string) {
  const channel = ChannelService.findChannelForModel(modelId);
  if (channel) return { baseUrl: channel.baseUrl, apiKey: channel.apiKey };
  if (env.GROK2API_BASE_URL) return { baseUrl: env.GROK2API_BASE_URL, apiKey: env.GROK2API_API_KEY };
  return null;
}

/** GET /api/image-gen/models — 可用的图片模型列表 */
router.get('/models', authMiddleware, (_req: Request, res: Response) => {
  // 从数据库动态拉取所有具备 'image' 能力的模型
  const dbModels = db.select().from(models).where(like(models.capabilities, '%"image"%')).all();

  // 如果数据库里还没配置，提供一个极简默认后备
  const sourceModels = dbModels.length > 0 
    ? dbModels.map(m => ({ id: m.modelId, name: m.displayName })) 
    : DEFAULT_IMAGE_MODELS;

  const result = sourceModels.map(m => {
    const preset = DEFAULT_IMAGE_MODELS.find(d => d.id === m.id);
    return {
      id: m.id,
      name: m.name || preset?.name || m.id,
      description: preset?.description || 'AI 图片生成服务',
      available: findImageChannel(m.id) !== null,
    };
  });

  res.json(result);
});

/** POST /api/image-gen/generate — 图片生成（支持多图 + 参考图） */
router.post('/generate', authMiddleware, tierMiddleware('generate_image'), quotaMiddleware, async (req: TierRequest, res: Response) => {
  const {
    prompt,
    model = 'grok-imagine-image',
    aspect_ratio = '1:1',
    n = 1,                       // 生成数量 1~4
    reference_images = [],       // base64 数据 URL 数组
  } = req.body;

  if (!prompt?.trim()) {
    return res.status(400).json({ error: '请输入图片描述' });
  }

  const count = Math.max(1, Math.min(4, Number(n) || 1));

  const channel = findImageChannel(model);
  if (!channel) {
    return res.status(503).json({ error: '未配置图片生成渠道。请在管理后台添加渠道或设置 GROK2API_BASE_URL。' });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (data: Record<string, any>) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
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
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  /** 生成完成后统一计费：按实际出图张数 × 单价，实际扣减用户余额 */
  const billUsage = (actualCount: number) => {
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
  };

  try {
    sendEvent({ type: 'status', message: hasRef ? '正在上传参考图并生成...' : `正在生成 ${count} 张图片...`, total: count });

    if (hasRef) {
      // ===== 有参考图：走 /v1/images/generations（同步 JSON 响应），原生支持 n =====
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 300_000);

      sendEvent({ type: 'progress', progress: 10, index: -1 });

      const upstreamUrl = baseUrl + '/v1/images/generations';
      const requestBody = {
        model,
        prompt: prompt.trim(),
        n: count,
        size,
        response_format: 'url',
        reference_images: reference_images.slice(0, 10),
      };

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

      sendEvent({ type: 'progress', progress: 80, index: -1 });

      const result = await upstream.json();
      const images = (result.data || []).map((item: any) => {
        const url = item?.url || '';
        return url.startsWith('/') ? baseUrl + url : url;
      }).filter(Boolean);

      if (images.length > 0) {
        // 逐张发送，前端可渐进渲染
        images.forEach((url: string, idx: number) => {
          sendEvent({ type: 'image_ready', imageUrl: url, index: idx, total: images.length });
        });
        sendEvent({ type: 'complete', imageUrls: images, total: images.length });
        billUsage(images.length);
      } else {
        sendEvent({ type: 'error', message: '图片生成完成但未获取到图片地址' });
      }

      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      // ===== 无参考图：并发 n 个独立的 chat/completions SSE 请求 =====
      const upstreamUrl = baseUrl + '/v1/chat/completions';
      const completedImages: string[] = new Array(count).fill('');
      let completedCount = 0;

      const runSingle = async (index: number) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 120_000);

        const requestBody = {
          model,
          messages: [{ role: 'user', content: prompt }],
          stream: true,
          image_config: { n: 1, size, response_format: 'url' },
        };

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
              if (!line.startsWith('data: ') || line === 'data: [DONE]') {
                if (line === 'data: [DONE]' && imageUrl) {
                  sendEvent({ type: 'image_ready', imageUrl, index, total: count });
                }
                continue;
              }

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
            completedImages[index] = imageUrl;
            if (!completedImages[index]) {
              sendEvent({ type: 'image_ready', imageUrl, index, total: count });
            }
            completedImages[index] = imageUrl;
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
            billUsage(allUrls.length);
            res.write('data: [DONE]\n\n');
            res.end();
          }
        }
      };

      // 并发启动所有请求
      for (let i = 0; i < count; i++) {
        runSingle(i);
      }
    }
  } catch (err: any) {
    const msg = err.name === 'AbortError' ? '图片生成超时' : (err.message || '请求失败');
    sendEvent({ type: 'error', message: msg });
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

export default router;
