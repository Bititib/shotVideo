import { Router, Request, Response } from 'express';
import { TokenService } from '../services/tokenService.js';
import { ChannelService } from '../services/channelService.js';
import { PricingService } from '../services/pricingService.js';
import { BalanceService } from '../services/balanceService.js';
import { db } from '../db/index.js';
import { apiLogs, settings, models, contents, apiTokens } from '../db/schema.js';
import { and, desc, eq, sql } from 'drizzle-orm';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { env } from '../config/env.js';
import {
  buildHmStudioImageForm,
  buildHmStudioVideoForm,
  hmStudioCreateUrl,
  isHmStudioChannel,
  waitForHmStudioTask,
} from '../services/hmStudioAdapter.js';
import {
  buildMjNewApiVideoPayload,
  findInvalidMjNewApiMaterialUrls,
  isMjNewApiChannel,
} from '../services/mjNewApiAdapter.js';

const router = Router();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 150 * 1024 * 1024 } });

/** 从请求头中提取 Bearer Token */
export function extractToken(req: Pick<Request, 'headers'>): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }

  const apiKeyHeader = req.headers['x-api-key'];
  const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  return typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : null;
}

export function filterRoutableModels(
  modelIds: string[],
  activeChannels: Array<{ supportedModels: string[] }>,
): string[] {
  const hasWildcardChannel = activeChannels.some(ch => ch.supportedModels.includes('*'));
  if (hasWildcardChannel) return modelIds;

  const routableModels = new Set(
    activeChannels.flatMap(ch => ch.supportedModels.filter(modelId => modelId !== '*')),
  );
  return modelIds.filter(modelId => routableModels.has(modelId));
}

