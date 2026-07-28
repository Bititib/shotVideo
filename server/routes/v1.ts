import { Router, Request, Response } from 'express';
import { TokenService } from '../services/tokenService.js';
import { ChannelService } from '../services/channelService.js';
import { PricingService } from '../services/pricingService.js';
import { BalanceService } from '../services/balanceService.js';
import { db } from '../db/index.js';
import { apiLogs, settings, models } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { env } from '../config/env.js';

const router = Router();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 150 * 1024 * 1024 } });

/** 从请求头中提取 Bearer Token */
function extractToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7).trim();
}

/** 检查 Token 或关联用户的余额 */
function checkTokenOrUserBalance(token: any, cost: number): { sufficient: boolean; balance: number } {
  if (cost <= 0) return { sufficient: true, balance: 0 };
  if (token.balance === -1) {
    if (token.userId) {
      const check = BalanceService.checkBalance(token.userId, cost);
      return { sufficient: check.sufficient, balance: check.balance };
    }
    return { sufficient: true, balance: 999999 };
  }
  return { sufficient: token.balance >= cost, balance: token.balance };
}

/** 扣除 Token 或关联用户的余额 */
function deductTokenOrUserBalance(token: any, cost: number, model: string) {
  if (cost <= 0) return;
  if (token.balance === -1) {
    if (token.userId) {
      BalanceService.deduct(token.userId, cost, 'api_call', { tokenKey: token.tokenKey, model });
    }
    TokenService.deductBalance(token.id, cost);
  } else {
    TokenService.deductBalance(token.id, cost);
  }
}

/** 获取视频计费费率 */
function getVideoRate(model: string, resolution: string): number {
  if (model === 'omni-flash') {
    const key = resolution === '1080p' ? 'omni_flash_rate_1080p' : 'omni_flash_rate_720p';
    const row = db.select().from(settings).where(eq(settings.key, key)).get();
    return parseFloat(row?.value || (resolution === '1080p' ? '1.50' : '0.90'));
  } else if (model === 'omni-flash-vref') {
    const key = resolution === '1080p' ? 'omni_vref_rate_1080p' : 'omni_vref_rate_720p';
    const row = db.select().from(settings).where(eq(settings.key, key)).get();
    return parseFloat(row?.value || (resolution === '1080p' ? '2.20' : '1.60'));
  } else if (model === 'sdas-xh-sd2.0-933-3-pro-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_xh_sd20_933_3_pro_720p_rate')).get();
    return parseFloat(row?.value || '4.50');
  } else if (model === 'sd2-c6') {
    const row = db.select().from(settings).where(eq(settings.key, 'sd2_c6_rate')).get();
    return parseFloat(row?.value || '2.50');
  } else if (model === 'sora-v4-fast' || model === 'seedance-2.0-fast') {
    const row = db.select().from(settings).where(eq(settings.key, 'sora_v4_fast_rate')).get();
    return parseFloat(row?.value || '0.189');
  } else if (model === 'sora-v4-pro' || model === 'seedance-2.0') {
    const row = db.select().from(settings).where(eq(settings.key, 'sora_v4_pro_rate')).get();
    return parseFloat(row?.value || '0.25');
  } else if (model === 'seedance-720') {
    const row = db.select().from(settings).where(eq(settings.key, 'seedance_720_rate')).get();
    return parseFloat(row?.value || '3.00');
  } else {
    const rate480 = db.select().from(settings).where(eq(settings.key, 'video_rate_480p')).get();
    const rate720 = db.select().from(settings).where(eq(settings.key, 'video_rate_720p')).get();
    const BASE_RATE: Record<string, number> = {
      '480p': parseFloat(rate480?.value || '0.03'),
      '720p': parseFloat(rate720?.value || '0.05'),
    };
    const isV1_5 = model.includes('1.5');
    const seriesMultiplier = isV1_5 ? 1.2 : 1.0;
    return Math.round((BASE_RATE[resolution] || BASE_RATE['720p']) * seriesMultiplier * 100) / 100;
  }
}

