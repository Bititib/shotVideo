import { db } from '../db/index.js';
import { channelApiKeys, channels, models } from '../db/schema.js';
import { and, desc, eq } from 'drizzle-orm';
import { hmStudioPoolConfig, hmStudioPoolKey, hmStudioQueue } from './hmStudioQueueService.js';
import {
  isWxHaidiYueChannel,
  WX_HAIDIYUE_CHANNEL_NAME,
  WX_HAIDIYUE_CHANNEL_TYPE,
  WX_HAIDIYUE_FACE_SPLIT_MODEL,
  WX_HAIDIYUE_UPSTREAM_MODEL,
} from './wxHaidiYueAdapter.js';

const DEFAULT_HM_CONCURRENCY = (() => {
  const parsed = Number.parseInt(process.env.HM_STUDIO_CONCURRENCY || '10', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 10;
})();

function parseConcurrencyLimit(value: unknown, fallback = DEFAULT_HM_CONCURRENCY): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw { status: 400, message: 'HM Studio 并发数必须是 1 到 1000 之间的整数' };
  }
  return parsed;
}

function parseJsonObject(value: string): Record<string, string> {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function maskApiKey(apiKey: string): string {
  return apiKey ? `****${apiKey.slice(-4)}` : '';
}

function hmPoolScore(channel: any): [number, number, number] {
  const pool = hmStudioQueue.getPoolLoad(hmStudioPoolKey(channel));
  const limit = Math.max(1, pool.limit);
  return [pool.running < limit ? 0 : 1, pool.load / limit, pool.queued];
}

function allHmKeys() {
  return db.select().from(channelApiKeys).all();
}

function syncHmStudioPools(
  channelRows: Array<{ id: number; type: string; status: number }> = db.select().from(channels).all(),
  hmKeys = allHmKeys(),
): void {
  const activeChannelIds = new Set(
    channelRows
      .filter(channel => channel.type === 'hmstudio' && channel.status === 1)
      .map(channel => channel.id),
  );
  hmStudioQueue.syncPools(
    hmKeys
      .filter(key => key.status === 1 && activeChannelIds.has(key.channelId))
      .map(hmStudioPoolConfig),
  );
}

function findDuplicateHmKey(apiKey: string, excludedId?: number) {
  return allHmKeys().find(key => key.apiKey === apiKey && key.id !== excludedId);
}

function saveHmStudioKeys(channelId: number, entries: any[], replaceExisting: boolean): void {
  const existing = db.select().from(channelApiKeys).where(eq(channelApiKeys.channelId, channelId)).all();
  const retainedIds = new Set<number>();

  const requestedIds = new Set(
    entries.map(entry => Number(entry?.id)).filter(id => Number.isInteger(id) && id > 0),
  );
  const requestedNewKeys = entries
    .filter(entry => !Number.isInteger(Number(entry?.id)) || Number(entry?.id) <= 0)
    .map(entry => String(entry?.apiKey || '').trim())
    .filter(Boolean);
  if (new Set(requestedNewKeys).size !== requestedNewKeys.length) {
    throw { status: 409, message: '本次提交中包含重复的 HM Studio API Key' };
  }
  for (const apiKey of requestedNewKeys) {
    const duplicate = findDuplicateHmKey(apiKey);
    if (duplicate) {
      const duplicateChannel = db.select().from(channels).where(eq(channels.id, duplicate.channelId)).get();
      throw {
        status: 409,
        message: `该 HM Studio API Key 已存在于渠道「${duplicateChannel?.name || duplicate.channelId}」，重复添加不会增加并发`,
      };
    }
  }
  for (const id of requestedIds) {
    if (!existing.some(key => key.id === id)) {
      throw { status: 400, message: 'API Key 不属于当前渠道' };
    }
  }
  if (replaceExisting) {
    for (const key of existing.filter(item => !requestedIds.has(item.id))) {
      const load = hmStudioQueue.getPoolLoad(hmStudioPoolKey(key));
      if (load.load > 0) {
        throw { status: 409, message: `${maskApiKey(key.apiKey)} 仍有 ${load.load} 个运行或排队任务，暂时不能删除` };
      }
    }
  }

  for (const entry of entries) {
    const id = Number(entry?.id);
    const concurrencyLimit = parseConcurrencyLimit(entry?.concurrencyLimit);
    const status = entry?.status === 0 ? 0 : 1;

    if (Number.isInteger(id) && id > 0) {
      const current = existing.find(key => key.id === id);
      if (!current) continue;
      db.update(channelApiKeys).set({
        concurrencyLimit,
        status,
        updatedAt: new Date().toISOString(),
      }).where(eq(channelApiKeys.id, id)).run();
      retainedIds.add(id);
      continue;
    }

    const apiKey = String(entry?.apiKey || '').trim();
    if (!apiKey) continue;
    const result = db.insert(channelApiKeys).values({
      channelId,
      apiKey,
      concurrencyLimit,
      status,
    }).run();
    retainedIds.add(Number(result.lastInsertRowid));
  }

  if (replaceExisting) {
    for (const key of existing) {
      if (!retainedIds.has(key.id)) {
        db.delete(channelApiKeys).where(eq(channelApiKeys.id, key.id)).run();
      }
    }
  }
}

export class ChannelService {
  /** 仅返回会频繁变化的运行态，供管理页轻量轮询。 */
  static getRuntimeStatus() {
    const channelRows = db.select({
      id: channels.id,
      type: channels.type,
      status: channels.status,
    }).from(channels).all();
    const hmKeys = allHmKeys();
    syncHmStudioPools(channelRows, hmKeys);

    return channelRows.map(channel => {
      const activeKeys = channel.type === 'hmstudio' && channel.status === 1
        ? hmKeys.filter(key => key.channelId === channel.id && key.status === 1)
        : [];
      const loads = activeKeys.map(key => hmStudioQueue.getPoolLoad(hmStudioPoolKey(key)));
      return {
        id: channel.id,
        concurrencyLimit: activeKeys.reduce((sum, key) => sum + key.concurrencyLimit, 0),
        concurrencyRunning: loads.reduce((sum, load) => sum + load.running, 0),
        concurrencyQueued: loads.reduce((sum, load) => sum + load.queued, 0),
        concurrencyLoad: loads.reduce((sum, load) => sum + load.load, 0),
      };
    });
  }

  /** 获取所有渠道；HM Studio 的 Key 作为渠道下的子项返回。 */
  static getChannels() {
    const rows = db.select().from(channels).orderBy(channels.priority, desc(channels.createdAt)).all();
    const hmKeys = allHmKeys();
    syncHmStudioPools(rows);

    return rows.map(channel => {
      const keys = channel.type === 'hmstudio'
        ? hmKeys.filter(key => key.channelId === channel.id)
        : [];
      const apiKeys = keys.map(key => {
        const poolId = hmStudioPoolKey(key);
        const pool = hmStudioQueue.getPoolLoad(poolId);
        return {
          id: key.id,
          maskedKey: maskApiKey(key.apiKey),
          concurrencyLimit: key.concurrencyLimit,
          status: key.status,
          concurrencyPoolId: poolId,
          concurrencyRunning: pool.running,
          concurrencyQueued: pool.queued,
          concurrencyLoad: pool.load,
        };
      });
      const activeKeys = apiKeys.filter(key => key.status === 1 && channel.status === 1);

      return {
        ...channel,
        modelMapping: parseJsonObject(channel.modelMapping),
        supportedModels: parseJsonArray(channel.supportedModels),
        apiKey: channel.type === 'hmstudio'
          ? (apiKeys.length > 0 ? `${apiKeys.length} 个 Key` : '')
          : maskApiKey(channel.apiKey),
        apiKeys,
        apiKeyCount: apiKeys.length,
        configuredConcurrencyLimit: activeKeys.reduce((sum, key) => sum + key.concurrencyLimit, 0),
        concurrencyLimit: activeKeys.reduce((sum, key) => sum + key.concurrencyLimit, 0),
        concurrencyRunning: activeKeys.reduce((sum, key) => sum + key.concurrencyRunning, 0),
        concurrencyQueued: activeKeys.reduce((sum, key) => sum + key.concurrencyQueued, 0),
        concurrencyLoad: activeKeys.reduce((sum, key) => sum + key.concurrencyLoad, 0),
      };
    });
  }

  /** 获取渠道执行配置；HM Studio 可锁定到任务创建时选中的 Key。 */
  static getChannelRaw(id: number, apiKeyId?: number | null) {
    const channel = db.select().from(channels).where(eq(channels.id, id)).get();
    if (!channel) return channel;
    if (channel.type !== 'hmstudio') return { ...channel, apiKeyId: null };

    const keys = db.select().from(channelApiKeys)
      .where(eq(channelApiKeys.channelId, channel.id))
      .all();
    syncHmStudioPools();
    const selected = apiKeyId
      ? keys.find(key => key.id === apiKeyId)
      : keys.filter(key => key.status === 1).sort((a, b) => {
          const scoreA = hmPoolScore(a);
          const scoreB = hmPoolScore(b);
          return scoreA[0] - scoreB[0]
            || scoreA[1] - scoreB[1]
            || scoreA[2] - scoreB[2]
            || a.id - b.id;
        })[0];

    return {
      ...channel,
      apiKey: selected?.apiKey || '',
      apiKeyId: selected?.id || null,
      concurrencyLimit: selected?.concurrencyLimit || 0,
    };
  }

  /** 获取所有启用渠道。HM Studio 渠道会按启用 Key 展开为多个执行候选。 */
  static getActiveChannels() {
    const channelRows = db.select().from(channels)
      .where(eq(channels.status, 1))
      .orderBy(channels.priority)
      .all();
    const hmKeys = allHmKeys().filter(key => key.status === 1);
    syncHmStudioPools(channelRows);

    return channelRows.flatMap(channel => {
      const base = {
        ...channel,
        apiKeyId: null as number | null,
        modelMapping: parseJsonObject(channel.modelMapping),
        supportedModels: parseJsonArray(channel.supportedModels),
      };
      if (channel.type !== 'hmstudio') return [base];
      return hmKeys
        .filter(key => key.channelId === channel.id)
        .map(key => ({
          ...base,
          apiKey: key.apiKey,
          apiKeyId: key.id,
          concurrencyLimit: key.concurrencyLimit,
        }));
    });
  }

  /** 根据模型名查找可用渠道（按优先级、Key 池负载和权重选择）。 */
  static findChannelForModel(modelName: string, activeChannels?: any[]) {
    const candidates = this.findChannelsForModel(modelName, activeChannels);
    if (candidates.length === 0) return null;

    const topPriority = candidates[0].priority;
    const topCandidates = candidates.filter(channel => channel.priority === topPriority);

    if (topCandidates.every(channel => channel.type === 'hmstudio')) {
      const loads = topCandidates.map(channel => ({
        channel,
        score: hmPoolScore(channel),
      }));
      loads.sort((a, b) => a.score[0] - b.score[0]
        || a.score[1] - b.score[1]
        || a.score[2] - b.score[2]);
      const bestScore = loads[0].score;
      const leastLoaded = loads
        .filter(item => item.score[0] === bestScore[0] && item.score[1] === bestScore[1] && item.score[2] === bestScore[2])
        .map(item => item.channel);
      const totalWeight = leastLoaded.reduce((sum, channel) => sum + channel.weight, 0);
      let random = Math.random() * totalWeight;
      for (const channel of leastLoaded) {
        random -= channel.weight;
        if (random <= 0) return channel;
      }
      return leastLoaded[0];
    }

    const totalWeight = topCandidates.reduce((sum, channel) => sum + channel.weight, 0);
    let random = Math.random() * totalWeight;
    for (const channel of topCandidates) {
      random -= channel.weight;
      if (random <= 0) return channel;
    }
    return topCandidates[0];
  }

  static findChannelsForModel(modelName: string, activeChannels?: any[]) {
    return (activeChannels || this.getActiveChannels())
      .filter(channel => channel.supportedModels.includes(modelName) || channel.supportedModels.includes('*'))
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        if (a.type === 'hmstudio' && b.type === 'hmstudio') {
          const scoreA = hmPoolScore(a);
          const scoreB = hmPoolScore(b);
          return scoreA[0] - scoreB[0] || scoreA[1] - scoreB[1] || scoreA[2] - scoreB[2];
        }
        return a.id - b.id;
      });
  }

  static findChannelsByType(type: string, activeChannels?: any[]) {
    return (activeChannels || this.getActiveChannels()).filter(channel => channel.type === type);
  }

  static findChannelByType(type: string) {
    return this.findChannelsByType(type)[0] || null;
  }

  /** Submission-stage capacity failures are disabled until an admin starts the route again. */
  static disableExecutionTarget(target: any, reason: string) {
    const detail = String(reason || '上游提交失败').replace(/\s+/g, ' ').slice(0, 240);
    const now = new Date().toISOString();
    if (target?.type === 'hmstudio' && Number(target.apiKeyId) > 0) {
      db.update(channelApiKeys).set({ status: 0, updatedAt: now })
        .where(and(eq(channelApiKeys.id, Number(target.apiKeyId)), eq(channelApiKeys.channelId, Number(target.id))))
        .run();
      db.update(channels).set({
        lastTestAt: now,
        lastTestResult: `auto_disabled:${maskApiKey(String(target.apiKey || ''))}:${detail}`,
        updatedAt: now,
      }).where(eq(channels.id, Number(target.id))).run();
    } else if (Number(target?.id) > 0) {
      db.update(channels).set({
        status: 0,
        lastTestAt: now,
        lastTestResult: `auto_disabled:${detail}`,
        updatedAt: now,
      }).where(eq(channels.id, Number(target.id))).run();
    }
    syncHmStudioPools();
  }

  static setHmStudioKeyStatus(channelId: number, keyId: number, status: number) {
    const channel = db.select().from(channels).where(eq(channels.id, channelId)).get();
    if (!channel || channel.type !== 'hmstudio') throw { status: 404, message: 'HM Studio 渠道不存在' };
    const key = db.select().from(channelApiKeys)
      .where(and(eq(channelApiKeys.id, keyId), eq(channelApiKeys.channelId, channelId)))
      .get();
    if (!key) throw { status: 404, message: 'API Key 不存在' };
    db.update(channelApiKeys).set({
      status: status === 1 ? 1 : 0,
      updatedAt: new Date().toISOString(),
    }).where(eq(channelApiKeys.id, keyId)).run();
    syncHmStudioPools();
  }

  static createChannel(data: any) {
    const { name, type, baseUrl, apiKey, modelMapping, supportedModels, priority, weight, maxRetries, timeout } = data;
    if (!name || !baseUrl) throw { status: 400, message: '渠道名称和 Base URL 不能为空' };

    const isWxHaidiYue = type === WX_HAIDIYUE_CHANNEL_TYPE;
    const result = db.insert(channels).values({
      name: isWxHaidiYue ? WX_HAIDIYUE_CHANNEL_NAME : name,
      type: type || 'openai',
      baseUrl,
      apiKey: type === 'hmstudio' ? '' : (apiKey || ''),
      modelMapping: JSON.stringify(isWxHaidiYue
        ? { [WX_HAIDIYUE_FACE_SPLIT_MODEL]: WX_HAIDIYUE_UPSTREAM_MODEL }
        : (modelMapping || {})),
      supportedModels: JSON.stringify(isWxHaidiYue ? [WX_HAIDIYUE_FACE_SPLIT_MODEL] : (supportedModels || [])),
      priority: priority ?? 0,
      weight: weight ?? 1,
      concurrencyLimit: DEFAULT_HM_CONCURRENCY,
      maxRetries: maxRetries ?? 3,
      timeout: timeout ?? 120000,
      faceSplitEnabled: isWxHaidiYue
        ? (data.faceSplitEnabled === 0 || data.faceSplitEnabled === false ? 0 : 1)
        : 0,
    }).run();
    const channelId = Number(result.lastInsertRowid);

    if (type === 'hmstudio') {
      const entries = Array.isArray(data.apiKeys) ? data.apiKeys : (apiKey ? [{ apiKey, concurrencyLimit: data.concurrencyLimit }] : []);
      try {
        saveHmStudioKeys(channelId, entries, false);
      } catch (error) {
        db.delete(channels).where(eq(channels.id, channelId)).run();
        throw error;
      }
    }

    syncHmStudioPools();
    return channelId;
  }

  static updateChannel(id: number, data: any) {
    const channel = db.select().from(channels).where(eq(channels.id, id)).get();
    if (!channel) throw { status: 404, message: '渠道不存在' };
    const nextType = data.type ?? channel.type;

    const updates: Record<string, any> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.type !== undefined) updates.type = data.type;
    if (data.baseUrl !== undefined) updates.baseUrl = data.baseUrl;
    if (data.apiKey !== undefined && nextType !== 'hmstudio') updates.apiKey = data.apiKey;
    if (nextType === 'hmstudio') updates.apiKey = '';
    if (data.modelMapping !== undefined) updates.modelMapping = JSON.stringify(data.modelMapping);
    if (data.supportedModels !== undefined) updates.supportedModels = JSON.stringify(data.supportedModels);
    if (data.priority !== undefined) updates.priority = data.priority;
    if (data.weight !== undefined) updates.weight = data.weight;
    if (data.maxRetries !== undefined) updates.maxRetries = data.maxRetries;
    if (data.timeout !== undefined) updates.timeout = data.timeout;
    if (data.status !== undefined) updates.status = data.status;
    if (nextType === WX_HAIDIYUE_CHANNEL_TYPE) {
      updates.name = WX_HAIDIYUE_CHANNEL_NAME;
      updates.supportedModels = JSON.stringify([WX_HAIDIYUE_FACE_SPLIT_MODEL]);
      updates.modelMapping = JSON.stringify({ [WX_HAIDIYUE_FACE_SPLIT_MODEL]: WX_HAIDIYUE_UPSTREAM_MODEL });
      updates.faceSplitEnabled = data.faceSplitEnabled !== undefined
        ? (data.faceSplitEnabled === 0 || data.faceSplitEnabled === false ? 0 : 1)
        : (channel.type === WX_HAIDIYUE_CHANNEL_TYPE ? channel.faceSplitEnabled : 1);
    } else if (channel.type === WX_HAIDIYUE_CHANNEL_TYPE) {
      updates.faceSplitEnabled = 0;
    }
    updates.updatedAt = new Date().toISOString();

    if (nextType === 'hmstudio') {
      if (Array.isArray(data.apiKeys)) {
        saveHmStudioKeys(id, data.apiKeys, true);
      } else if (data.apiKey) {
        saveHmStudioKeys(id, [{ apiKey: data.apiKey, concurrencyLimit: data.concurrencyLimit }], false);
      }
    }
    db.update(channels).set(updates).where(eq(channels.id, id)).run();
    syncHmStudioPools();
  }

  static deleteChannel(id: number) {
    db.delete(channelApiKeys).where(eq(channelApiKeys.channelId, id)).run();
    db.delete(channels).where(eq(channels.id, id)).run();
    syncHmStudioPools();
  }

  static async testChannel(id: number): Promise<{ success: boolean; message: string; durationMs: number }> {
    const channel = this.getChannelRaw(id);
    if (!channel) throw { status: 404, message: '渠道不存在' };
    if (!channel.apiKey) throw { status: 400, message: '请先为渠道添加 API Key' };

    const start = Date.now();
    try {
      const baseUrl = channel.baseUrl.replace(/\/+$/, '');
      const url = isWxHaidiYueChannel(channel) && /\/v1$/i.test(baseUrl)
        ? `${baseUrl}/models`
        : `${baseUrl}/v1/models`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), channel.timeout || 15000);
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${channel.apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timer);

      const durationMs = Date.now() - start;
      const result = response.ok
        ? { success: true, message: `success:${durationMs}ms`, durationMs }
        : { success: false, message: `fail:HTTP ${response.status}`, durationMs };
      db.update(channels).set({
        lastTestAt: new Date().toISOString(),
        lastTestResult: result.message,
      }).where(eq(channels.id, id)).run();
      return result;
    } catch (error: any) {
      const durationMs = Date.now() - start;
      const message = error.name === 'AbortError' ? 'fail:timeout' : `fail:${error.message}`;
      db.update(channels).set({
        lastTestAt: new Date().toISOString(),
        lastTestResult: message,
      }).where(eq(channels.id, id)).run();
      return { success: false, message, durationMs };
    }
  }

  static async syncModels(id: number): Promise<{ count: number; added: number; models: string[] }> {
    const channel = this.getChannelRaw(id);
    if (!channel) throw { status: 404, message: '渠道不存在' };
    if (!channel.apiKey) throw { status: 400, message: '请先为渠道添加 API Key' };

    // 该渠道只暴露本站独立的海底月模型，不允许“同步模型”加入其他上游模型。
    if (isWxHaidiYueChannel(channel)) {
      db.update(channels).set({
        supportedModels: JSON.stringify([WX_HAIDIYUE_FACE_SPLIT_MODEL]),
        modelMapping: JSON.stringify({ [WX_HAIDIYUE_FACE_SPLIT_MODEL]: WX_HAIDIYUE_UPSTREAM_MODEL }),
        updatedAt: new Date().toISOString(),
      }).where(eq(channels.id, id)).run();
      return { count: 1, added: 0, models: [WX_HAIDIYUE_FACE_SPLIT_MODEL] };
    }

    const url = channel.baseUrl.replace(/\/+$/, '') + '/v1/models';
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${channel.apiKey}` },
      signal: AbortSignal.timeout(channel.timeout || 30_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw { status: response.status, message: `拉取模型失败: HTTP ${response.status} ${detail.slice(0, 300)}` };
    }

    const payload = await response.json() as any;
    const rawModels = Array.isArray(payload) ? payload
      : Array.isArray(payload.data) ? payload.data
      : Array.isArray(payload.models) ? payload.models
      : [];
    const normalized = rawModels.map((item: any) => {
      const modelId = String(typeof item === 'string' ? item : item.id || item.model || item.model_id || '').trim();
      const displayName = String(typeof item === 'string' ? item : item.display_name || item.name || modelId).trim();
      const explicitType = String(typeof item === 'object' ? item.type || item.category || '' : '').toLowerCase();
      const capability = explicitType.includes('lip') || /lip-sync/i.test(modelId)
        ? 'lip_sync'
        : explicitType.includes('video') || /video|seedance/i.test(modelId)
          ? 'video'
          : explicitType.includes('image') || /image|jimeng|banana/i.test(modelId)
            ? 'image'
            : 'text';
      return { modelId, displayName: displayName || modelId, capability };
    }).filter((item: any) => item.modelId);

    const unique = [...new Map(normalized.map((item: any) => [item.modelId, item])).values()] as Array<{
      modelId: string; displayName: string; capability: string;
    }>;
    let added = 0;
    for (const item of unique) {
      const existing = db.select().from(models).where(eq(models.modelId, item.modelId)).get();
      if (!existing) {
        db.insert(models).values({
          provider: channel.type,
          modelId: item.modelId,
          displayName: item.displayName,
          description: `由 ${channel.name} 同步`,
          capabilities: JSON.stringify([item.capability]),
          isActive: 1,
        }).run();
        added++;
      }
    }

    const modelIds = unique.map(item => item.modelId);
    const mapping = Object.fromEntries(modelIds.map(modelId => [modelId, modelId]));
    db.update(channels).set({
      supportedModels: JSON.stringify(modelIds),
      modelMapping: JSON.stringify(mapping),
      updatedAt: new Date().toISOString(),
    }).where(eq(channels.id, id)).run();
    return { count: modelIds.length, added, models: modelIds };
  }
}
