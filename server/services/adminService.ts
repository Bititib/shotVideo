import { db } from '../db/index.js';
import { users, tiers, models, tierModelAccess, usageLogs, settings, contents, apiLogs, modelPricing, channels, channelApiKeys } from '../db/schema.js';
import { eq, like, and, gte, sql, desc, count } from 'drizzle-orm';
import bcrypt from 'bcryptjs';

interface GetUsersOptions {
  page: number;
  pageSize: number;
  search?: string;
  tierId?: number;
  isActive?: number;
}

const DELETED_MODELS_SETTING = 'deleted_model_ids';
const HM_STUDIO_BASE_URL = 'https://dnyovzpgyokm.sealosbja.site';

function linkHmStudioModel(modelId: string, apiKey?: string | null) {
  let channel = db.select().from(channels).all().find(item =>
    item.type === 'hmstudio' || item.baseUrl?.replace(/\/+$/, '') === HM_STUDIO_BASE_URL
  );
  if (!channel) {
    const result = db.insert(channels).values({
      name: 'HM Studio 渠道', type: 'hmstudio', baseUrl: HM_STUDIO_BASE_URL,
      apiKey: '', supportedModels: '[]', modelMapping: '{}',
      status: apiKey ? 1 : 0, priority: 10, weight: 1,
      concurrencyLimit: Number.parseInt(process.env.HM_STUDIO_CONCURRENCY || '10', 10) || 10,
      maxRetries: 3, timeout: 120000,
    }).run();
    channel = db.select().from(channels).where(eq(channels.id, Number(result.lastInsertRowid))).get();
  }
  if (!channel) return;

  let supportedModels: string[] = [];
  let modelMapping: Record<string, string> = {};
  try { supportedModels = JSON.parse(channel.supportedModels || '[]'); } catch { }
  try { modelMapping = JSON.parse(channel.modelMapping || '{}'); } catch { }
  if (!Array.isArray(supportedModels)) supportedModels = [];
  if (!supportedModels.includes(modelId)) supportedModels.push(modelId);
  modelMapping[modelId] = modelId;

  const updates: Record<string, any> = {
    name: 'HM Studio 渠道', type: 'hmstudio', baseUrl: HM_STUDIO_BASE_URL,
    supportedModels: JSON.stringify(supportedModels),
    modelMapping: JSON.stringify(modelMapping),
    updatedAt: new Date().toISOString(),
  };
  if (apiKey) {
    updates.status = 1;
    const existingKey = db.select().from(channelApiKeys).where(eq(channelApiKeys.apiKey, apiKey)).get();
    if (!existingKey) {
      db.insert(channelApiKeys).values({
        channelId: channel.id,
        apiKey,
        concurrencyLimit: Number.parseInt(process.env.HM_STUDIO_CONCURRENCY || '10', 10) || 10,
        status: 1,
      }).run();
    }
  }
  db.update(channels).set(updates).where(eq(channels.id, channel.id)).run();
}

function getDeletedModelIds(): Set<string> {
  const row = db.select().from(settings).where(eq(settings.key, DELETED_MODELS_SETTING)).get();
  try {
    const values = JSON.parse(row?.value || '[]');
    return new Set(Array.isArray(values) ? values.map(String) : []);
  } catch {
    return new Set();
  }
}

function saveDeletedModelIds(ids: Set<string>) {
  const value = JSON.stringify(Array.from(ids).sort());
  const existing = db.select().from(settings).where(eq(settings.key, DELETED_MODELS_SETTING)).get();
  if (existing) {
    db.update(settings).set({ value, updatedAt: new Date().toISOString() }).where(eq(settings.key, DELETED_MODELS_SETTING)).run();
  } else {
    db.insert(settings).values({ key: DELETED_MODELS_SETTING, value, label: '管理员已删除模型' }).run();
  }
}