/** 查找视频中转渠道配置 */
function findUpstreamVideoConfig() {
  let ch = ChannelService.findChannelForModel('grok-imagine-video');
  if (!ch) ch = ChannelService.findChannelForModel('omni-flash');
  if (!ch) {
    const active = ChannelService.getActiveChannels();
    ch = active.find(c => c.supportedModels.includes('video') || c.supportedModels.includes('*'));
  }
  if (ch) return { baseUrl: ch.baseUrl, apiKey: ch.apiKey };
  if (env.GROK2API_BASE_URL) return { baseUrl: env.GROK2API_BASE_URL, apiKey: env.GROK2API_API_KEY };
  return null;
}

/** 清理 Multer 临时文件 */
function cleanupFiles(files: any) {
  if (Array.isArray(files)) {
    for (const f of files) {
      try { fs.unlinkSync(f.path); } catch { }
    }
  }
}

/** 重写视频 URL 指向本地代理接口 */
function rewriteVideoUrl(urlStr: string, req: Request, id: string): string {
  if (!urlStr) return urlStr;
  const host = req.get('host');
  const protocol = req.protocol;
  return `${protocol}://${host}/v1/files/video?id=${id}`;
}

/** GET /v1/models — 返回当前 Token 可用的模型列表 */
router.get('/models', (req: Request, res: Response) => {
  const tokenKey = extractToken(req);
  if (!tokenKey) return res.status(401).json({ error: { message: 'Missing API key', type: 'invalid_request_error' } });

  const { valid, error, token } = TokenService.validateToken(tokenKey);
  if (!valid) return res.status(401).json({ error: { message: error, type: 'invalid_request_error' } });

  const allModels = new Set<string>();

  // 0. 获取所有在数据库中被禁用的模型 ID，用作过滤
  const disabledModelIds = new Set<string>();
  try {
    const inactive = db.select().from(models).where(eq(models.isActive, 0)).all();
    inactive.forEach(m => disabledModelIds.add(m.modelId));
  } catch { }

  // 1. 默认内置的所有视频模型（包括 sora-v4-fast，过滤已禁用的）
  const defaultVideoModels = [
    'grok-imagine-video',
    'grok-4.3-video',
    'grok-imagine-video-1.5-preview',
    'grok-imagine-1.0-video',
    'grok-imagine-video-1.5-fast',
    'grok-imagine-video-1.5-1080p',
    'omni-flash',
    'omni-flash-vref',
    'sora-v4-fast',
    'sora-v4-pro',
    'lg-seedance-2.0-fast',
    'sdas-d7-seedance-2.0-face-720p',
    'sdas-mo-seedance-2.0-dj-fast',
    'sdas-wf-sd2.0-fast-933-720p',
    'sdas-wf-sd2.0-pro-933-480p',
    'sdas-pg-s2.0-fast'
  ];
  defaultVideoModels.forEach(m => {
    if (!disabledModelIds.has(m)) allModels.add(m);
  });

  // 2. 数据库注册的模型（仅包含启用的模型）
  try {
    const dbModels = db.select().from(models).where(eq(models.isActive, 1)).all();
    dbModels.forEach(m => allModels.add(m.modelId));
  } catch (e) {
    console.error('[v1/models] 数据库模型读取失败:', e);
  }

  // 3. 启用渠道自定义支持的模型
  try {
    const activeChannels = ChannelService.getActiveChannels();
    for (const ch of activeChannels) {
      for (const m of ch.supportedModels) {
        if (m !== '*') allModels.add(m);
      }
    }
  } catch (e) {
    console.error('[v1/models] 渠道自定义模型读取失败:', e);
  }

  let modelList = Array.from(allModels);
  if (token.allowedModels.length > 0) {
    modelList = modelList.filter(m => token.allowedModels.includes(m));
  }

  res.json({
    object: 'list',
    data: modelList.map(id => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'system',
    })),
  });
});

/** GET /v1/billing/balance — 余额查询 */
router.get('/billing/balance', (req: Request, res: Response) => {
  const tokenKey = extractToken(req);
  if (!tokenKey) return res.status(401).json({ error: { message: 'Missing API key', type: 'invalid_request_error' } });

  const { valid, error, token } = TokenService.validateToken(tokenKey);
  if (!valid) return res.status(401).json({ error: { message: error, type: 'invalid_request_error' } });

  let balance = token.balance;
  if (balance === -1 && token.userId) {
    const check = BalanceService.checkBalance(token.userId, 0.01);
    balance = check.balance;
  }

  res.json({
    billing: true,
    key_name: token.name || 'API Token',
    balance: balance === -1 ? 999999 : balance,
    total_charged: token.usedAmount,
    status: token.status === 1 ? 'active' : 'disabled',
    group: 'default',
    is_admin: false
  });
});

