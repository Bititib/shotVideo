import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { TokenService } from '../services/tokenService.js';

export interface AuthRequest extends Request {
  userId?: number;
  userRole?: string;
  orgId?: number | null;
}

/**
 * JWT 认证中间件
 * 从 Authorization: Bearer <token> 中解析用户身份
 */
export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '请先登录' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as { userId: number; role: string; orgId?: number | null };
    req.userId = decoded.userId;
    req.userRole = decoded.role;
    req.orgId = decoded.orgId || null;
    next();
  } catch (err) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

/** 仅允许已开通并启用 API Key 的登录用户访问。 */
export function activeApiKeyMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.userId) return res.status(401).json({ error: '请先登录' });
  if (!TokenService.hasActiveTokenForUser(req.userId)) {
    return res.status(403).json({
      error: '该功能仅对已开通 API Key 的用户开放',
      code: 'API_KEY_REQUIRED',
    });
  }
  next();
}

/**
 * 可选认证中间件
 * 有 token 就解析用户身份，没有或无效也放行（userId 为 undefined）
 * 适用于"浏览可见、操作再登录"的公开接口
 */
export function optionalAuthMiddleware(req: AuthRequest, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, env.JWT_SECRET) as { userId: number; role: string; orgId?: number | null };
      req.userId = decoded.userId;
      req.userRole = decoded.role;
      req.orgId = decoded.orgId || null;
    } catch {
      // token 无效，不阻塞，当做未登录处理
    }
  }
  next();
}