function categoryFromCapabilities(capabilities: unknown): string {
  const values = Array.isArray(capabilities) ? capabilities.map(String) : [];
  if (values.includes('video')) return 'video';
  if (values.includes('image') || values.includes('image_gen')) return 'image';
  if (values.includes('tts')) return 'tts';
  if (values.includes('text')) return 'text';
  return 'other';
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
      let contentDurationSamples = 0;

      for (const row of contentRows) {
        if (row.status === 'completed' && row.resultUrl && row.resultUrl.trim() !== '') {
          contentSuccessCount++;
          let dur = 0;
          try {
            const meta = row.metadata ? JSON.parse(row.metadata) : {};
            if (meta.durationMs && typeof meta.durationMs === 'number' && meta.durationMs > 0) {
              dur = meta.durationMs;
            } else if (meta.completedAt || meta.finishedAt) {
              const compTime = new Date(meta.completedAt || meta.finishedAt).getTime();
              const createdTime = new Date(row.createdAt).getTime();
              if (!isNaN(compTime) && !isNaN(createdTime) && compTime >= createdTime) {
                dur = compTime - createdTime;
              }
            }
          } catch {}

          if (dur > 0) {
            contentTotalDurationMs += dur;
            contentDurationSamples++;
          }
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
      const totalDurationSamples = contentDurationSamples + apiSuccessCount + usageSuccessCount;

      // 平均耗时（按分钟计算，仅统计获取到有效耗时记录的样本）
      let avgDurationMinutes = 0;
      if (totalDurationSamples > 0 && totalDurationMs > 0) {
        avgDurationMinutes = Number((totalDurationMs / totalDurationSamples / 1000 / 60).toFixed(1));
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
    const { provider, displayName, description, apiKey, capabilities } = data;
    const modelId = String(data.modelId || '').trim();
    if (!modelId || !displayName) throw { status: 400, message: '模型ID和名称不能为空' };
    if (db.select().from(models).where(eq(models.modelId, modelId)).get()) {
      throw { status: 409, message: `模型 ${modelId} 已存在` };
    }

    db.insert(models).values({
      provider: provider || 'google',
      modelId,
      displayName,
      description: description || null,
      apiKey: apiKey || null,
      capabilities: JSON.stringify(capabilities || ['text']),
      isActive: data.isActive === 0 ? 0 : 1,
    }).run();

    if (provider === 'hmstudio') linkHmStudioModel(modelId, apiKey);

    const deletedIds = getDeletedModelIds();
    if (deletedIds.delete(modelId)) saveDeletedModelIds(deletedIds);
  }

  static updateModel(modelId: number, data: any) {
    const model = db.select().from(models).where(eq(models.id, modelId)).get();
    if (!model) throw { status: 404, message: '模型不存在' };

    const updates: Record<string, any> = {};
    const nextModelId = data.modelId !== undefined ? String(data.modelId).trim() : model.modelId;
    if (!nextModelId) throw { status: 400, message: '模型 ID 不能为空' };
    if (nextModelId !== model.modelId) {
      const duplicateModel = db.select().from(models).where(eq(models.modelId, nextModelId)).get();
      if (duplicateModel) throw { status: 409, message: `模型 ${nextModelId} 已存在` };
      const oldPricing = db.select().from(modelPricing).where(eq(modelPricing.modelPattern, model.modelId)).get();
      const targetPricing = db.select().from(modelPricing).where(eq(modelPricing.modelPattern, nextModelId)).get();
      if (oldPricing && targetPricing) throw { status: 409, message: `新模型 ID ${nextModelId} 已存在计费规则` };
      updates.modelId = nextModelId;
    }
    if (data.displayName !== undefined) updates.displayName = data.displayName;
    if (data.description !== undefined) updates.description = data.description || null;
    if (data.provider !== undefined) updates.provider = data.provider;
    if (data.apiKey !== undefined) updates.apiKey = data.apiKey || null;
    if (data.capabilities !== undefined) updates.capabilities = JSON.stringify(data.capabilities);
    if (data.isActive !== undefined) updates.isActive = data.isActive;

    if (Object.keys(updates).length > 0) {
      db.transaction(tx => {
        if (nextModelId !== model.modelId) {
          tx.update(modelPricing).set({ modelPattern: nextModelId }).where(eq(modelPricing.modelPattern, model.modelId)).run();
        }
        if (data.capabilities !== undefined) {
          const pricing = tx.select().from(modelPricing).where(eq(modelPricing.modelPattern, nextModelId)).get();
          if (pricing) {
            let extraParams: Record<string, any> = {};
            try { extraParams = JSON.parse(pricing.extraParams || '{}'); } catch { }
            tx.update(modelPricing)
              .set({ extraParams: JSON.stringify({ ...extraParams, category: categoryFromCapabilities(data.capabilities) }) })
              .where(eq(modelPricing.modelPattern, nextModelId))
              .run();
          }
        }
        tx.update(models).set(updates).where(eq(models.id, modelId)).run();
      });
    }

    if (nextModelId !== model.modelId) {
      const deletedIds = getDeletedModelIds();
      deletedIds.add(model.modelId);
      deletedIds.delete(nextModelId);
      saveDeletedModelIds(deletedIds);
    }

    const nextProvider = data.provider !== undefined ? data.provider : model.provider;
    if (nextProvider === 'hmstudio') {
      linkHmStudioModel(nextModelId, data.apiKey !== undefined ? data.apiKey : model.apiKey);
    }
  }

  static deleteModel(modelId: number) {
    const model = db.select().from(models).where(eq(models.id, modelId)).get();
    if (!model) throw { status: 404, message: '模型不存在' };

    db.transaction(tx => {
      tx.delete(modelPricing).where(eq(modelPricing.modelPattern, model.modelId)).run();
      tx.delete(tierModelAccess).where(eq(tierModelAccess.modelId, modelId)).run();
      tx.delete(models).where(eq(models.id, modelId)).run();
    });

    const deletedIds = getDeletedModelIds();
    deletedIds.add(model.modelId);
    saveDeletedModelIds(deletedIds);
  }

  // ============ 系统设置 ============
  static getSettings() {
    // Prices are managed exclusively through model_pricing (/admin/pricing).
    return db.select().from(settings).all().filter(item => !item.key.includes('_rate') && item.key !== 'image_rate' && item.key !== DELETED_MODELS_SETTING);
  }

  static updateSettings(items: { key: string; value: string }[]) {
    for (const item of items) {
      if (item.key.includes('_rate') || item.key === 'image_rate' || item.key === DELETED_MODELS_SETTING) {
        throw { status: 400, message: '模型价格请在「计费设置」中修改' };
      }
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