/** POST /v1/chat/completions — 核心对话代理转发 */
router.post('/chat/completions', async (req: Request, res: Response) => {
  const startTime = Date.now();
  const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || '';

  const tokenKey = extractToken(req);
  if (!tokenKey) return res.status(401).json({ error: { message: 'Missing API key', type: 'invalid_request_error' } });

  const { valid, error, token } = TokenService.validateToken(tokenKey);
  if (!valid) return res.status(401).json({ error: { message: error, type: 'invalid_request_error' } });

  const { model, messages, stream = false, ...otherParams } = req.body;
  if (!model) return res.status(400).json({ error: { message: 'model is required', type: 'invalid_request_error' } });
  if (!messages) return res.status(400).json({ error: { message: 'messages is required', type: 'invalid_request_error' } });

  if (token.allowedModels.length > 0 && !token.allowedModels.includes(model)) {
    return res.status(403).json({ error: { message: `Token has no access to model ${model}`, type: 'permission_error' } });
  }

  // 检查余额 (预扣 0.01 元以验证有效性)
  const { sufficient, balance: currentBalance } = checkTokenOrUserBalance(token, 0.01);
  if (!sufficient) {
    return res.status(402).json({ error: { message: `Insufficient balance. Current: ¥${currentBalance.toFixed(2)}`, type: 'insufficient_balance_error' } });
  }

  const channel = ChannelService.findChannelForModel(model);
  if (!channel) {
    return res.status(404).json({ error: { message: `No available channel for model ${model}`, type: 'not_found_error' } });
  }

  const upstreamModel = channel.modelMapping[model] || model;
  const upstreamUrl = channel.baseUrl.replace(/\/+$/, '') + '/v1/chat/completions';
  const upstreamBody = JSON.stringify({
    model: upstreamModel,
    messages,
    stream,
    ...otherParams,
  });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), channel.timeout || 120000);

    const upstreamRes = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${channel.apiKey}`,
      },
      body: upstreamBody,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!upstreamRes.ok) {
      const errBody = await upstreamRes.text();
      const durationMs = Date.now() - startTime;

      db.insert(apiLogs).values({
        tokenId: token.id, channelId: channel.id, model, upstreamModel,
        durationMs, status: 'error', errorMessage: `HTTP ${upstreamRes.status}: ${errBody.slice(0, 500)}`, clientIp,
      }).run();

      return res.status(upstreamRes.status).json(JSON.parse(errBody));
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const reader = upstreamRes.body?.getReader();
      if (!reader) return res.status(500).json({ error: { message: 'No response body', type: 'server_error' } });

      const decoder = new TextDecoder();
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          res.write(chunk);

          const lines = chunk.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.usage) {
                  totalPromptTokens = data.usage.prompt_tokens || 0;
                  totalCompletionTokens = data.usage.completion_tokens || 0;
                }
              } catch { }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      res.end();

      const cost = PricingService.calculateCost(model, totalPromptTokens, totalCompletionTokens);
      deductTokenOrUserBalance(token, cost, model);

      db.insert(apiLogs).values({
        tokenId: token.id, channelId: channel.id, model, upstreamModel,
        promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens,
        totalTokens: totalPromptTokens + totalCompletionTokens,
        cost, durationMs: Date.now() - startTime, status: 'success', clientIp,
      }).run();
      return;
    }

    const responseBody = await upstreamRes.json();
    const durationMs = Date.now() - startTime;

    const promptTokens = responseBody.usage?.prompt_tokens || 0;
    const completionTokens = responseBody.usage?.completion_tokens || 0;
    const totalTokens = responseBody.usage?.total_tokens || promptTokens + completionTokens;

    const cost = PricingService.calculateCost(model, promptTokens, completionTokens);
    deductTokenOrUserBalance(token, cost, model);

    db.insert(apiLogs).values({
      tokenId: token.id, channelId: channel.id, model, upstreamModel,
      promptTokens, completionTokens, totalTokens,
      cost, durationMs, status: 'success', clientIp,
    }).run();

    res.json(responseBody);
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err.name === 'AbortError' ? 'upstream timeout' : err.message;

    db.insert(apiLogs).values({
      tokenId: token.id, channelId: channel.id, model, upstreamModel,
      durationMs, status: 'error', errorMessage, clientIp,
    }).run();

    res.status(502).json({ error: { message: `Upstream error: ${errorMessage}`, type: 'server_error' } });
  }
});

/** POST /v1/images/generations — 图片生成代理转发 */
router.post('/images/generations', async (req: Request, res: Response) => {
  const startTime = Date.now();
  const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || '';

  const tokenKey = extractToken(req);
  if (!tokenKey) return res.status(401).json({ error: { message: 'Missing API key', type: 'invalid_request_error' } });

  const { valid, error, token } = TokenService.validateToken(tokenKey);
  if (!valid) return res.status(401).json({ error: { message: error, type: 'invalid_request_error' } });

  const { model, prompt, n = 1, size = '1024x1024', response_format = 'url', ...otherParams } = req.body;
  if (!model) return res.status(400).json({ error: { message: 'model is required', type: 'invalid_request_error' } });
  if (!prompt) return res.status(400).json({ error: { message: 'prompt is required', type: 'invalid_request_error' } });

  if (token.allowedModels.length > 0 && !token.allowedModels.includes(model)) {
    return res.status(403).json({ error: { message: `Token has no access to model ${model}`, type: 'permission_error' } });
  }

  const channel = ChannelService.findChannelForModel(model);
  if (!channel) {
    return res.status(404).json({ error: { message: `No available channel for model ${model}`, type: 'not_found_error' } });
  }

  const count = Math.max(1, Number(n) || 1);
  const unitCost = PricingService.calculateCost(model, 0, 0);
  const totalCost = Math.round(unitCost * count * 100) / 100;

  const { sufficient, balance: currentBalance } = checkTokenOrUserBalance(token, totalCost);
  if (!sufficient) {
    return res.status(402).json({ error: { message: `Insufficient balance. Required: ¥${totalCost.toFixed(2)}, Current: ¥${currentBalance.toFixed(2)}`, type: 'insufficient_balance_error' } });
  }

  const upstreamModel = channel.modelMapping[model] || model;
  const baseUrl = channel.baseUrl.replace(/\/+$/, '');
  const upstreamUrl = `${baseUrl}/v1/images/generations`;

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${channel.apiKey}`,
      },
      body: JSON.stringify({
        model: upstreamModel,
        prompt,
        n,
        size,
        response_format,
        ...otherParams,
      }),
      signal: AbortSignal.timeout(180_000),
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      const durationMs = Date.now() - startTime;
      db.insert(apiLogs).values({
        tokenId: token.id, channelId: channel.id, model, upstreamModel,
        durationMs, status: 'error', errorMessage: `HTTP ${upstreamRes.status}: ${errText.slice(0, 500)}`, clientIp,
      }).run();
      return res.status(upstreamRes.status).json({ error: { message: `Upstream error: ${errText}`, type: 'upstream_error' } });
    }

    const responseBody = await upstreamRes.json() as any;
    const durationMs = Date.now() - startTime;

    deductTokenOrUserBalance(token, totalCost, model);

    db.insert(apiLogs).values({
      tokenId: token.id, channelId: channel.id, model, upstreamModel,
      cost: totalCost, durationMs: durationMs, status: 'success', clientIp,
    }).run();

    // 补全相对路径
    if (responseBody.data && Array.isArray(responseBody.data)) {
      responseBody.data = responseBody.data.map((item: any) => {
        if (item.url && item.url.startsWith('/')) {
          return { ...item, url: baseUrl + item.url };
        }
        return item;
      });
    }

    res.json(responseBody);
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err.name === 'AbortError' ? 'upstream timeout' : err.message;
    db.insert(apiLogs).values({
      tokenId: token.id, channelId: channel.id, model, upstreamModel,
      durationMs, status: 'error', errorMessage, clientIp,
    }).run();
    res.status(502).json({ error: { message: `Upstream error: ${errorMessage}`, type: 'server_error' } });
  }
});

