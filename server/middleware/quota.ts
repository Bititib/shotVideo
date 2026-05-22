import { Response, NextFunction } from 'express';
import { db } from '../db/index.js';
import { usageLogs } from '../db/schema.js';
import { eq, and, gte, sql } from 'drizzle-orm';
import type { TierRequest } from './tier.js';

/**
 * 配额检查中间件
 * 检查用户今日使用次数是否超过等级限制
 */
export function quotaMiddleware(req: TierRequest, res: Response, next: NextFunction) {
  if (!req.userId || !req.userTier) {
    return res.status(401).json({ error: '请先登录' });
  }

  const { dailyQuota } = req.userTier;

  // -1 表示不限
  if (dailyQuota === -1) {
    return next();
  }

  const today = new Date().toISOString().split('T')[0];
  const todayUsage = db.select({ count: sql<number>`count(*)` })
    .from(usageLogs)
    .where(and(
      eq(usageLogs.userId, req.userId),
      gte(usageLogs.createdAt, today)
    ))
    .get();

  const usedToday = todayUsage?.count ?? 0;

  if (usedToday >= dailyQuota) {
    return res.status(429).json({
      error: '今日 AI 分析次数已用完',
      usedToday,
      dailyQuota,
      message: '升级会员等级可获取更多使用次数',
    });
  }

  next();
}

/**
 * 记录使用日志（在响应完成后调用）
 */
export function logUsage(userId: number, analysisType: string, modelId?: number, durationMs?: number) {
  db.insert(usageLogs).values({
    userId,
    analysisType,
    modelId,
    durationMs,
  }).run();
}
