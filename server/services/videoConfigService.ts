/**
 * 视频模型配置工具模块
 * 
 * 从数据库的 models.videoConfig 字段读取视频模型的全部元数据，
 * 消除代码中的硬编码 if-else 链，实现后台可配置新增模型。
 */
import { db } from '../db/index.js';
import { models, settings } from '../db/schema.js';
import { eq, and, like } from 'drizzle-orm';

export interface VideoConfig {
  series: string;
  allowedSeconds: number[] | null;
  requireRef: boolean;
  maxSeconds: number;
  billingType: 'flat' | 'per_second';
  rateSettingKey: string;
  defaultRate: number;
  rate1080pKey?: string | null;
  defaultRate1080p?: number | null;
  description: string;
  icon: string;
  group: string;
}

/** 内存缓存，避免每次请求都查库。服务启动 / 管理员修改时清空 */
let _cache: Record<string, VideoConfig | null> = {};
let _cacheTs = 0;
const CACHE_TTL = 30_000; // 30s

/** 清空缓存（管理员修改模型后调用） */
export function invalidateVideoConfigCache() {
  _cache = {};
  _cacheTs = 0;
}

/** 获取指定模型的视频配置 */
export function getVideoConfig(modelId: string): VideoConfig | null {
  const now = Date.now();
  if (now - _cacheTs > CACHE_TTL) {
    _cache = {};
    _cacheTs = now;
  }
  if (modelId in _cache) return _cache[modelId];

  const row = db.select().from(models)
    .where(eq(models.modelId, modelId))
    .get();

  if (!row?.videoConfig) {
    _cache[modelId] = null;
    return null;
  }
  try {
    const cfg = JSON.parse(row.videoConfig) as VideoConfig;
    _cache[modelId] = cfg;
    return cfg;
  } catch {
    _cache[modelId] = null;
    return null;
  }
}

/** 获取模型在指定分辨率下的费率 */
export function getModelRate(modelId: string, resolution: string): number {
  const cfg = getVideoConfig(modelId);
  if (!cfg) {
    // 无 videoConfig 的模型：使用通用 per-second 基础费率
    const rate480 = db.select().from(settings).where(eq(settings.key, 'video_rate_480p')).get();
    const rate720 = db.select().from(settings).where(eq(settings.key, 'video_rate_720p')).get();
    const BASE_RATE: Record<string, number> = {
      '480p': parseFloat(rate480?.value || '0.03'),
      '720p': parseFloat(rate720?.value || '0.05'),
    };
    return BASE_RATE[resolution] || BASE_RATE['720p'];
  }

  // 尝试 1080p 专属费率
  if (resolution === '1080p' && cfg.rate1080pKey) {
    const row = db.select().from(settings).where(eq(settings.key, cfg.rate1080pKey)).get();
    return parseFloat(row?.value || String(cfg.defaultRate1080p ?? cfg.defaultRate));
  }

  // 默认（720p）费率
  const row = db.select().from(settings).where(eq(settings.key, cfg.rateSettingKey)).get();
  return parseFloat(row?.value || String(cfg.defaultRate));
}

/** 判断模型是否按次计费（flat rate） */
export function isModelFlatRate(modelId: string): boolean {
  const cfg = getVideoConfig(modelId);
  return cfg?.billingType === 'flat';
}

/** 获取模型的 ModelMeta 兼容信息 */
export function getModelMeta(modelId: string): { series: string; allowedSeconds: number[] | null; requireRef: boolean } | null {
  const cfg = getVideoConfig(modelId);
  if (!cfg) return null;
  return {
    series: cfg.series,
    allowedSeconds: cfg.allowedSeconds,
    requireRef: cfg.requireRef,
  };
}