/** POST /v1/images/edits — 图像编辑与图生图代理转发 */
router.post('/images/edits', upload.any(), async (req: Request, res: Response) => {
  const startTime = Date.now();
  const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || '';

  const tokenKey = extractToken(req);
  if (!tokenKey) {
    cleanupFiles(req.files);
    return res.status(401).json({ error: { message: 'Missing API key', type: 'invalid_request_error' } });
  }

  const { valid, error, token } = TokenService.validateToken(tokenKey);
  if (!valid) {
    cleanupFiles(req.files);
    return res.status(401).json({ error: { message: error, type: 'invalid_request_error' } });
  }

  const { model, prompt, n = 1, size = '1024x1024', response_format = 'url', ...otherParams } = req.body;
  if (!model) {
    cleanupFiles(req.files);
    return res.status(400).json({ error: { message: 'model is required', type: 'invalid_request_error' } });
  }
  if (!prompt) {
    cleanupFiles(req.files);
    return res.status(400).json({ error: { message: 'prompt is required', type: 'invalid_request_error' } });
  }

  if (token.allowedModels.length > 0 && !token.allowedModels.includes(model)) {
    cleanupFiles(req.files);
    return res.status(403).json({ error: { message: `Token has no access to model ${model}`, type: 'permission_error' } });
  }

  const channel = ChannelService.findChannelForModel(model);
  if (!channel) {
    cleanupFiles(req.files);
    return res.status(404).json({ error: { message: `No available channel for model ${model}`, type: 'not_found_error' } });
  }

  const count = Math.max(1, Number(n) || 1);
  const unitCost = PricingService.calculateCost(model, 0, 0);
  const totalCost = Math.round(unitCost * count * 100) / 100;

  const { sufficient, balance: currentBalance } = checkTokenOrUserBalance(token, totalCost);
  if (!sufficient) {
    cleanupFiles(req.files);
    return res.status(402).json({ error: { message: `Insufficient balance. Required: ¥${totalCost.toFixed(2)}, Current: ¥${currentBalance.toFixed(2)}`, type: 'insufficient_balance_error' } });
  }

  const upstreamModel = channel.modelMapping[model] || model;
  const baseUrl = channel.baseUrl.replace(/\/+$/, '');
  const upstreamUrl = `${baseUrl}/v1/images/edits`;

  try {
    const formData = new FormData();
    formData.append('model', upstreamModel);
    formData.append('prompt', prompt);
    formData.append('n', String(n));
    formData.append('size', size);
    formData.append('response_format', response_format);

    for (const key of Object.keys(otherParams)) {
      formData.append(key, otherParams[key]);
    }

    if (Array.isArray(req.files)) {
      for (const file of req.files) {
        const fileContent = fs.readFileSync(file.path);
        const blob = new Blob([fileContent], { type: file.mimetype });
        const name = file.fieldname === 'image' ? 'image[]' : file.fieldname;
        formData.append(name, blob, file.originalname);
      }
    }

    const headers: Record<string, string> = {};
    if (channel.apiKey) headers['Authorization'] = `Bearer ${channel.apiKey}`;

    const upstreamRes = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: formData,
      signal: AbortSignal.timeout(180_000),
    });

    cleanupFiles(req.files);

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      const durationMs = Date.now() - startTime;
      db.insert(apiLogs).values({
        tokenId: token.id, channelId: channel.id, model, upstreamModel,
        durationMs, status: 'error', errorMessage: `HTTP ${upstreamRes.status}: ${errText.slice(0, 500)}`, clientIp,
      }).run();
      return res.status(upstreamRes.status).json({ error: { message: `Upstream error: ${errText}`, type: 'upstream_error' } });
    }

    const responseBody = await upstreamRes.json() as any;
    const durationMs = Date.now() - startTime;

    deductTokenOrUserBalance(token, totalCost, model);

    db.insert(apiLogs).values({
      tokenId: token.id, channelId: channel.id, model, upstreamModel,
      cost: totalCost, durationMs, status: 'success', clientIp,
    }).run();

    if (responseBody.data && Array.isArray(responseBody.data)) {
      responseBody.data = responseBody.data.map((item: any) => {
        if (item.url && item.url.startsWith('/')) {
          return { ...item, url: baseUrl + item.url };
        }
        return item;
      });
    }

    res.json(responseBody);
  } catch (err: any) {
    cleanupFiles(req.files);
    const durationMs = Date.now() - startTime;
    const errorMessage = err.name === 'AbortError' ? 'upstream timeout' : err.message;
    db.insert(apiLogs).values({
      tokenId: token.id, channelId: channel.id, model, upstreamModel,
      durationMs, status: 'error', errorMessage, clientIp,
    }).run();
    res.status(502).json({ error: { message: `Upstream error: ${errorMessage}`, type: 'server_error' } });
  }
});

