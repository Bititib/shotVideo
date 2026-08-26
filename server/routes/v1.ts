import { Router, Request, Response } from 'express';
import { TokenService } from '../services/tokenService.js';
import { ChannelService } from '../services/channelService.js';
import { PricingService } from '../services/pricingService.js';
import { BalanceService } from '../services/balanceService.js';
import { db } from '../db/index.js';
import { apiLogs, settings, models, contents, apiTokens } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
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
  if (model === 'grok-video-1.5（按秒）') {
    return 0.09;
  } else if (model === 'grok-imagine-video-1.5（按次）') {
    return 0.60;
  } else if (model === 'grok-imagine-video-1.5-preview') {
    return 0.70;
  } else if (model === 'seedance-2.5-deal') {
    return 1.80;
  } else if (model === 'seedance-2.5m') {
    return 3.00;
  } else if (model === 'wan3.0th') {
    return 4.00;
  } else if (model === 'sdas-bl-sd2.0-933-pro-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_bl_sd20_933_pro_720p_rate')).get();
    return parseFloat(row?.value || '4.50');
  } else if (model === 'sdas-bl-sd2.0-933-pro-noface-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_bl_sd20_933_pro_noface_720p_rate')).get();
    return parseFloat(row?.value || '4.00');
  } else if (model === 'cd-seedance-2.0-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'cd_seedance_2_0_720p_rate')).get();
    return parseFloat(row?.value || '3.00');
  } else if (model === 'nd-seedance-2.0-480p') {
    const row = db.select().from(settings).where(eq(settings.key, 'nd_seedance_2_0_480p_rate')).get();
    return parseFloat(row?.value || '3.75');
  } else if (model === 'nd-seedance-2.0-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'nd_seedance_2_0_720p_rate')).get();
    return parseFloat(row?.value || '4.30');
  } else if (model === 'ld-sdas-cvk-pro-933-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'ld_sdas_cvk_pro_933_720p_rate')).get();
    return parseFloat(row?.value || '3.80');
  } else if (model === 'sdas-mj-minimax-h3-2k') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_mj_minimax_h3_2k_rate')).get();
    return parseFloat(row?.value || '3.00');
  } else if (model === 'sd2.5') {
    const row = db.select().from(settings).where(eq(settings.key, 'sd2_5_rate')).get();
    return parseFloat(row?.value || '3.50');
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
  } else if (model === 'veo-omni-flash') {
    const row = db.select().from(settings).where(eq(settings.key, 'veo_omni_flash_rate')).get();
    return parseFloat(row?.value || '0.25');
  } else if (model === 'veo-3-1') {
    const row = db.select().from(settings).where(eq(settings.key, 'veo_3_1_rate')).get();
    return parseFloat(row?.value || '0.20');
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
  const active = ChannelService.getActiveChannels();
  let ch = active.find(c => c.supportedModels.includes('video') || c.supportedModels.includes('*'));
  if (ch) return { baseUrl: ch.baseUrl, apiKey: ch.apiKey };
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

/** 统一视频任务创建核心逻辑 (Unified Video Creation Controller) */
async function handleVideoCreation(req: Request, res: Response) {
  if (req.body.model === 'sdas-xh-sd2.0-933-3-pro-720p') {
    req.body.model = 'sdas-pd-sd2.0-pro-933-5-720p';
  }
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

  const body = req.body || {};

  const model = body.model;
  const prompt = body.prompt;

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

  // 规范化并提取入参别名 (seconds / duration)
  let seconds = body.seconds !== undefined ? Number(body.seconds) : undefined;
  const duration = body.duration !== undefined ? Number(body.duration) : undefined;

  if (seconds !== undefined && duration !== undefined && seconds !== duration) {
    cleanupFiles(req.files);
    return res.status(400).json({ error: 'seconds and duration must be equal when both are provided' });
  }
  if (seconds === undefined) {
    seconds = duration !== undefined ? duration : 6;
  }

  const ratio = body.ratio || body.aspect_ratio || '16:9';
  const resolution = body.resolution || body.resolution_name || '720p';

  // 提取图片素材别名
  let image_urls: string[] = [];
  if (Array.isArray(body.image_urls)) {
    image_urls = body.image_urls;
  } else if (Array.isArray(body.images)) {
    image_urls = body.images;
  } else if (Array.isArray(body.image_refs)) {
    image_urls = body.image_refs;
  } else if (typeof body.image_urls === 'string') {
    image_urls = [body.image_urls];
  } else if (typeof body.images === 'string') {
    image_urls = [body.images];
  }

  if (Array.isArray(req.files)) {
    const uploadedImages = req.files
      .filter((f: any) => f.fieldname === 'input_reference[]' || f.fieldname === 'image' || f.fieldname === 'images')
      .map((f: any) => {
        const fileContent = fs.readFileSync(f.path);
        const filename = `uploaded_${Date.now()}_${Math.random().toString(36).substring(2, 8)}${path.extname(f.originalname)}`;
        const destPath = path.join(process.cwd(), 'data/uploads', filename);
        fs.writeFileSync(destPath, fileContent);
        const backendUrl = process.env.BACKEND_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
        return `${backendUrl.replace(/\/+$/, '')}/uploads/${filename}`;
      });
    if (uploadedImages.length > 0) {
      image_urls = [...image_urls, ...uploadedImages];
    }
  }

  // 提取视频素材别名
  let video_urls: string[] = [];
  if (Array.isArray(body.video_urls)) {
    video_urls = body.video_urls;
  } else if (Array.isArray(body.videos)) {
    video_urls = body.videos;
  } else if (typeof body.video_urls === 'string') {
    video_urls = [body.video_urls];
  } else if (typeof body.videos === 'string') {
    video_urls = [body.videos];
  }

  if (Array.isArray(req.files)) {
    const uploadedVideos = req.files
      .filter((f: any) => f.fieldname === 'video' || f.fieldname === 'videos' || f.fieldname === 'reference_video')
      .map((f: any) => {
        const fileContent = fs.readFileSync(f.path);
        const filename = `uploaded_${Date.now()}_${Math.random().toString(36).substring(2, 8)}${path.extname(f.originalname)}`;
        const destPath = path.join(process.cwd(), 'data/uploads', filename);
        fs.writeFileSync(destPath, fileContent);
        const backendUrl = process.env.BACKEND_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
        return `${backendUrl.replace(/\/+$/, '')}/uploads/${filename}`;
      });
    if (uploadedVideos.length > 0) {
      video_urls = [...video_urls, ...uploadedVideos];
    }
  }

  // 提取音频素材别名
  let audio_urls: string[] = [];
  if (Array.isArray(body.audio_urls)) {
    audio_urls = body.audio_urls;
  } else if (Array.isArray(body.audios)) {
    audio_urls = body.audios;
  } else if (typeof body.audio_urls === 'string') {
    audio_urls = [body.audio_urls];
  } else if (typeof body.audios === 'string') {
    audio_urls = [body.audios];
  }

  if (Array.isArray(req.files)) {
    const uploadedAudios = req.files
      .filter((f: any) => f.fieldname === 'audio' || f.fieldname === 'audios' || f.fieldname === 'reference_audio')
      .map((f: any) => {
        const fileContent = fs.readFileSync(f.path);
        const filename = `uploaded_${Date.now()}_${Math.random().toString(36).substring(2, 8)}${path.extname(f.originalname)}`;
        const destPath = path.join(process.cwd(), 'data/uploads', filename);
        fs.writeFileSync(destPath, fileContent);
        const backendUrl = process.env.BACKEND_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
        return `${backendUrl.replace(/\/+$/, '')}/uploads/${filename}`;
      });
    if (uploadedAudios.length > 0) {
      audio_urls = [...audio_urls, ...uploadedAudios];
    }
  }

  // 动态查找支持该模型的渠道 (从后台注册的渠道中选取)
  const channel = ChannelService.findChannelForModel(model);
  let upstreamModel = model;
  let baseUrl = '';
  let apiKey = '';
  let channelId: number | null = null;

  if (channel) {
    if (channel.modelMapping) {
      try {
        const mapping = typeof channel.modelMapping === 'string' ? JSON.parse(channel.modelMapping) : channel.modelMapping;
        upstreamModel = mapping[model] || model;
      } catch { /* skip */ }
    }
    baseUrl = channel.baseUrl.replace(/\/+$/, '');
    apiKey = channel.apiKey;
    channelId = channel.id;
  } else {
    cleanupFiles(req.files);
    return res.status(404).json({ error: `No available channel for model ${model}` });
  }

  // 计费计算与校验
  const rate = getVideoRate(model, resolution);
  const isFlatRate = [
    'grok-imagine-video-1.5（按次）',
    'grok-imagine-video-1.5-preview',
    'seedance-2.5-deal',
    'seedance-2.5m',
    'wan3.0th',
    'seedance-2.0-fast',
    'sd2-c7',
    'sd2.5',
    'seedance-2.0-720p',
    'seedance-2.0-fast-720p',
    'seedance-720',
    'ld-sdas-cvk-pro-933-720p',
    'sdas-mj-minimax-h3-2k',
    'sdas-bl-sd2.0-933-pro-720p',
    'sdas-bl-sd2.0-933-pro-noface-720p',
    'cd-seedance-2.0-720p',
    'nd-seedance-2.0-480p',
    'nd-seedance-2.0-720p',
    'sd2-c6'
  ].includes(model);
  const totalCost = isFlatRate ? rate : (Math.round(rate * seconds * 100) / 100);

  const { sufficient, balance: currentBalance } = checkTokenOrUserBalance(token, totalCost);
  if (!sufficient) {
    cleanupFiles(req.files);
    return res.status(402).json({ error: `Insufficient balance. Required: ¥${totalCost.toFixed(2)}, Current: ¥${currentBalance.toFixed(2)}` });
  }

  // 先在本地 contents 数据库创建初始任务记录 (status = 'processing')
  let contentId: number | null = null;
  try {
    const insertResult = db.insert(contents).values({
      userId: token.userId || 1,
      orgId: null,
      type: 'video',
      title: prompt.slice(0, 200),
      inputText: prompt.slice(0, 500),
      modelId: model,
      cost: totalCost,
      status: 'processing',
      metadata: JSON.stringify({
        resolution,
        seconds,
        aspect_ratio: ratio,
        model,
        image_urls,
        video_urls,
        audio_urls,
        tokenId: token.id
      })
    }).run();
    contentId = Number(insertResult.lastInsertRowid);
  } catch (e) {
    console.error('[v1-video] Failed to save content record:', e);
    cleanupFiles(req.files);
    return res.status(500).json({ error: 'Database error' });
  }

  const isSudaShuiModel = [
    'ld-sdas-cvk-pro-933-720p',
    'sdas-mj-minimax-h3-2k',
    'sdas-bl-sd2.0-933-pro-720p',
    'sdas-bl-sd2.0-933-pro-noface-720p',
    'veo-omni-flash',
    'veo-3-1',
    'omni-flash',
    'omni-flash-vref'
  ].includes(model) || model.startsWith('omni-') || model.startsWith('veo-omni-');

  const upstreamUrl = isSudaShuiModel
    ? `${baseUrl}/v1/video/generations`
    : `${baseUrl}/v1/videos`;

  try {
    let upstreamRes;
    const { ...otherParams } = body;
    delete otherParams.model;
    delete otherParams.prompt;
    delete otherParams.seconds;
    delete otherParams.duration;
    delete otherParams.ratio;
    delete otherParams.aspect_ratio;
    delete otherParams.resolution;
    delete otherParams.resolution_name;
    delete otherParams.image_urls;
    delete otherParams.images;
    delete otherParams.image_refs;
    delete otherParams.video_urls;
    delete otherParams.videos;
    delete otherParams.audio_urls;
    delete otherParams.audios;

    if (Array.isArray(req.files) && req.files.length > 0) {
      const formData = new FormData();
      formData.append('model', upstreamModel);
      formData.append('prompt', prompt);

      if (isSudaShuiModel) {
        formData.append('duration', String(seconds));
        formData.append('aspect_ratio', ratio);
        formData.append('resolution', resolution);
        if (image_urls.length > 0) formData.append('images', JSON.stringify(image_urls));
        if (video_urls.length > 0) formData.append('video', video_urls[0]);
      } else {
        formData.append('seconds', String(seconds));
        formData.append('ratio', ratio);
        formData.append('resolution', resolution);
        if (image_urls.length > 0) formData.append('image_urls', JSON.stringify(image_urls));
        if (video_urls.length > 0) formData.append('video_urls', JSON.stringify(video_urls));
        if (audio_urls.length > 0) formData.append('audio_urls', JSON.stringify(audio_urls));
      }

      for (const key of Object.keys(otherParams)) {
        formData.append(key, String(otherParams[key]));
      }

      for (const file of req.files) {
        const fileContent = fs.readFileSync(file.path);
        const blob = new Blob([fileContent], { type: file.mimetype });
        formData.append(file.fieldname, blob, file.originalname);
      }

      const headers: Record<string, string> = {};
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      upstreamRes = await fetch(upstreamUrl, {
        method: 'POST',
        headers,
        body: formData,
        signal: AbortSignal.timeout(120_000),
      });
    } else {
      let payload: Record<string, any>;
      if (isSudaShuiModel) {
        payload = {
          model: upstreamModel,
          prompt,
          duration: seconds,
          aspect_ratio: ratio,
          resolution,
          images: image_urls,
          video: video_urls[0] || undefined,
          ...otherParams,
        };
      } else if (model.includes('grok-imagine-video') || model.includes('grok-video')) {
        const extra: Record<string, any> = {
          aspect_ratio: ratio,
          resolution: resolution
        };
        if (image_urls.length > 1) {
          extra.reference_images = image_urls.map(url => ({ url }));
        }
        payload = {
          model: upstreamModel,
          prompt,
          duration: seconds,
          extra,
          input_reference: image_urls.length === 1 ? image_urls[0] : undefined,
          ...otherParams,
        };
      } else {
        payload = {
          model: upstreamModel,
          prompt,
          seconds,
          ratio,
          resolution,
          image_urls: image_urls.length > 0 ? image_urls : undefined,
          video_urls: video_urls.length > 0 ? video_urls : undefined,
          audio_urls: audio_urls.length > 0 ? audio_urls : undefined,
          ...otherParams,
        };
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      upstreamRes = await fetch(upstreamUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120_000),
      });
    }

    cleanupFiles(req.files);

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      const durationMs = Date.now() - startTime;
      db.insert(apiLogs).values({
        tokenId: token.id, channelId, model, upstreamModel,
        durationMs, status: 'error', errorMessage: `HTTP ${upstreamRes.status}: ${errText.slice(0, 500)}`, clientIp,
      }).run();

      db.update(contents).set({ status: 'failed', cost: 0 }).where(eq(contents.id, contentId)).run();
      return res.status(upstreamRes.status).json({ error: errText });
    }

    const responseBody = await upstreamRes.json() as any;
    const durationMs = Date.now() - startTime;

    deductTokenOrUserBalance(token, totalCost, model);

    db.insert(apiLogs).values({
      tokenId: token.id, channelId, model, upstreamModel,
      cost: totalCost, durationMs, status: 'success', clientIp,
    }).run();

    const upstreamTaskId = responseBody.task_id || responseBody.id;
    if (!upstreamTaskId) {
      db.update(contents).set({ status: 'failed', cost: 0 }).where(eq(contents.id, contentId)).run();
      return res.status(502).json({ error: 'Upstream did not return a task ID' });
    }

    const localMeta = {
      model,
      prompt,
      seconds,
      ratio,
      resolution,
      image_urls,
      video_urls,
      audio_urls,
      videoId: upstreamTaskId,
      channelId: channel.id,
      progress: 0,
      tokenId: token.id
    };
    db.update(contents).set({ metadata: JSON.stringify(localMeta) }).where(eq(contents.id, contentId)).run();

    // 开启后台轮询
    try {
      const { resumePollForTask } = await import('./video.js');
      const updatedRecord = db.select().from(contents).where(eq(contents.id, contentId)).get();
      if (updatedRecord) {
        resumePollForTask(contentId, updatedRecord);
      }
    } catch (pollErr: any) {
      console.warn('[v1-video] resumePollForTask failed:', pollErr.message);
    }

    res.json({
      id: `task_${contentId}`,
      task_id: `task_${contentId}`,
      object: 'video',
      model: model,
      status: 'queued',
      progress: 0
    });
  } catch (err: any) {
    cleanupFiles(req.files);
    const durationMs = Date.now() - startTime;
    const errorMessage = err.name === 'AbortError' ? 'upstream timeout' : err.message;
    db.insert(apiLogs).values({
      tokenId: token.id, channelId, model, upstreamModel,
      durationMs, status: 'error', errorMessage, clientIp,
    }).run();

    if (contentId !== null) {
      db.update(contents).set({ status: 'failed', cost: 0 }).where(eq(contents.id, contentId)).run();
    }

    res.status(502).json({ error: `Upstream error: ${errorMessage}` });
  }
}

