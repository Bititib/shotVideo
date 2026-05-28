import { Response, NextFunction } from 'express';
import type { AuthRequest } from './auth.js';

/** 检查是否为平台超级管理员 */
export function isSuperAdmin(role?: string): boolean {
  return role === 'super_admin' || role === 'admin'; // 兼容旧角色
}

/** 检查是否为组织管理角色（owner / admin） */
export function isOrgAdmin(role?: string): boolean {
  return role === 'org_owner' || role === 'org_admin';
}

/**
 * 超级管理员权限中间件
 * 必须在 authMiddleware 之后使用
 */
export function adminMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  if (!isSuperAdmin(req.userRole)) {
    return res.status(403).json({ error: '需要超级管理员权限' });
  }
  next();
}

/**
 * 组织管理权限中间件
 * 允许 super_admin + org_owner + org_admin 访问
 */
export function orgAdminMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  if (!isSuperAdmin(req.userRole) && !isOrgAdmin(req.userRole)) {
    return res.status(403).json({ error: '需要组织管理权限' });
  }
  next();
}
