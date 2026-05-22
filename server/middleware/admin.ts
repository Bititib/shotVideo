import { Response, NextFunction } from 'express';
import type { AuthRequest } from './auth.js';

/**
 * 管理员权限中间件
 * 必须在 authMiddleware 之后使用
 */
export function adminMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}