/** 统一视频任务轮询核心逻辑 (Unified Video Query Controller) */
async function handleVideoQuery(req: Request, res: Response) {
  const tokenKey = extractToken(req);
  if (!tokenKey) return res.status(401).json({ error: { message: 'Missing API key', type: 'invalid_request_error' } });

  const { valid, error } = TokenService.validateToken(tokenKey);
  if (!valid) return res.status(401).json({ error: { message: error, type: 'invalid_request_error' } });

  const idParam = req.params.id;
  let contentId = NaN;
  if (idParam.startsWith('task_')) {
    contentId = parseInt(idParam.slice(5), 10);
  } else {
    contentId = parseInt(idParam, 10);
  }

  let record = null;
  if (!isNaN(contentId)) {
    record = db.select().from(contents).where(eq(contents.id, contentId)).get();
  }

  if (record) {
    const status = record.status;
    let progress = 0;
    try {
      const meta = JSON.parse(record.metadata || '{}');
      progress = meta.progress || (status === 'completed' ? 100 : 0);
    } catch {}

    let mappedStatus = 'queued';
    if (status === 'completed') mappedStatus = 'completed';
    else if (status === 'failed') mappedStatus = 'failed';
    else if (status === 'processing') {
      mappedStatus = progress > 0 ? 'processing' : 'queued';
    }

    const host = req.get('host');
    const protocol = req.protocol;
    const contentUrl = `${protocol}://${host}/v1/videos/task_${record.id}/content`;

    const responseJson: Record<string, any> = {
      id: `task_${record.id}`,
      task_id: `task_${record.id}`,
      object: 'video',
      model: record.modelId,
      status: mappedStatus,
      progress: progress
    };

    if (mappedStatus === 'completed') {
      responseJson.url = contentUrl;
      responseJson.result_url = contentUrl;
    }

    return res.json(responseJson);
  }

  // 兜底回退：若本地找不到记录，按旧逻辑向上游查询
  const config = findUpstreamVideoConfig();
  if (!config) return res.status(404).json({ error: 'Task not found locally and no video channel configured' });

  const upstreamUrl = idParam.includes('task_') || idParam.startsWith('zerof:')
    ? `${config.baseUrl.replace(/\/+$/, '')}/v1/video/generations/${idParam}`
    : `${config.baseUrl.replace(/\/+$/, '')}/v1/videos/${idParam}`;

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
      const origUrl = responseBody.url || responseBody.video_url || responseBody.result_url || responseBody.data?.url || responseBody.data?.result_url;
      if (origUrl) {
        responseBody.url = rewriteVideoUrl(origUrl, req, idParam);
        if (responseBody.video_url) responseBody.video_url = responseBody.url;
        if (responseBody.result_url) responseBody.result_url = responseBody.url;
        if (responseBody.data) {
          responseBody.data.url = responseBody.url;
          responseBody.data.result_url = responseBody.url;
        }
      }
    }

    res.json(responseBody);
  } catch (err: any) {
    res.status(502).json({ error: `Upstream query failed: ${err.message}` });
  }
}

