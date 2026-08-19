import { db } from '../db/index.js';
import { users, tiers, models, tierModelAccess, usageLogs, settings, contents, apiLogs } from '../db/schema.js';
import { eq, like, and, gte, sql, desc, count } from 'drizzle-orm';
import bcrypt from 'bcryptjs';

interface GetUsersOptions {
  page: number;
  pageSize: number;
  search?: string;
  tierId?: number;
  isActive?: number;
}

export class AdminService {
  // ============ 仪表盘 ============
  static getDashboardStats() {
    const totalUsers = db.select({ count: sql<number>`count(*)` }).from(users).get()?.count || 0;

    const today = new Date().toISOString().split('T')[0];
    const todayCalls = db.select({ count: sql<number>`count(*)` })
      .from(usageLogs)
      .where(gte(usageLogs.createdAt, today))
      .get()?.count || 0;

    const todayActiveUsers = db.select({ count: sql<number>`count(distinct user_id)` })
      .from(usageLogs)
      .where(gte(usageLogs.createdAt, today))
      .get()?.count || 0;

    const totalCalls = db.select({ count: sql<number>`count(*)` }).from(usageLogs).get()?.count || 0;

    // 等级分布
    const tierDistribution = db.select({
      tierName: tiers.displayName,
      count: sql<number>`count(*)`,
    }).from(users)
      .leftJoin(tiers, eq(users.tierId, tiers.id))
      .groupBy(tiers.displayName)
      .all();

    // 功能使用分布
    const featureDistribution = db.select({
      type: usageLogs.analysisType,
      count: sql<number>`count(*)`,
    }).from(usageLogs)
      .groupBy(usageLogs.analysisType)
      .all();

    // 近7天趋势
    const trend7Days = db.select({
      date: sql<string>`date(created_at)`,
      count: sql<number>`count(*)`,
    }).from(usageLogs)
      .where(gte(usageLogs.createdAt, sql`date('now', '-7 days')`))
      .groupBy(sql`date(created_at)`)
      .orderBy(sql`date(created_at)`)
      .all();

    return {
      totalUsers,
      todayActiveUsers,
      todayCalls,
      totalCalls,
      tierDistribution,
      featureDistribution,
      trend7Days,
    };
  }

  // ============ 用户管理 ============
  static getUsers(options: GetUsersOptions) {
    const { page, pageSize, search, tierId, isActive } = options;
    const offset = (page - 1) * pageSize;

    let query = db.select({
      id: users.id,
      email: users.email,
      username: users.username,
      role: users.role,
      tierId: users.tierId,
      tierName: tiers.displayName,
      tierExpiresAt: users.tierExpiresAt,
      quotaOverride: users.quotaOverride,
      balance: users.balance,
      isActive: users.isActive,
      createdAt: users.createdAt,
    }).from(users)
      .leftJoin(tiers, eq(users.tierId, tiers.id))
      .$dynamic();

    // Build conditions
    const conditions: any[] = [];
    if (search) {
      conditions.push(like(users.email, `%${search}%`));
    }
    if (tierId !== undefined) {
      conditions.push(eq(users.tierId, tierId));
    }
    if (isActive !== undefined) {
      conditions.push(eq(users.isActive, isActive));
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const items = query.orderBy(desc(users.createdAt)).limit(pageSize).offset(offset).all();

    // 获取每个用户的今日用量
    const today = new Date().toISOString().split('T')[0];
    const usersWithUsage = items.map(u => {
      const usage = db.select({ count: sql<number>`count(*)` })
        .from(usageLogs)
        .where(and(eq(usageLogs.userId, u.id), gte(usageLogs.createdAt, today)))
        .get();
      return { ...u, usedToday: usage?.count || 0 };
    });

    // 总条数
    let countQuery = db.select({ count: sql<number>`count(*)` }).from(users).$dynamic();
    if (conditions.length > 0) {
      countQuery = countQuery.where(and(...conditions));
    }
    const total = countQuery.get()?.count || 0;

    return { items: usersWithUsage, total, page, pageSize };
  }

  static updateUser(userId: number, updates: any) {
    const user = db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) throw { status: 404, message: '用户不存在' };

    const allowedFields: Record<string, any> = {};
    if (updates.tierId !== undefined) allowedFields.tierId = updates.tierId;
    if (updates.tierExpiresAt !== undefined) allowedFields.tierExpiresAt = updates.tierExpiresAt || null;
    if (updates.isActive !== undefined) allowedFields.isActive = updates.isActive;
    if (updates.role !== undefined) allowedFields.role = updates.role;
    if (updates.quotaOverride !== undefined) allowedFields.quotaOverride = updates.quotaOverride || null;
    if (updates.balance !== undefined) allowedFields.balance = Math.max(0, Number(updates.balance) || 0);
    if (updates.username !== undefined) allowedFields.username = updates.username;

    if (updates.password !== undefined && updates.password.trim() !== '') {
      if (updates.password.length < 6) throw { status: 400, message: '密码至少6位' };
      allowedFields.passwordHash = bcrypt.hashSync(updates.password, 12);
    }

    allowedFields.updatedAt = new Date().toISOString();

    db.update(users).set(allowedFields).where(eq(users.id, userId)).run();
  }

