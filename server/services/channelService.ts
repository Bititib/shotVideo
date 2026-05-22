import { db } from '../db/index.js';
import { channels } from '../db/schema.js';
import { eq, sql, desc } from 'drizzle-orm';

export class ChannelService {
  /** 获取所有渠道 */
  static getChannels() {
    return db.select().from(channels).orderBy(channels.priority, desc(channels.createdAt)).all()
      .map(ch => ({
        ...ch,
        modelMapping: JSON.parse(ch.modelMapping),
        supportedModels: JSON.parse(ch.supportedModels),
        apiKey: ch.apiKey ? '****' + ch.apiKey.slice(-4) : '',
      }));
  }

  /** 获取渠道原始数据（内部用，不脱敏） */
  static getChannelRaw(id: number) {
    return db.select().from(channels).where(eq(channels.id, id)).get();
  }

  /** 获取所有启用的渠道（内部用，不脱敏） */
  static getActiveChannels() {
    return db.select().from(channels)
      .where(eq(channels.status, 1))
      .orderBy(channels.priority)
      .all()
      .map(ch => ({
        ...ch,
        modelMapping: JSON.parse(ch.modelMapping) as Record<string, string>,
        supportedModels: JSON.parse(ch.supportedModels) as string[],
      }));
  }

  /** 根据模型名查找可用渠道（按优先级+权重选择） */
  static findChannelForModel(modelName: string) {
    const activeChannels = this.getActiveChannels();
    // 筛选支持该模型的渠道
    const candidates = activeChannels.filter(ch =>
      ch.supportedModels.includes(modelName) || ch.supportedModels.includes('*')
    );
    if (candidates.length === 0) return null;

    // 按优先级分组，取最高优先级
    const topPriority = candidates[0].priority;
    const topCandidates = candidates.filter(ch => ch.priority === topPriority);

    // 按权重随机选择
    const totalWeight = topCandidates.reduce((sum, ch) => sum + ch.weight, 0);
    let random = Math.random() * totalWeight;
    for (const ch of topCandidates) {
      random -= ch.weight;
      if (random <= 0) return ch;
    }
    return topCandidates[0];
  }

  /** 根据渠道类型查找首个可用渠道（按优先级排序） */
  static findChannelByType(type: string) {
    const activeChannels = this.getActiveChannels();
    return activeChannels.find(ch => ch.type === type) || null;
  }

  /** 新增渠道 */
  static createChannel(data: any) {
    const { name, type, baseUrl, apiKey, modelMapping, supportedModels, priority, weight, maxRetries, timeout } = data;
    if (!name || !baseUrl) throw { status: 400, message: '渠道名称和 Base URL 不能为空' };

    const result = db.insert(channels).values({
      name,
      type: type || 'openai',
      baseUrl,
      apiKey: apiKey || '',
      modelMapping: JSON.stringify(modelMapping || {}),
      supportedModels: JSON.stringify(supportedModels || []),
      priority: priority ?? 0,
      weight: weight ?? 1,
      maxRetries: maxRetries ?? 3,
      timeout: timeout ?? 120000,
    }).run();

    return Number(result.lastInsertRowid);
  }

  /** 编辑渠道 */
  static updateChannel(id: number, data: any) {
    const ch = db.select().from(channels).where(eq(channels.id, id)).get();
    if (!ch) throw { status: 404, message: '渠道不存在' };

    const updates: Record<string, any> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.type !== undefined) updates.type = data.type;
    if (data.baseUrl !== undefined) updates.baseUrl = data.baseUrl;
    if (data.apiKey !== undefined) updates.apiKey = data.apiKey;
    if (data.modelMapping !== undefined) updates.modelMapping = JSON.stringify(data.modelMapping);
    if (data.supportedModels !== undefined) updates.supportedModels = JSON.stringify(data.supportedModels);
    if (data.priority !== undefined) updates.priority = data.priority;
    if (data.weight !== undefined) updates.weight = data.weight;
    if (data.maxRetries !== undefined) updates.maxRetries = data.maxRetries;
    if (data.timeout !== undefined) updates.timeout = data.timeout;
    if (data.status !== undefined) updates.status = data.status;
    updates.updatedAt = new Date().toISOString();

    if (Object.keys(updates).length > 0) {
      db.update(channels).set(updates).where(eq(channels.id, id)).run();
    }
  }

  /** 删除渠道 */
  static deleteChannel(id: number) {
    db.delete(channels).where(eq(channels.id, id)).run();
  }

  /** 测试渠道连通性 */
  static async testChannel(id: number): Promise<{ success: boolean; message: string; durationMs: number }> {
    const ch = db.select().from(channels).where(eq(channels.id, id)).get();
    if (!ch) throw { status: 404, message: '渠道不存在' };

    const start = Date.now();
    try {
      const url = ch.baseUrl.replace(/\/+$/, '') + '/v1/models';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ch.timeout || 15000);

      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${ch.apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timer);

      const durationMs = Date.now() - start;
      const result = res.ok
        ? { success: true, message: `success:${durationMs}ms`, durationMs }
        : { success: false, message: `fail:HTTP ${res.status}`, durationMs };

      // 更新测试结果
      db.update(channels).set({
        lastTestAt: new Date().toISOString(),
        lastTestResult: result.message,
      }).where(eq(channels.id, id)).run();

      return result;
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const message = err.name === 'AbortError' ? 'fail:timeout' : `fail:${err.message}`;

      db.update(channels).set({
        lastTestAt: new Date().toISOString(),
        lastTestResult: message,
      }).where(eq(channels.id, id)).run();

      return { success: false, message, durationMs };
    }
  }
}