/** 仅允许创建任务的 Token（或同一用户的旧任务）访问本地视频记录。 */
export function canAccessVideoRecord(record: any, token: any): boolean {
  try {
    const metadata = JSON.parse(record.metadata || '{}');
    if (metadata.tokenId !== undefined && metadata.tokenId !== null) {
      return Number(metadata.tokenId) === Number(token.id);
    }
  } catch { }

  return token.userId !== null
    && token.userId !== undefined
    && Number(record.userId) === Number(token.userId);
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
    return 0.14;
  } else if (model === 'ad-seedance-2.5-480p') {
    return 0.35;
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

function normalizeImageExtension(value: unknown): string {
  const format = String(value || 'png').toLowerCase().replace('jpg', 'jpeg');
  return ['png', 'jpeg', 'webp'].includes(format) ? format : 'png';
}

/** 将开放 API 返回的每张图片保存为独立内容资产。资产入库失败不影响已成功的上游响应。 */
export function saveApiImageAssets(options: {
  token: any;
  responseBody: any;
  model: string;
  prompt: string;
  size: string;
  responseFormat: string;
  outputFormat?: string;
  operation: 'generation' | 'edit';
  totalCost: number;
  referenceFileNames?: string[];
}): number[] {
  const items = Array.isArray(options.responseBody?.data) ? options.responseBody.data : [];
  const validItems = items.filter((item: any) => item?.url || item?.b64_json);
  if (validItems.length === 0) return [];

  const totalCents = Math.max(0, Math.round(options.totalCost * 100));
  const baseCents = Math.floor(totalCents / validItems.length);
  const remainder = totalCents % validItems.length;
  const assetIds: number[] = [];

  validItems.forEach((item: any, index: number) => {
    let resultUrl = item.url || '';

    if (!resultUrl && item.b64_json) {
      const outputDir = path.join(process.cwd(), 'data', 'uploads', 'api-images');
      fs.mkdirSync(outputDir, { recursive: true });
      const extension = normalizeImageExtension(options.outputFormat);
      const filename = `api_${Date.now()}_${crypto.randomUUID()}.${extension}`;
      const base64 = String(item.b64_json).replace(/^data:image\/[^;]+;base64,/, '');
      fs.writeFileSync(path.join(outputDir, filename), Buffer.from(base64, 'base64'));
      resultUrl = `/uploads/api-images/${filename}`;
    }

    const assetCost = (baseCents + (index < remainder ? 1 : 0)) / 100;
    const inserted = db.insert(contents).values({
      userId: options.token.userId || 1,
      orgId: null,
      type: 'image',
      title: options.prompt.slice(0, 200),
      inputText: options.prompt.slice(0, 5000),
      resultUrl,
      modelId: options.model,
      cost: assetCost,
      status: 'completed',
      metadata: JSON.stringify({
        source: 'api',
        operation: options.operation,
        tokenId: options.token.id,
        tokenName: options.token.name || '',
        size: options.size,
        response_format: options.responseFormat,
        output_format: normalizeImageExtension(options.outputFormat),
        response_index: index,
        reference_file_names: options.referenceFileNames || [],
      }),
    }).run();
    assetIds.push(Number(inserted.lastInsertRowid));
  });

  return assetIds;
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

  // 仅返回至少有一个启用渠道能够实际路由的模型；通配符渠道除外。
  const activeChannels = ChannelService.getActiveChannels();
  let modelList = filterRoutableModels(Array.from(allModels), activeChannels);
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

/** GET /v1/billing/usage — 当前 Token 的调用明细与汇总 */
router.get('/billing/usage', (req: Request, res: Response) => {
  const tokenKey = extractToken(req);
  if (!tokenKey) return res.status(401).json({ error: { message: 'Missing API key', type: 'invalid_request_error' } });

  const { valid, error, token } = TokenService.validateToken(tokenKey);
  if (!valid) return res.status(401).json({ error: { message: error, type: 'invalid_request_error' } });

  const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(req.query.page_size || '50'), 10) || 50));
  const startTime = req.query.start_time === undefined ? null : Number(req.query.start_time);
  const endTime = req.query.end_time === undefined ? null : Number(req.query.end_time);

  if ((startTime !== null && (!Number.isFinite(startTime) || startTime < 0))
    || (endTime !== null && (!Number.isFinite(endTime) || endTime < 0))) {
    return res.status(400).json({ error: { message: 'start_time and end_time must be millisecond timestamps', type: 'invalid_request_error' } });
  }
  if (startTime !== null && endTime !== null && startTime > endTime) {
    return res.status(400).json({ error: { message: 'start_time must not be greater than end_time', type: 'invalid_request_error' } });
  }

  const conditions: any[] = [eq(apiLogs.tokenId, token.id)];
  if (startTime !== null) {
    conditions.push(sql`${apiLogs.createdAt} >= datetime(${Math.floor(startTime / 1000)}, 'unixepoch')`);
  }
  if (endTime !== null) {
    conditions.push(sql`${apiLogs.createdAt} <= datetime(${Math.floor(endTime / 1000)}, 'unixepoch')`);
  }
  const where = and(...conditions);

  const rows = db.select({
    id: apiLogs.id,
    model: apiLogs.model,
    upstreamModel: apiLogs.upstreamModel,
    promptTokens: apiLogs.promptTokens,
    completionTokens: apiLogs.completionTokens,
    totalTokens: apiLogs.totalTokens,
    cost: apiLogs.cost,
    durationMs: apiLogs.durationMs,
    status: apiLogs.status,
    errorMessage: apiLogs.errorMessage,
    createdAt: apiLogs.createdAt,
  }).from(apiLogs)
    .where(where)
    .orderBy(desc(apiLogs.createdAt), desc(apiLogs.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();

  const aggregate = db.select({
    totalRequests: sql<number>`count(*)`,
    totalPromptTokens: sql<number>`coalesce(sum(${apiLogs.promptTokens}), 0)`,
    totalCompletionTokens: sql<number>`coalesce(sum(${apiLogs.completionTokens}), 0)`,
    totalTokens: sql<number>`coalesce(sum(${apiLogs.totalTokens}), 0)`,
    totalCost: sql<number>`coalesce(sum(${apiLogs.cost}), 0)`,
    successCount: sql<number>`coalesce(sum(case when ${apiLogs.status} = 'success' then 1 else 0 end), 0)`,
    errorCount: sql<number>`coalesce(sum(case when ${apiLogs.status} != 'success' then 1 else 0 end), 0)`,
  }).from(apiLogs).where(where).get();

  let balance = token.balance;
  if (balance === -1 && token.userId) {
    balance = BalanceService.checkBalance(token.userId, 0.01).balance;
  }

  res.json({
    balance: balance === -1 ? 999999 : balance,
    summary: {
      total_requests: Number(aggregate?.totalRequests || 0),
      total_prompt_tokens: Number(aggregate?.totalPromptTokens || 0),
      total_completion_tokens: Number(aggregate?.totalCompletionTokens || 0),
      total_tokens: Number(aggregate?.totalTokens || 0),
      total_cost: Number(aggregate?.totalCost || 0),
      success_count: Number(aggregate?.successCount || 0),
      error_count: Number(aggregate?.errorCount || 0),
    },
    items: rows.map(row => ({
      id: row.id,
      model: row.model,
      upstream_model: row.upstreamModel,
      prompt_tokens: row.promptTokens,
      completion_tokens: row.completionTokens,
      total_tokens: row.totalTokens,
      cost: row.cost,
      duration_ms: row.durationMs,
      status: row.status,
      error_message: row.errorMessage,
      created_at: row.createdAt,
    })),
    total: Number(aggregate?.totalRequests || 0),
    page,
    page_size: pageSize,
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

  const count = Number(n);
  if (!Number.isInteger(count) || count < 1 || count > 4) {
    return res.status(400).json({ error: { message: 'n must be an integer between 1 and 4', type: 'invalid_request_error' } });
  }

  if (token.allowedModels.length > 0 && !token.allowedModels.includes(model)) {
    return res.status(403).json({ error: { message: `Token has no access to model ${model}`, type: 'permission_error' } });
  }

  const channel = ChannelService.findChannelForModel(model);
  if (!channel) {
    return res.status(404).json({ error: { message: `No available channel for model ${model}`, type: 'not_found_error' } });
  }

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
    if (isHmStudioChannel(channel)) {
      const submitOne = async () => {
        const formData = buildHmStudioImageForm({
          model: upstreamModel,
          prompt,
          ratio: otherParams.ratio || otherParams.aspect_ratio || '1:1',
          resolution: otherParams.resolution || '2k',
          negativePrompt: otherParams.negative_prompt,
          sampleStrength: otherParams.sample_strength !== undefined ? Number(otherParams.sample_strength) : undefined,
          intelligentRatio: otherParams.intelligent_ratio,
          upstreamChannel: otherParams.channel,
        });
        const requestHeaders: Record<string, string> = {};
        if (channel.apiKey) requestHeaders.Authorization = `Bearer ${channel.apiKey}`;
        const createResponse = await fetch(hmStudioCreateUrl(baseUrl, 'image'), {
          method: 'POST',
          headers: requestHeaders,
          body: formData,
          signal: AbortSignal.timeout(channel.timeout || 120_000),
        });
        if (!createResponse.ok) {
          const detail = await createResponse.text().catch(() => '');
          throw new Error(`HTTP ${createResponse.status}: ${detail.slice(0, 500)}`);
        }
        const job = await createResponse.json() as any;
        const taskId = job.task_id || job.id;
        if (!taskId) throw new Error('HM Studio did not return a task ID');
        const task = await waitForHmStudioTask({ baseUrl, taskId, apiKey: channel.apiKey });
        return { url: task.resultUrl };
      };

      const data = await Promise.all(Array.from({ length: count }, () => submitOne()));
      const responseBody = { created: Math.floor(Date.now() / 1000), data };
      const durationMs = Date.now() - startTime;
      deductTokenOrUserBalance(token, totalCost, model);
      db.insert(apiLogs).values({
        tokenId: token.id, channelId: channel.id, model, upstreamModel,
        cost: totalCost, durationMs, status: 'success', clientIp,
      }).run();
      try {
        saveApiImageAssets({
          token,
          responseBody,
          model,
          prompt,
          size,
          responseFormat: response_format,
          outputFormat: otherParams.output_format,
          operation: 'generation',
          totalCost,
        });
      } catch (assetError) {
        console.error('[v1/images/generations] HM Studio asset save failed:', assetError);
      }
      return res.json(responseBody);
    }

    const upstreamRes = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${channel.apiKey}`,
      },
      body: JSON.stringify({
        model: upstreamModel,
        prompt,
        n: count,
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

    try {
      saveApiImageAssets({
        token,
        responseBody,
        model,
        prompt,
        size,
        responseFormat: response_format,
        outputFormat: otherParams.output_format,
        operation: 'generation',
        totalCost,
      });
    } catch (assetError) {
      console.error('[v1/images/generations] 保存图片资产失败:', assetError);
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

  const uploadedFiles = Array.isArray(req.files) ? req.files : [];
  const imageFiles = uploadedFiles.filter(file => file.fieldname === 'image' || file.fieldname === 'image[]');
  if (imageFiles.length === 0) {
    cleanupFiles(req.files);
    return res.status(400).json({ error: { message: 'at least one image file is required', type: 'invalid_request_error' } });
  }
  if (imageFiles.length > 5) {
    cleanupFiles(req.files);
    return res.status(400).json({ error: { message: 'a maximum of 5 image files is allowed', type: 'invalid_request_error' } });
  }

  const count = Number(n);
  if (!Number.isInteger(count) || count < 1 || count > 4) {
    cleanupFiles(req.files);
    return res.status(400).json({ error: { message: 'n must be an integer between 1 and 4', type: 'invalid_request_error' } });
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
    if (isHmStudioChannel(channel)) {
      const imageSources = imageFiles.map(file => {
        const content = fs.readFileSync(file.path).toString('base64');
        return `data:${file.mimetype || 'image/png'};base64,${content}`;
      });
      const submitOne = async () => {
        const hmForm = buildHmStudioImageForm({
          model: upstreamModel,
          prompt,
          ratio: otherParams.ratio || otherParams.aspect_ratio || '1:1',
          resolution: otherParams.resolution || '2k',
          imageSources,
          negativePrompt: otherParams.negative_prompt,
          sampleStrength: otherParams.sample_strength !== undefined ? Number(otherParams.sample_strength) : 0.5,
          intelligentRatio: otherParams.intelligent_ratio,
          upstreamChannel: otherParams.channel,
        });
        const hmHeaders: Record<string, string> = {};
        if (channel.apiKey) hmHeaders.Authorization = `Bearer ${channel.apiKey}`;
        const createResponse = await fetch(hmStudioCreateUrl(baseUrl, 'image'), {
          method: 'POST', headers: hmHeaders, body: hmForm,
          signal: AbortSignal.timeout(channel.timeout || 120_000),
        });
        if (!createResponse.ok) {
          const detail = await createResponse.text().catch(() => '');
          throw new Error(`HTTP ${createResponse.status}: ${detail.slice(0, 500)}`);
        }
        const job = await createResponse.json() as any;
        const taskId = job.task_id || job.id;
        if (!taskId) throw new Error('HM Studio did not return a task ID');
        const task = await waitForHmStudioTask({ baseUrl, taskId, apiKey: channel.apiKey });
        return { url: task.resultUrl };
      };

      const data = await Promise.all(Array.from({ length: count }, () => submitOne()));
      cleanupFiles(req.files);
      const responseBody = { created: Math.floor(Date.now() / 1000), data };
      const durationMs = Date.now() - startTime;
      deductTokenOrUserBalance(token, totalCost, model);
      db.insert(apiLogs).values({
        tokenId: token.id, channelId: channel.id, model, upstreamModel,
        cost: totalCost, durationMs, status: 'success', clientIp,
      }).run();
      try {
        saveApiImageAssets({
          token, responseBody, model, prompt, size,
          responseFormat: response_format,
          outputFormat: otherParams.output_format,
          operation: 'edit', totalCost,
          referenceFileNames: imageFiles.map(file => file.originalname),
        });
      } catch (assetError) {
        console.error('[v1/images/edits] HM Studio asset save failed:', assetError);
      }
      return res.json(responseBody);
    }

    const formData = new FormData();
    formData.append('model', upstreamModel);
    formData.append('prompt', prompt);
    formData.append('n', String(count));
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

    try {
      saveApiImageAssets({
        token,
        responseBody,
        model,
        prompt,
        size,
        responseFormat: response_format,
        outputFormat: otherParams.output_format,
        operation: 'edit',
        totalCost,
        referenceFileNames: imageFiles.map(file => file.originalname),
      });
    } catch (assetError) {
      console.error('[v1/images/edits] 保存图片资产失败:', assetError);
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
  if (model === 'wan3.0th') {
    const allowedRatios = ['1:1', '16:9', '9:16', '4:3', '3:4'];
    if (!Number.isInteger(seconds) || seconds < 4 || seconds > 30) {
      cleanupFiles(req.files);
      return res.status(400).json({ error: 'wan3.0th seconds must be an integer from 4 to 30' });
    }
    if (!allowedRatios.includes(ratio)) {
      cleanupFiles(req.files);
      return res.status(400).json({ error: 'wan3.0th ratio must be one of 1:1, 16:9, 9:16, 4:3, 3:4' });
    }
    if (resolution !== '720p') {
      cleanupFiles(req.files);
      return res.status(400).json({ error: 'wan3.0th only supports 720p' });
    }
    if (image_urls.length > 10 || video_urls.length > 5 || audio_urls.length > 5) {
      cleanupFiles(req.files);
      return res.status(400).json({ error: 'wan3.0th supports at most 10 images, 5 videos, and 5 audio files' });
    }
    const invalidAudio = audio_urls.some(audio => {
      const value = String(audio).toLowerCase();
      if (value.startsWith('data:audio/wav') || value.startsWith('data:audio/x-wav')) return false;
      try { return !new URL(value).pathname.endsWith('.wav'); } catch { return !value.split('?')[0].endsWith('.wav'); }
    });
    if (invalidAudio) {
      cleanupFiles(req.files);
      return res.status(400).json({ error: 'wan3.0th audio references must be WAV files' });
    }
  }

  if (model === 'ad-seedance-2.5-480p') {
    if (!Number.isInteger(seconds) || seconds < 4 || seconds > 30) {
      cleanupFiles(req.files);
      return res.status(400).json({ error: 'ad-seedance-2.5-480p seconds must be an integer from 4 to 30' });
    }
    if (resolution !== '480p') {
      cleanupFiles(req.files);
      return res.status(400).json({ error: 'ad-seedance-2.5-480p only supports 480p' });
    }
    if (image_urls.length > 30 || video_urls.length > 10 || audio_urls.length > 10) {
      cleanupFiles(req.files);
      return res.status(400).json({ error: 'ad-seedance-2.5-480p supports at most 30 images, 10 videos, and 10 audio files' });
    }
  }

  if (model === 'vd-seedance-2.5-480p' || model === 'vd-seedance-2.5-720p') {
    const requiredResolution = model.endsWith('480p') ? '480p' : '720p';
    if (!Number.isInteger(seconds) || seconds < 4 || seconds > 30) {
      cleanupFiles(req.files);
      return res.status(400).json({ error: `${model} seconds must be an integer from 4 to 30` });
    }
    if (resolution !== requiredResolution) {
      cleanupFiles(req.files);
      return res.status(400).json({ error: `${model} only supports ${requiredResolution}` });
    }
    if (image_urls.length > 9 || video_urls.length > 3 || audio_urls.length > 0) {
      cleanupFiles(req.files);
      return res.status(400).json({ error: `${model} supports at most 9 images, 3 videos, and no audio files` });
    }
  }

  if (model === 'seedance_v2.5') {
    if (!Number.isInteger(seconds) || seconds < 4 || seconds > 30) {
      cleanupFiles(req.files);
      return res.status(400).json({ error: 'seedance_v2.5 seconds must be an integer from 4 to 30' });
    }
    if (resolution !== '720p') {
      cleanupFiles(req.files);
      return res.status(400).json({ error: 'seedance_v2.5 only supports 720p' });
    }
    if (image_urls.length > 10 || video_urls.length > 0 || audio_urls.length > 0) {
      cleanupFiles(req.files);
      return res.status(400).json({ error: 'seedance_v2.5 supports at most 10 images and does not support video/audio references' });
    }
  }

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
  const pricingQuote = PricingService.quote(model, { resolution, seconds, count: 1 }, false);
  if (!pricingQuote.billingType) {
    cleanupFiles(req.files);
    return res.status(400).json({ error: `Model ${model} has no pricing rule. Configure it in Admin > Pricing.` });
  }
  const totalCost = pricingQuote.cost;

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
      inputText: prompt.slice(0, 5000),
      modelId: model,
      cost: totalCost,
      status: 'processing',
      metadata: JSON.stringify({
        resolution,
        seconds,
        aspect_ratio: ratio,
        model,
        prompt: prompt.slice(0, 5000),
        image_urls,
        reference_images: image_urls,
        video_urls,
        reference_videos: video_urls,
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
  const isHmStudio = isHmStudioChannel(channel);
  const isMjNewApi = isMjNewApiChannel(channel);

  const upstreamUrl = isHmStudio
    ? hmStudioCreateUrl(baseUrl, 'video')
    : isSudaShuiModel
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

    if (isHmStudio) {
      const formData = buildHmStudioVideoForm({
        model: upstreamModel,
        prompt,
        duration: seconds,
        ratio,
        resolution,
        imageSources: image_urls,
        videoSources: video_urls,
        audioSources: audio_urls,
        firstFrame: body.first_frame_url,
        lastFrame: body.end_frame_url || body.last_frame_url,
        functionMode: body.function_mode,
        upstreamChannel: body.channel,
      });
      const headers: Record<string, string> = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      upstreamRes = await fetch(upstreamUrl, {
        method: 'POST',
        headers,
        body: formData,
        signal: AbortSignal.timeout(channel.timeout || 120_000),
      });
    } else if (isMjNewApi) {
      const invalidUrls = findInvalidMjNewApiMaterialUrls(image_urls, video_urls, audio_urls);
      if (invalidUrls.length > 0) {
        cleanupFiles(req.files);
        db.update(contents).set({ status: 'failed', cost: 0 }).where(eq(contents.id, contentId)).run();
        return res.status(400).json({ error: 'MJNewAPI reference materials must use publicly accessible HTTPS URLs. Check BACKEND_URL.' });
      }

      const payload = buildMjNewApiVideoPayload({
        model: upstreamModel,
        prompt,
        duration: seconds,
        aspectRatio: ratio,
        resolution,
        images: image_urls,
        videos: video_urls,
        audios: audio_urls,
      });

      console.log(`[v1-video] MJNewAPI create: model=${model} upstreamModel=${upstreamModel} duration=${seconds} resolution=${resolution} images=${image_urls.length} videos=${video_urls.length} audios=${audio_urls.length}`);

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      upstreamRes = await fetch(upstreamUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(channel.timeout || 120_000),
      });
    } else if (Array.isArray(req.files) && req.files.length > 0) {
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

  const { valid, error, token } = TokenService.validateToken(tokenKey);
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
    if (!canAccessVideoRecord(record, token)) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const status = record.status;
    let progress = 0;
    let metadata: Record<string, any> = {};
    try {
      metadata = JSON.parse(record.metadata || '{}');
      progress = status === 'completed' ? 100 : (metadata.progress || 0);
    } catch {}

    let mappedStatus = 'queued';
    if (status === 'completed') mappedStatus = 'completed';
    else if (status === 'failed') mappedStatus = 'failed';
    else if (status === 'processing') {
      mappedStatus = metadata.upstreamStatus || (progress > 0 ? 'processing' : 'queued');
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
      progress,
      progress_pct: progress,
      progress_text: metadata.progressText || undefined,
      upstream_task_id: metadata.videoId || undefined,
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
router.post('/videos/generations', upload.any(), handleVideoCreation);
router.post('/video/generations', upload.any(), handleVideoCreation);
router.get('/videos/:id', handleVideoQuery);
router.get('/videos/generations/:id', handleVideoQuery);
router.get('/video/generations/:id', handleVideoQuery);

/** GET /v1/videos/:id/content — 统一视频内容直连下载/播放 */
router.get('/videos/:id/content', async (req: Request, res: Response) => {
  const tokenKey = extractToken(req);
  if (!tokenKey) return res.status(401).json({ error: { message: 'Missing API key', type: 'invalid_request_error' } });

  const { valid, error, token } = TokenService.validateToken(tokenKey);
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

  if (!canAccessVideoRecord(record, token)) {
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

  if (url.startsWith('/uploads/')) {
    isLocalFile = true;
    const cleanPath = url.replace(/^.*\/uploads\//, '');
    localFilePath = path.join(process.cwd(), 'data/uploads', cleanPath);
  } else if (url.startsWith('http://') || url.startsWith('https://')) {
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.host === req.get('host') && parsedUrl.pathname.startsWith('/uploads/')) {
        isLocalFile = true;
        const cleanPath = parsedUrl.pathname.slice('/uploads/'.length);
        localFilePath = path.join(process.cwd(), 'data/uploads', cleanPath);
      }
    } catch { }
  } else {
    return res.status(502).json({ error: 'Invalid stored video URL' });
  }

  if (isLocalFile) {
    if (fs.existsSync(localFilePath)) {
      res.setHeader('Content-Type', path.extname(localFilePath).toLowerCase() === '.webm' ? 'video/webm' : 'video/mp4');
      return res.sendFile(localFilePath);
    }
  }

  try {
    let metadata: any = {};
    try { metadata = JSON.parse(record.metadata || '{}'); } catch { }

    const { downloadAndLocalizeVideo } = await import('./video.js');
    const localizedUrl = await downloadAndLocalizeVideo(
      url,
      idParam,
      record.modelId || metadata.model || 'video',
      metadata.channelId,
    );
    const cleanPath = localizedUrl.replace(/^.*\/uploads\//, '');
    const localizedPath = path.join(process.cwd(), 'data', 'uploads', cleanPath);

    metadata.progress = 100;
    metadata.localizedAt = metadata.localizedAt || new Date().toISOString();
    db.update(contents).set({
      resultUrl: localizedUrl,
      metadata: JSON.stringify(metadata),
    }).where(eq(contents.id, contentId)).run();

    res.setHeader('Content-Type', path.extname(localizedPath).toLowerCase() === '.webm' ? 'video/webm' : 'video/mp4');
    return res.sendFile(localizedPath);
  } catch (err: any) {
    res.status(502).send(`Video localization failed: ${err.message}`);
  }
});

/** GET /v1/files/video — 视频下载管道代理 */
router.get('/files/video', async (req: Request, res: Response) => {
  const tokenKey = extractToken(req);
  if (!tokenKey) return res.status(401).json({ error: { message: 'Missing API key', type: 'invalid_request_error' } });

  const { valid, error } = TokenService.validateToken(tokenKey);
  if (!valid) return res.status(401).json({ error: { message: error, type: 'invalid_request_error' } });

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
