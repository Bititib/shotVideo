import express from 'express';
import path from 'path';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createServer as createViteServer } from 'vite';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import analysisRoutes from './routes/analysis.js';
import proxyRoutes from './routes/proxy.js';
import adminRoutes from './routes/admin.js';
import channelRoutes from './routes/channels.js';
import tokenRoutes from './routes/tokens.js';
import pricingRoutes from './routes/pricing.js';
import v1Routes from './routes/v1.js';
import videoRoutes from './routes/video.js';
import imageGenRoutes from './routes/imageGen.js';
import orgRoutes from './routes/org.js';
import contentRoutes from './routes/content.js';

import { AdminService } from './services/adminService.js';

// 全局限流：每个 IP 每分钟最多 60 次请求
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: '请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

// 认证接口限流：每个 IP 每 15 分钟最多 15 次（防暴力破解）
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: '登录/注册尝试过于频繁，请15分钟后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

export async function createApp() {
  const app = express();

  // 安全中间件
  app.use(helmet({ contentSecurityPolicy: false }));  // CSP 关闭以兼容 Vite
  // CORS：生产环境限制为指定域名
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean);
  app.use(cors(allowedOrigins?.length ? { origin: allowedOrigins, credentials: true } : undefined));
  app.use(globalLimiter);

  // Body parsing
  app.use(express.json({ limit: '50mb' }));

  // OpenAI 兼容代理层（不走 /api 前缀）
  app.use('/v1', v1Routes);

  // API 路由（认证接口额外加严格限流）
  app.use('/api/auth', authLimiter, authRoutes);
  app.use('/api/analysis', analysisRoutes);
  app.use('/api/proxy', proxyRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/admin/channels', channelRoutes);
  app.use('/api/admin/tokens', tokenRoutes);
  app.use('/api/admin/pricing', pricingRoutes);
  app.use('/api/video', videoRoutes);
  app.use('/api/image-gen', imageGenRoutes);
  app.use('/api/org', orgRoutes);
  app.use('/api/contents', contentRoutes);

  // 公开设置接口（联系方式等）
  app.get('/api/settings', (req, res) => {
    try {
      res.json(AdminService.getPublicSettings());
    } catch { res.json({}); }
  });

  // Vite 中间件 (开发模式) or 静态文件 (生产模式)
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      root: path.resolve(process.cwd(), 'client'),
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'client', 'dist');
    app.use(express.static(distPath));
    // SPA fallback：仅非 API 路径返回 index.html
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/v1')) {
        return res.status(404).json({ error: 'Not found' });
      }
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // 全局错误处理
  app.use(errorHandler);

  return app;
}