  static deleteUser(userId: number) {
    const user = db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) throw { status: 404, message: '用户不存在' };
    if (user.role === 'admin') throw { status: 400, message: '不能删除管理员账号' };

    db.delete(usageLogs).where(eq(usageLogs.userId, userId)).run();
    db.delete(users).where(eq(users.id, userId)).run();
  }

  // ============ 等级管理 ============
  static getTiers() {
    const allTiers = db.select().from(tiers).orderBy(tiers.sortOrder).all();

    return allTiers.map(t => {
      const modelAccess = db.select({
        modelId: models.id,
        modelName: models.displayName,
        modelIdentifier: models.modelId,
      }).from(tierModelAccess)
        .innerJoin(models, eq(tierModelAccess.modelId, models.id))
        .where(eq(tierModelAccess.tierId, t.id))
        .all();

      const userCount = db.select({ count: sql<number>`count(*)` })
        .from(users)
        .where(eq(users.tierId, t.id))
        .get()?.count || 0;

      return {
        ...t,
        allowedFeatures: JSON.parse(t.allowedFeatures),
        models: modelAccess,
        userCount,
      };
    });
  }

  static createTier(data: any) {
    const { name, displayName, dailyQuota, allowedFeatures, sortOrder, modelIds } = data;
    if (!name || !displayName) throw { status: 400, message: '等级标识和名称不能为空' };

    const result = db.insert(tiers).values({
      name,
      displayName,
      dailyQuota: dailyQuota ?? 3,
      allowedFeatures: JSON.stringify(allowedFeatures || []),
      sortOrder: sortOrder ?? 0,
    }).run();

    const tierId = Number(result.lastInsertRowid);

    if (modelIds?.length > 0) {
      db.insert(tierModelAccess).values(
        modelIds.map((mId: number) => ({ tierId, modelId: mId }))
      ).run();
    }
  }

  static updateTier(tierId: number, data: any) {
    const tier = db.select().from(tiers).where(eq(tiers.id, tierId)).get();
    if (!tier) throw { status: 404, message: '等级不存在' };

    const updates: Record<string, any> = {};
    if (data.displayName !== undefined) updates.displayName = data.displayName;
    if (data.dailyQuota !== undefined) updates.dailyQuota = data.dailyQuota;
    if (data.allowedFeatures !== undefined) updates.allowedFeatures = JSON.stringify(data.allowedFeatures);
    if (data.sortOrder !== undefined) updates.sortOrder = data.sortOrder;
    if (data.isActive !== undefined) updates.isActive = data.isActive;

    if (Object.keys(updates).length > 0) {
      db.update(tiers).set(updates).where(eq(tiers.id, tierId)).run();
    }

    // 更新模型关联
    if (data.modelIds !== undefined) {
      db.delete(tierModelAccess).where(eq(tierModelAccess.tierId, tierId)).run();
      if (data.modelIds.length > 0) {
        db.insert(tierModelAccess).values(
          data.modelIds.map((mId: number) => ({ tierId, modelId: mId }))
        ).run();
      }
    }
  }

  static deleteTier(tierId: number) {
    // 检查是否有用户在使用此等级
    const userCount = db.select({ count: sql<number>`count(*)` })
      .from(users)
      .where(eq(users.tierId, tierId))
      .get()?.count || 0;

    if (userCount > 0) {
      throw { status: 400, message: `还有 ${userCount} 个用户在使用此等级，无法删除` };
    }

    db.delete(tierModelAccess).where(eq(tierModelAccess.tierId, tierId)).run();
    db.delete(tiers).where(eq(tiers.id, tierId)).run();
  }

  // ============ 模型管理 ============
  static getModels() {
    const allModels = db.select().from(models).all();
    return allModels.map(m => {
      // 1. contents 表 (视频/多媒体生成任务)
      const contentRows = db.select().from(contents)
        .where(eq(contents.modelId, m.modelId))
        .all();

      let contentTotal = contentRows.length;
      let contentSuccessCount = 0;
      let contentFailCount = 0;
      let contentTotalDurationMs = 0;

      for (const row of contentRows) {
        if (row.status === 'completed' && row.resultUrl && row.resultUrl.trim() !== '') {
          contentSuccessCount++;
          let dur = 0;
          try {
            const meta = row.metadata ? JSON.parse(row.metadata) : {};
            if (meta.durationMs && typeof meta.durationMs === 'number') {
              dur = meta.durationMs;
            }
          } catch {}
          if (!dur && row.createdAt) {
            const createdTime = new Date(row.createdAt).getTime();
            if (!isNaN(createdTime) && createdTime > 0) {
              dur = Math.max(1000, Date.now() - createdTime);
            }
          }
          contentTotalDurationMs += dur;
        } else if (row.status === 'failed') {
          contentFailCount++;
        }
      }

      // 2. apiLogs 表 (开放 API 接口调用)
      const apiLogRows = db.select().from(apiLogs)
        .where(eq(apiLogs.model, m.modelId))
        .all();

      let apiTotal = apiLogRows.length;
      let apiSuccessCount = 0;
      let apiFailCount = 0;
      let apiTotalDurationMs = 0;

      for (const row of apiLogRows) {
        if (row.status === 'success') {
          apiSuccessCount++;
          if (row.durationMs && row.durationMs > 0) {
            apiTotalDurationMs += row.durationMs;
          }
        } else {
          apiFailCount++;
        }
      }

      // 3. usageLogs 表 (系统内部分析调用)
      const usageLogRows = db.select().from(usageLogs)
        .where(eq(usageLogs.modelId, m.id))
        .all();

      let usageTotal = usageLogRows.length;
      let usageSuccessCount = 0;
      let usageFailCount = 0;
      let usageTotalDurationMs = 0;

      for (const row of usageLogRows) {
        if (row.status === 'error' || row.status === 'failed') {
          usageFailCount++;
        } else {
          usageSuccessCount++;
          if (row.durationMs && row.durationMs > 0) {
            usageTotalDurationMs += row.durationMs;
          }
        }
      }

      // 综合统计
      const totalCalls = contentTotal + apiTotal + usageTotal;
      const totalSuccessCalls = contentSuccessCount + apiSuccessCount + usageSuccessCount;
      const totalFailCalls = contentFailCount + apiFailCount + usageFailCount;
      const totalDurationMs = contentTotalDurationMs + apiTotalDurationMs + usageTotalDurationMs;

      // 平均耗时（按分钟计算，仅根据成功获取到 URL / 成功调用的任务）
      let avgDurationMinutes = 0;
      if (totalSuccessCalls > 0) {
        avgDurationMinutes = Number((totalDurationMs / totalSuccessCalls / 1000 / 60).toFixed(1));
      }

      // 正常率与失败率 (%)
      let successRate = 100;
      let failureRate = 0;
      if (totalCalls > 0) {
        successRate = Number(((totalSuccessCalls / totalCalls) * 100).toFixed(1));
        failureRate = Number(((totalFailCalls / totalCalls) * 100).toFixed(1));
      }

      return {
        ...m,
        capabilities: JSON.parse(m.capabilities),
        apiKey: m.apiKey ? '****' + m.apiKey.slice(-4) : null, // 脱敏显示
        totalCalls,
        successCalls: totalSuccessCalls,
        failCalls: totalFailCalls,
        avgDurationMinutes,
        successRate,
        failureRate,
      };
    });
  }

  static createModel(data: any) {
    const { provider, modelId, displayName, description, apiKey, capabilities } = data;
    if (!modelId || !displayName) throw { status: 400, message: '模型ID和名称不能为空' };

    db.insert(models).values({
      provider: provider || 'google',
      modelId,
      displayName,
      description: description || null,
      apiKey: apiKey || null,
      capabilities: JSON.stringify(capabilities || ['text']),
    }).run();
  }

  static updateModel(modelId: number, data: any) {
    const model = db.select().from(models).where(eq(models.id, modelId)).get();
    if (!model) throw { status: 404, message: '模型不存在' };

    const updates: Record<string, any> = {};
    if (data.displayName !== undefined) updates.displayName = data.displayName;
    if (data.description !== undefined) updates.description = data.description || null;
    if (data.provider !== undefined) updates.provider = data.provider;
    if (data.apiKey !== undefined) updates.apiKey = data.apiKey || null;
    if (data.capabilities !== undefined) updates.capabilities = JSON.stringify(data.capabilities);
    if (data.isActive !== undefined) updates.isActive = data.isActive;

    if (Object.keys(updates).length > 0) {
      db.update(models).set(updates).where(eq(models.id, modelId)).run();
    }
  }

  static deleteModel(modelId: number) {
    db.delete(tierModelAccess).where(eq(tierModelAccess.modelId, modelId)).run();
    db.delete(models).where(eq(models.id, modelId)).run();
  }

  // ============ 系统设置 ============
  static getSettings() {
    return db.select().from(settings).all();
  }

  static updateSettings(items: { key: string; value: string }[]) {
    for (const item of items) {
      db.update(settings)
        .set({ value: item.value, updatedAt: new Date().toISOString() })
        .where(eq(settings.key, item.key))
        .run();
    }
  }

  /** 公开接口：返回 key-value 对象 */
  static getPublicSettings() {
    const rows = db.select({ key: settings.key, value: settings.value }).from(settings).all();
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }
}