/** POST /v1/videos — Grok 视频生成任务代理 */
router.post('/videos', upload.any(), async (req: Request, res: Response) => {
  const startTime = Date.now();
  const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || '';

  const tokenKey = extractToken(req);
  if (!tokenKey) {
    cleanupFiles(req.files);
    return res.status(401).json({ error: { message: 'Missing API key', type: 'invalid_request_error' } });
  }

  const { valid, error, token } = TokenService.validateToken(tokenKey);
  if (!valid) {
    cleanupFiles(req.files);
    return res.status(401).json({ error: { message: error, type: 'invalid_request_error' } });
  }

  const { model, prompt, seconds = 6, size = '720x1280', resolution_name = '720p', ...otherParams } = req.body;
  if (!model) {
    cleanupFiles(req.files);
    return res.status(400).json({ error: 'model is required' });
  }
  if (!prompt) {
    cleanupFiles(req.files);
    return res.status(400).json({ error: 'prompt is required' });
  }

  if (token.allowedModels.length > 0 && !token.allowedModels.includes(model)) {
    cleanupFiles(req.files);
    return res.status(403).json({ error: `Token has no access to model ${model}` });
  }

  const channel = ChannelService.findChannelForModel(model);
  if (!channel) {
    cleanupFiles(req.files);
    return res.status(404).json({ error: `No available channel for model ${model}` });
  }

  const rate = getVideoRate(model, resolution_name);
  const totalCost = Math.round(rate * Number(seconds) * 100) / 100;

  const { sufficient, balance: currentBalance } = checkTokenOrUserBalance(token, totalCost);
  if (!sufficient) {
    cleanupFiles(req.files);
    return res.status(402).json({ error: `Insufficient balance. Required: ¥${totalCost.toFixed(2)}, Current: ¥${currentBalance.toFixed(2)}` });
  }

  const upstreamModel = channel.modelMapping[model] || model;
  const baseUrl = channel.baseUrl.replace(/\/+$/, '');
  const upstreamUrl = `${baseUrl}/v1/videos`;

  try {


    const formData = new FormData();
    formData.append('model', upstreamModel);
    formData.append('prompt', prompt);
    formData.append('seconds', String(seconds));
    formData.append('size', size);
    formData.append('resolution_name', resolution_name);

    for (const key of Object.keys(otherParams)) {
      formData.append(key, otherParams[key]);
    }

    if (Array.isArray(req.files)) {
      for (const file of req.files) {
        const fileContent = fs.readFileSync(file.path);
        const blob = new Blob([fileContent], { type: file.mimetype });
        formData.append(file.fieldname, blob, file.originalname);
      }
    }

    const headers: Record<string, string> = {};
    if (channel.apiKey) headers['Authorization'] = `Bearer ${channel.apiKey}`;

    const upstreamRes = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: formData,
      signal: AbortSignal.timeout(120_000),
    });

    cleanupFiles(req.files);

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      const durationMs = Date.now() - startTime;
      db.insert(apiLogs).values({
        tokenId: token.id, channelId: channel.id, model, upstreamModel,
        durationMs, status: 'error', errorMessage: `HTTP ${upstreamRes.status}: ${errText.slice(0, 500)}`, clientIp,
      }).run();
      return res.status(upstreamRes.status).json({ error: errText });
    }

    const responseBody = await upstreamRes.json() as any;
    const durationMs = Date.now() - startTime;

    deductTokenOrUserBalance(token, totalCost, model);

    db.insert(apiLogs).values({
      tokenId: token.id, channelId: channel.id, model, upstreamModel,
      cost: totalCost, durationMs, status: 'success', clientIp,
    }).run();

    res.json(responseBody);
  } catch (err: any) {
    cleanupFiles(req.files);
    const durationMs = Date.now() - startTime;
    const errorMessage = err.name === 'AbortError' ? 'upstream timeout' : err.message;
    db.insert(apiLogs).values({
      tokenId: token.id, channelId: channel.id, model, upstreamModel,
      durationMs, status: 'error', errorMessage, clientIp,
    }).run();
    res.status(502).json({ error: `Upstream error: ${errorMessage}` });
  }
});

