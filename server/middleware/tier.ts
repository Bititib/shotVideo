import { Response, NextFunction } from 'express';
import { db } from '../db/index.js';
import { users, tiers, tierModelAccess, models } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { AuthRequest } from './auth.js';

export interface TierRequest extends AuthRequest {
  userTier?: {
    id: number;
    name: string;
    dailyQuota: number;
    allowedFeatures: string[];
  };
  availableModels?: { id: number; modelId: string; apiKey: string | null }[];
}

/**
 * 等级权限中间件
 * 检查用户等级是否允许使用请求的功能
 * @param feature - 功能标识 (general/ecommerce/image/copywriting/account/generate_image/modify_prompt)
 */
export function tierMiddleware(feature: string) {
  return (req: TierRequest, res: Response, next: NextFunction) => {
    if (!req.userId) {
      return res.status(401).json({ error: '请先登录' });
    }

    const user = db.select().from(users).where(eq(users.id, req.userId)).get();
    if (!user || !user.isActive) {
      return res.status(403).json({ error: '账号已被禁用' });
    }

    // 检查会员过期
    if (user.tierExpiresAt && new Date(user.tierExpiresAt) < new Date()) {
      const freeTier = db.select().from(tiers).where(eq(tiers.name, 'free')).get();
      if (freeTier) {
        db.update(users).set({ tierId: freeTier.id, tierExpiresAt: null }).where(eq(users.id, req.userId)).run();
        user.tierId = freeTier.id;
      }
    }

    const tier = db.select().from(tiers).where(eq(tiers.id, user.tierId)).get();
    if (!tier) {
      return res.status(500).json({ error: '等级配置异常' });
    }

    const allowedFeatures: string[] = JSON.parse(tier.allowedFeatures);

    // 管理员或拥有通配符权限
    if (user.role === 'admin' || allowedFeatures.includes('*') || allowedFeatures.includes(feature)) {
      req.userTier = {
        id: tier.id,
        name: tier.name,
        dailyQuota: user.quotaOverride ?? tier.dailyQuota,
        allowedFeatures,
      };

      // 获取该等级可用的模型列表
      const accessList = db.select().from(tierModelAccess).where(eq(tierModelAccess.tierId, tier.id)).all();
      const modelIds = accessList.map(a => a.modelId);
      if (modelIds.length > 0) {
        req.availableModels = db.select().from(models)
          .where(eq(models.isActive, 1))
          .all()
          .filter(m => modelIds.includes(m.id))
          .map(m => ({ id: m.id, modelId: m.modelId, apiKey: m.apiKey }));
      } else {
        req.availableModels = [];
      }

      return next();
    }

    return res.status(403).json({
      error: '您的当前等级无法使用此功能',
      currentTier: tier.displayName,
      requiredFeature: feature,
    });
  };
}
