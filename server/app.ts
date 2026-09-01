import express from 'express';
import path from 'path';
import fs from 'fs';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
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
import userTokenRoutes from './routes/userTokens.js';
import feedbackRoutes from './routes/feedback.js';

import { AdminService } from './services/adminService.js';

// 认证接口限流：提升限流门槛，防止代理 IP 共享导致误封锁
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: '登录尝试过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

export async function createApp() {
  const app = express();

  // 信任所有前置反向代理（Nginx / Docker 网桥 / Cloudflare），确保精准获取真实客户端 IP
  app.set('trust proxy', true);

  // 安全中间件
  app.use(helmet({ contentSecurityPolicy: false }));  // CSP 关闭以兼容 Vite
  // CORS：生产环境限制为指定域名
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean);
  app.use(cors(allowedOrigins?.length ? { origin: allowedOrigins, credentials: true } : undefined));
  // Compress API responses and static assets. The reverse proxy currently
  // forwards them uncompressed, so doing this here avoids full-size transfers.
  app.use(compression());
  // Body parsing
  app.use(express.json({ limit: '150mb' }));

  // Static uploads directory serving
  const uploadDir = path.resolve(process.cwd(), 'data/uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  app.use('/uploads/history-assets', express.static(path.join(uploadDir, 'history-assets'), {
    immutable: true,
    maxAge: '1y',
  }));
  app.use('/uploads', express.static(uploadDir));

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
  app.use('/api/tokens', userTokenRoutes);
  app.use('/api/org', orgRoutes);
  app.use('/api/contents', contentRoutes);
  app.use('/api/feedback', feedbackRoutes);

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
    // Vite asset filenames contain a content hash and can be cached forever.
    app.use('/assets', express.static(path.join(distPath, 'assets'), {
      immutable: true,
      maxAge: '1y',
    }));
    // Keep index.html and other unhashed files revalidatable so deployments
    // are picked up without leaving users on an old application shell.
    app.use(express.static(distPath, { maxAge: 0 }));
    // SPA fallback：仅非 API 路径返回 index.html
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/v1')) {
        return res.status(404).json({ error: 'Not found' });
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // 全局错误处理
  app.use(errorHandler);

  return app;
}