/** 注册统一视频接口路由 */
router.post('/videos', upload.any(), handleVideoCreation);
router.post('/video/generations', upload.any(), handleVideoCreation);
router.get('/videos/:id', handleVideoQuery);
router.get('/video/generations/:id', handleVideoQuery);

/** GET /v1/videos/:id/content — 统一视频内容直连下载/播放 */
router.get('/videos/:id/content', async (req: Request, res: Response) => {
  const tokenKey = extractToken(req);
  if (!tokenKey) return res.status(401).json({ error: { message: 'Missing API key', type: 'invalid_request_error' } });

  const { valid, error } = TokenService.validateToken(tokenKey);
  if (!valid) return res.status(401).json({ error: { message: error, type: 'invalid_request_error' } });

  const idParam = req.params.id;
  let contentId = NaN;
  if (idParam.startsWith('task_')) {
    contentId = parseInt(idParam.slice(5), 10);
  } else {
    contentId = parseInt(idParam, 10);
  }

  let record = null;
  if (!isNaN(contentId)) {
    record = db.select().from(contents).where(eq(contents.id, contentId)).get();
  }

  if (!record) {
    return res.status(404).json({ error: 'Task not found' });
  }

  if (record.status !== 'completed') {
    return res.status(400).json({ error: `Task status is ${record.status}, not completed yet` });
  }

  const url = record.resultUrl;
  if (!url) {
    return res.status(404).json({ error: 'Video URL not found in completed task' });
  }

  let isLocalFile = false;
  let localFilePath = '';

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    isLocalFile = true;
    const cleanPath = url.replace(/^.*\/uploads\//, '');
    localFilePath = path.join(process.cwd(), 'data/uploads', cleanPath);
  } else {
    const uploadsIndex = url.indexOf('/uploads/');
    if (uploadsIndex !== -1) {
      isLocalFile = true;
      const cleanPath = url.substring(uploadsIndex + '/uploads/'.length);
      localFilePath = path.join(process.cwd(), 'data/uploads', cleanPath);
    }
  }

  if (isLocalFile) {
    if (fs.existsSync(localFilePath)) {
      res.setHeader('Content-Type', 'video/mp4');
      return res.sendFile(localFilePath);
    }
  }

  try {
    const config = findUpstreamVideoConfig();
    const headers: Record<string, string> = {};
    if (config?.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    let streamUrl = url;
    if (url.includes('/v1/files/video')) {
      const match = url.match(/[?&]id=([^&]+)/);
      const fileId = match ? match[1] : '';
      if (fileId && config) {
        streamUrl = `${config.baseUrl.replace(/\/+$/, '')}/v1/files/video?id=${fileId}`;
      }
    }

    const upstreamRes = await fetch(streamUrl, { headers, signal: AbortSignal.timeout(300_000) });
    if (!upstreamRes.ok) {
      return res.status(upstreamRes.status).send(`Failed to stream video from upstream: ${upstreamRes.statusText}`);
    }

    res.setHeader('Content-Type', upstreamRes.headers.get('Content-Type') || 'video/mp4');
    const len = upstreamRes.headers.get('Content-Length');
    if (len) res.setHeader('Content-Length', len);

    const reader = upstreamRes.body?.getReader();
    if (!reader) return res.status(502).send('No video stream body from upstream');

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