/** POST /v1/video/generations — Omni 视频生成任务代理 */
router.post('/video/generations', async (req: Request, res: Response) => {
  const startTime = Date.now();
  const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || '';

  const tokenKey = extractToken(req);
  if (!tokenKey) return res.status(401).json({ error: { message: 'Missing API key', type: 'invalid_request_error' } });

  const { valid, error, token } = TokenService.validateToken(tokenKey);
  if (!valid) return res.status(401).json({ error: { message: error, type: 'invalid_request_error' } });

  const { model, prompt, duration = 6, aspect_ratio = 'landscape', resolution = '720p', ...otherParams } = req.body;
  if (!model) return res.status(400).json({ error: 'model is required' });
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  if (token.allowedModels.length > 0 && !token.allowedModels.includes(model)) {
    return res.status(403).json({ error: `Token has no access to model ${model}` });
  }

  const channel = ChannelService.findChannelForModel(model);
  if (!channel) {
    return res.status(404).json({ error: `No available channel for model ${model}` });
  }

  const rate = getVideoRate(model, resolution);
  const seconds = model === 'omni-flash-vref' ? 10 : Number(duration);
  const totalCost = Math.round(rate * seconds * 100) / 100;

  const { sufficient, balance: currentBalance } = checkTokenOrUserBalance(token, totalCost);
  if (!sufficient) {
    return res.status(402).json({ error: `Insufficient balance. Required: ¥${totalCost.toFixed(2)}, Current: ¥${currentBalance.toFixed(2)}` });
  }

  const upstreamModel = channel.modelMapping[model] || model;
  const baseUrl = channel.baseUrl.replace(/\/+$/, '');
  const upstreamUrl = `${baseUrl}/v1/video/generations`;

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (channel.apiKey) headers['Authorization'] = `Bearer ${channel.apiKey}`;

    const upstreamRes = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: upstreamModel,
        prompt,
        duration,
        aspect_ratio,
        resolution,
        ...otherParams,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      const durationMs = Date.now() - startTime;
      db.insert(apiLogs).values({
        tokenId: token.id, channelId: channel.id, model, upstreamModel,
        durationMs, status: 'error', errorMessage: `HTTP ${upstreamRes.status}: ${errText.slice(0, 500)}`, clientIp,
      }).run();
      return res.status(upstreamRes.status).json({ error: errText });
    }

    const responseBody = await upstreamRes.json() as any;
    const durationMs = Date.now() - startTime;

    deductTokenOrUserBalance(token, totalCost, model);

    db.insert(apiLogs).values({
      tokenId: token.id, channelId: channel.id, model, upstreamModel,
      cost: totalCost, durationMs: durationMs, status: 'success', clientIp,
    }).run();

    res.json(responseBody);
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err.name === 'AbortError' ? 'upstream timeout' : err.message;
    db.insert(apiLogs).values({
      tokenId: token.id, channelId: channel.id, model, upstreamModel,
      durationMs, status: 'error', errorMessage, clientIp,
    }).run();
    res.status(502).json({ error: `Upstream error: ${errorMessage}` });
  }
});

