import { Router, Request, Response } from 'express';
import { TokenService } from '../services/tokenService.js';
import { ChannelService } from '../services/channelService.js';
import { PricingService } from '../services/pricingService.js';
import { db } from '../db/index.js';
import { apiLogs } from '../db/schema.js';

const router = Router();

/** 从请求头中提取 Bearer Token */
function extractToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7).trim();
}

/** GET /v1/models — 返回当前 Token 可用的模型列表 */
router.get('/models', (req: Request, res: Response) => {
  const tokenKey = extractToken(req);
  if (!tokenKey) return res.status(401).json({ error: { message: 'Missing API key', type: 'invalid_request_error' } });

  const { valid, error, token } = TokenService.validateToken(tokenKey);
  if (!valid) return res.status(401).json({ error: { message: error, type: 'invalid_request_error' } });

  // 汇总所有启用渠道支持的模型
  const activeChannels = ChannelService.getActiveChannels();
  const allModels = new Set<string>();
  for (const ch of activeChannels) {
    for (const m of ch.supportedModels) {
      if (m !== '*') allModels.add(m);
    }
  }

  // 如果 Token 限制了模型范围，则取交集
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

/** POST /v1/chat/completions — 核心代理转发 */
router.post('/chat/completions', async (req: Request, res: Response) => {
  const startTime = Date.now();
  const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || '';

  // 1) Token 鉴权
  const tokenKey = extractToken(req);
  if (!tokenKey) return res.status(401).json({ error: { message: 'Missing API key', type: 'invalid_request_error' } });

  const { valid, error, token } = TokenService.validateToken(tokenKey);
  if (!valid) return res.status(401).json({ error: { message: error, type: 'invalid_request_error' } });

  // 2) 解析请求
  const { model, messages, stream = false, ...otherParams } = req.body;
  if (!model) return res.status(400).json({ error: { message: 'model is required', type: 'invalid_request_error' } });
  if (!messages) return res.status(400).json({ error: { message: 'messages is required', type: 'invalid_request_error' } });

  // 3) 检查模型权限
  if (token.allowedModels.length > 0 && !token.allowedModels.includes(model)) {
    return res.status(403).json({ error: { message: `Token has no access to model ${model}`, type: 'permission_error' } });
  }

  // 4) 查找可用渠道
  const channel = ChannelService.findChannelForModel(model);
  if (!channel) {
    return res.status(404).json({ error: { message: `No available channel for model ${model}`, type: 'not_found_error' } });
  }

  // 5) 模型名映射
  const upstreamModel = channel.modelMapping[model] || model;

  // 6) 构建上游请求
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

      // 记录错误日志
      db.insert(apiLogs).values({
        tokenId: token.id,
        channelId: channel.id,
        model,
        upstreamModel,
        durationMs,
        status: 'error',
        errorMessage: `HTTP ${upstreamRes.status}: ${errBody.slice(0, 500)}`,
        clientIp,
      }).run();

      return res.status(upstreamRes.status).json(JSON.parse(errBody));
    }

    // 7) 流式转发
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

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

          // 尝试从最后的 [DONE] 前的 chunk 中提取 usage 信息
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.usage) {
                  totalPromptTokens = data.usage.prompt_tokens || 0;
                  totalCompletionTokens = data.usage.completion_tokens || 0;
                }
              } catch { /* ignore parse errors in stream */ }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      res.end();

      // 计费 + 日志
      const cost = PricingService.calculateCost(model, totalPromptTokens, totalCompletionTokens);
      TokenService.deductBalance(token.id, cost);
      db.insert(apiLogs).values({
        tokenId: token.id, channelId: channel.id, model, upstreamModel,
        promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens,
        totalTokens: totalPromptTokens + totalCompletionTokens,
        cost, durationMs: Date.now() - startTime, status: 'success', clientIp,
      }).run();
      return;
    }

    // 8) 非流式转发
    const responseBody = await upstreamRes.json();
    const durationMs = Date.now() - startTime;

    const promptTokens = responseBody.usage?.prompt_tokens || 0;
    const completionTokens = responseBody.usage?.completion_tokens || 0;
    const totalTokens = responseBody.usage?.total_tokens || promptTokens + completionTokens;

    // 计费
    const cost = PricingService.calculateCost(model, promptTokens, completionTokens);
    TokenService.deductBalance(token.id, cost);

    // 记录日志
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

export default router;