/** GET /v1/videos/:id — Grok 视频状态查询 */
router.get('/videos/:id', async (req: Request, res: Response) => {
  const tokenKey = extractToken(req);
  if (!tokenKey) return res.status(401).json({ error: { message: 'Missing API key', type: 'invalid_request_error' } });

  const { valid, error } = TokenService.validateToken(tokenKey);
  if (!valid) return res.status(401).json({ error: { message: error, type: 'invalid_request_error' } });

  const config = findUpstreamVideoConfig();
  if (!config) return res.status(503).json({ error: 'No video channel configured' });

  const id = req.params.id;
  const upstreamUrl = `${config.baseUrl.replace(/\/+$/, '')}/v1/videos/${id}`;

  try {
    const headers: Record<string, string> = {};
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

    const upstreamRes = await fetch(upstreamUrl, { headers, signal: AbortSignal.timeout(15_000) });
    if (!upstreamRes.ok) {
      const txt = await upstreamRes.text();
      return res.status(upstreamRes.status).json({ error: txt });
    }

    const responseBody = await upstreamRes.json() as any;
    const statusLower = (responseBody.status || '').toLowerCase();
    if (statusLower === 'completed' || statusLower === 'success') {
      const origUrl = responseBody.url || responseBody.video_url || responseBody.result_url;
      if (origUrl) {
        responseBody.url = rewriteVideoUrl(origUrl, req, id);
        if (responseBody.video_url) responseBody.video_url = responseBody.url;
        if (responseBody.result_url) responseBody.result_url = responseBody.url;
      }
    }

    res.json(responseBody);
  } catch (err: any) {
    res.status(502).json({ error: `Upstream query failed: ${err.message}` });
  }
});

/** GET /v1/video/generations/:id — Omni 视频状态查询 */
router.get('/video/generations/:id', async (req: Request, res: Response) => {
  const tokenKey = extractToken(req);
  if (!tokenKey) return res.status(401).json({ error: { message: 'Missing API key', type: 'invalid_request_error' } });

  const { valid, error } = TokenService.validateToken(tokenKey);
  if (!valid) return res.status(401).json({ error: { message: error, type: 'invalid_request_error' } });

  const config = findUpstreamVideoConfig();
  if (!config) return res.status(503).json({ error: 'No video channel configured' });

  const id = req.params.id;
  const upstreamUrl = `${config.baseUrl.replace(/\/+$/, '')}/v1/video/generations/${id}`;

  try {
    const headers: Record<string, string> = {};
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

    const upstreamRes = await fetch(upstreamUrl, { headers, signal: AbortSignal.timeout(15_000) });
    if (!upstreamRes.ok) {
      const txt = await upstreamRes.text();
      return res.status(upstreamRes.status).json({ error: txt });
    }

    const responseBody = await upstreamRes.json() as any;
    const taskStatus = (responseBody.status || responseBody.data?.status || '').toLowerCase();
    if (taskStatus === 'completed' || taskStatus === 'success') {
      const origUrl = responseBody.result_url || responseBody.url || responseBody.data?.result_url || responseBody.data?.url;
      if (origUrl) {
        const rewritten = rewriteVideoUrl(origUrl, req, id);
        responseBody.result_url = rewritten;
        if (responseBody.url) responseBody.url = rewritten;
        if (responseBody.data) {
          responseBody.data.result_url = rewritten;
          responseBody.data.url = rewritten;
        }
      }
    }

    res.json(responseBody);
  } catch (err: any) {
    res.status(502).json({ error: `Upstream query failed: ${err.message}` });
  }
});

/** GET /v1/files/video — 视频下载管道代理 */
router.get('/files/video', async (req: Request, res: Response) => {
  const id = req.query.id as string;
  if (!id) return res.status(400).json({ error: 'Missing video id' });

  const config = findUpstreamVideoConfig();
  if (!config) return res.status(503).json({ error: 'No video channel configured' });

  const upstreamUrl = `${config.baseUrl.replace(/\/+$/, '')}/v1/files/video?id=${id}`;

  try {
    const headers: Record<string, string> = {};
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

    const upstreamRes = await fetch(upstreamUrl, { headers, signal: AbortSignal.timeout(300_000) });
    if (!upstreamRes.ok) {
      return res.status(upstreamRes.status).send(`Failed to stream video: ${upstreamRes.statusText}`);
    }

    res.setHeader('Content-Type', upstreamRes.headers.get('Content-Type') || 'video/mp4');
    const len = upstreamRes.headers.get('Content-Length');
    if (len) res.setHeader('Content-Length', len);

    const reader = upstreamRes.body?.getReader();
    if (!reader) return res.status(500).send('No video stream body from upstream');

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
    res.status(502).send(`Video stream failed: ${err.message}`);
  }
});

export default router;
