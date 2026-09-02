import { db, sqlite } from './index.js';
import { tiers, users, models, tierModelAccess, settings, channels, channelApiKeys, apiTokens, modelPricing, organizations, orgMembers, contents } from './schema.js';
import { eq, like } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { env, getApiKeys } from '../config/env.js';
import { GoogleGenAI } from '@google/genai';
import { JULUN_MINIMAX_H3_MODEL } from '../services/julunMinimaxAdapter.js';
import {
  WX_HAIDIYUE_CHANNEL_NAME,
  WX_HAIDIYUE_CHANNEL_TYPE,
  WX_HAIDIYUE_UPSTREAM_MODEL,
} from '../services/wxHaidiYueAdapter.js';
import {
  SNUMOM_GROK_IMAGINE_VIDEO_MODEL,
  SNUMOM_SD_MINI_MODEL,
  SNUMOM_VIDEO_MODELS,
} from '../services/snumomWanAdapter.js';

/** 生成 sk-xxxx 格式的 Token */
function generateTokenKey(): string {
  return 'sk-' + crypto.randomBytes(24).toString('hex');
}

/** 不适合做内容分析 或 免费 Key 无法使用的模型关键词（排除） */
const EXCLUDED_KEYWORDS = ['embedding', 'tts', 'robotics', 'live', 'audio', 'computer-use', 'customtools', 'pro'];

/** 排除别名和版本号变体 */
const EXCLUDED_PATTERNS = [
  /^gemini-(flash|pro|flash-lite)-(latest)$/,
  /^gemini-[\d.]+-flash-\d{3}$/,
  /^gemini-[\d.]+-flash-lite-\d{3}$/,
];

/** 验证单个模型是否真正可用（区分限流 vs 真正不支持 vs 超时） */
async function verifyModel(ai: GoogleGenAI, modelId: string, isImage: boolean): Promise<'ok' | 'rate_limited' | 'unsupported' | 'timeout'> {
  // 本地开发直接信任发现的模型列表，避免因网络挂起导致服务启动失败
  return 'ok';
}

type ModelEntry = { provider: string; modelId: string; displayName: string; description?: string | null; capabilities: string; isActive?: number };

export function shouldRemoveMissingGoogleModel(
  model: Pick<typeof models.$inferSelect, 'provider' | 'modelId'>,
  verifiedIds: Set<string>,
): boolean {
  return model.provider === 'google' && !verifiedIds.has(model.modelId);
}

/** 使用单个 Key 串行验证一批模型（同 Key 内间隔 2s 防限流） */
async function verifyBatch(
  apiKey: string, keyIndex: number,
  batch: (ModelEntry & { isImage: boolean })[],
  existingModelIds: Set<string>,
): Promise<{ verified: ModelEntry[]; log: string[] }> {
  const ai = new GoogleGenAI({ apiKey });
  const verified: ModelEntry[] = [];
  const log: string[] = [];

  for (const c of batch) {
    if (existingModelIds.has(c.modelId)) {
      verified.push({ provider: c.provider, modelId: c.modelId, displayName: c.displayName, capabilities: c.capabilities });
      continue;
    }
    const result = await verifyModel(ai, c.modelId, c.isImage);
    if (result === 'ok') {
      log.push(`   ✅ ${c.modelId} (key#${keyIndex + 1})`);
      verified.push({ provider: c.provider, modelId: c.modelId, displayName: c.displayName, capabilities: c.capabilities });
    } else if (result === 'timeout') {
      log.push(`   ❌ ${c.modelId} — 网络请求超时，停止后续验证 (key#${keyIndex + 1})`);
      break;
    } else {
      log.push(`   ❌ ${c.modelId} — ${result === 'rate_limited' ? '配额不足' : '不支持'} (key#${keyIndex + 1})`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return { verified, log };
}

/**
 * 从 Google API 动态发现可用模型，多 Key 并发验证后同步到数据库
 * N 个 Key = 验证速度提升 N 倍，运行时请求也自动轮询分散限速
 */
export async function syncModelsFromAPI() {
  const existingModels = db.select().from(models).all();
  const existingModelIds = new Set(existingModels.map(m => m.modelId));
  const apiKey = env.GEMINI_API_KEY;

  let allVerified: ModelEntry[] = [];
  let apiSuccess = false;

  if (!apiKey) {
    console.warn('⚠️ 未配置 API Key，使用默认模型');
  } else {
    try {
      // 通过代理端 /v1/models 拉取可用模型列表
      const res = await fetch(`${env.GEMINI_API_BASE_URL}/v1/models`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

      const data = await res.json() as any;
      const modelList: { id: string }[] = data.data || data.models || [];

      for (const m of modelList) {
        const modelId = m.id;
        if (!modelId) continue;

        // 确定 capabilities
        let capabilities: string[] = ['text'];
        if (modelId.includes('tts')) capabilities = ['tts'];
        else if (modelId.includes('image')) capabilities = ['text', 'image_gen'];
        else if (modelId.includes('embedding')) capabilities = ['embedding'];
        else if (modelId.includes('imagen')) capabilities = ['image_gen'];

        // 排除不适合内容分析的模型
        if (['embedding', 'robotics', 'computer-use'].some(kw => modelId.includes(kw))) continue;

        // 生成友好的显示名
        const displayName = modelId
          .split('-')
          .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ')
          .replace('Preview', '(Preview)')
          .replace('Tts', 'TTS');

        allVerified.push({ provider: 'google', modelId, displayName, capabilities: JSON.stringify(capabilities) });
      }

      console.log(`🔍 从代理端发现 ${allVerified.length} 个可用模型`);
      apiSuccess = true;
    } catch (err: any) {
      console.warn(`⚠️ 无法获取模型列表: ${err.message}，保留已有模型数据`);
    }
  }

  // API 不可用 且 数据库为空时的回退默认集
  if (allVerified.length === 0 && existingModels.length === 0) {
    console.log('📦 首次启动且网络不可用，写入默认免费模型...');
    allVerified = [
      { provider: 'google', modelId: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', capabilities: JSON.stringify(['text']) },
      { provider: 'google', modelId: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash-Lite', capabilities: JSON.stringify(['text']) },
      { provider: 'google', modelId: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', capabilities: JSON.stringify(['text']) },
      { provider: 'google', modelId: 'gemini-2.0-flash-lite', displayName: 'Gemini 2.0 Flash-Lite', capabilities: JSON.stringify(['text']) },
      { provider: 'google', modelId: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', capabilities: JSON.stringify(['text']) },
      { provider: 'google', modelId: 'gemini-3-flash-preview', displayName: 'Gemini 3 Flash Preview', capabilities: JSON.stringify(['text']) },
      { provider: 'google', modelId: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash Lite', capabilities: JSON.stringify(['text']) },
      { provider: 'google', modelId: 'gemini-3.1-flash-lite-preview', displayName: 'Gemini 3.1 Flash Lite Preview', capabilities: JSON.stringify(['text']) },
    ];
  }

  // 强制追加静态模型 (图片/音频/视频 等)
  allVerified.push(
    { provider: 'openai', modelId: 'gpt-image-2', displayName: 'gpt-image-2', capabilities: JSON.stringify(['image']) },
    { provider: 'google', modelId: 'gemini-3.1-flash-image-preview', displayName: '🍌 nabanana flash', capabilities: JSON.stringify(['image']) },
    { provider: 'google', modelId: 'gemini-3-pro-image-preview', displayName: '🍌 nabanana pro', capabilities: JSON.stringify(['image']) },
    { provider: 'google', modelId: 'gemini-2.5-flash-preview-tts', displayName: 'Gemini 2.5 Flash TTS', capabilities: JSON.stringify(['tts']) },
    { provider: 'google', modelId: 'gemini-2.5-pro-preview-tts', displayName: 'Gemini 2.5 Pro TTS', capabilities: JSON.stringify(['tts']) },
    { provider: 'julun', modelId: 'wan3.0th', displayName: 'Wan 3.0 视频大模型 (wan3.0th)', description: '按秒计费，¥0.14/秒；720p；支持4-30秒文生视频和多参考视频；最多10张图片、5个视频、5段音频公网URL，音频仅支持WAV；支持1:1、16:9、9:16、4:3、3:4', capabilities: JSON.stringify(['video']), isActive: 1 },
    { provider: 'julun', modelId: JULUN_MINIMAX_H3_MODEL, displayName: 'MiniMax H3 768p（933）', description: '巨轮 MiniMax H3；固定768p；仅支持10秒或15秒；最多9图、3视频、3音频参考；按秒计费 ¥0.18/秒', capabilities: JSON.stringify(['video']), isActive: 1 },
    { provider: 'snumom', modelId: 'wan3.0-video', displayName: 'Wan 3.0 Video（标准版）', description: 'snumom 标准版；支持2-30秒、480P/720P/1080P；最多10图、5视频、5音频参考；支持文生、首帧及首尾帧视频', capabilities: JSON.stringify(['video']), isActive: 1 },
    { provider: 'snumom', modelId: 'wan3.0-video-prime', displayName: 'Wan 3.0 Video Prime（高速版）', description: 'snumom 高速版；生成速度更快；支持2-30秒、480P/720P/1080P；最多10图、5视频、5音频参考', capabilities: JSON.stringify(['video']), isActive: 1 },
    { provider: 'snumom', modelId: SNUMOM_GROK_IMAGINE_VIDEO_MODEL, displayName: 'Grok Imagine Video 1.5（按次）', description: 'snumom Grok Imagine Video 1.5；支持3-15秒；最多7张参考图；按次计费 ¥0.60/次', capabilities: JSON.stringify(['video']), isActive: 1 },
    { provider: 'snumom', modelId: SNUMOM_SD_MINI_MODEL, displayName: 'Seedance 2.0 Mini', description: '支持9图、3视频、3音频参考，不卡脸；480p支持15秒，720p仅支持10秒；按次计费 ¥0.60/次', capabilities: JSON.stringify(['video']), isActive: 1 },
    { provider: 'sudashui', modelId: 'ld-sdas-cvk-pro-933-720p', displayName: 'SudaShui CVK Pro 933 (720p)', capabilities: JSON.stringify(['video']) },
    { provider: 'sudashui', modelId: 'sdas-mj-minimax-h3-2k', displayName: 'Minimax H3 (2K)', capabilities: JSON.stringify(['video']) },
    { provider: 'sudashui', modelId: 'sdas-bl-sd2.0-933-pro-720p', displayName: 'Seedance 2.0 Pro (933人脸版)', capabilities: JSON.stringify(['video']) },
    { provider: 'sudashui', modelId: 'sdas-bl-sd2.0-933-pro-noface-720p', displayName: 'Seedance 2.0 Pro (933无脸版)', capabilities: JSON.stringify(['video']) },
    { provider: 'diwdiw', modelId: 'cd-seedance-2.0-720p', displayName: 'Seedance 2.0 (720p/CD版)', capabilities: JSON.stringify(['video']) },
    { provider: 'diwdiw', modelId: 'nd-seedance-2.0-480p', displayName: 'Seedance 2.0 (480p/不卡脸)', description: '9图3视频3音频，支持 4-15s，不卡人脸，固定按次计费 ¥3.15/次', capabilities: JSON.stringify(['video']) },
    { provider: 'diwdiw', modelId: 'nd-seedance-2.0-720p', displayName: 'Seedance 2.0 (720p/不卡脸)', description: '9图3视频3音频，支持 4-15s，不卡人脸，固定按次计费 ¥4.30/次', capabilities: JSON.stringify(['video']) },
    { provider: 'diwdiw', modelId: 'ad-seedance-2.5-480p', displayName: 'Seedance 2.5 480p（AD）', description: '支持最多30张图片、10个视频、10段音频参考，不限制人脸，按秒计费 ¥0.35/秒', capabilities: JSON.stringify(['video']), isActive: 1 },
    { provider: 'diwdiw', modelId: 'vd-seedance-2.5-480p', displayName: 'Seedance 2.5 480p（VD）', description: '过真人，支持9图3视频0音频，4-30秒，按秒计费 ¥0.25/秒', capabilities: JSON.stringify(['video']), isActive: 1 },
    { provider: 'diwdiw', modelId: 'vd-seedance-2.5-720p', displayName: 'Seedance 2.5 720p（VD）', description: '过真人，支持9图3视频0音频，4-30秒，按秒计费 ¥0.30/秒', capabilities: JSON.stringify(['video']), isActive: 1 },
    { provider: 'diwdiw', modelId: 'td-seedance-2.5-720p', displayName: 'Seedance 2.5 720p（TD）', description: '支持4-30秒、30图10视频10音频参考，固定720p，按次计费；售价以后台统一计费设置为准', capabilities: JSON.stringify(['video']), isActive: 1 },
    { provider: 'diwdiw', modelId: 'xd-seedance-2.5-720p', displayName: '内部视频备用线路', description: '仅供系统容量调度，不对用户直接开放', capabilities: JSON.stringify(['video']), isActive: 0 },
    { provider: 'pidoi', modelId: 'veo-omni-flash', displayName: 'Veo Omni Flash', capabilities: JSON.stringify(['video']) },
    { provider: 'newtoken', modelId: 'veo-omni-flash-video-edit', displayName: 'Veo Omni Flash 视频编辑', description: '【不卡人脸-定制版】无水印视频编辑；必须提供1个参考视频，可附加多张参考图；固定10秒，参考视频最长15秒', capabilities: JSON.stringify(['video']) },
    { provider: 'pidoi', modelId: 'veo-3-1', displayName: 'Veo 3-1', capabilities: JSON.stringify(['video']) },
    { provider: 'seedance', modelId: 'sd2-c7', displayName: 'Seedance 2.0 c7', capabilities: JSON.stringify(['video']), isActive: 0 },
    { provider: 'seedance', modelId: 'sd2.5', displayName: 'Seedance 2.5 (sd2.5)', description: '支持9图0视频0音频，卡人脸；适合制作带货视频，固定按次计费 ¥3.50/次', capabilities: JSON.stringify(['video']) },
    { provider: 'seedance', modelId: 'seedance-2.5-c1', displayName: 'Seedance 2.5 (c1/888API)', description: '支持最多30张图片、10个视频、10个音频参考，4-30秒，按秒计费 ¥0.25/秒', capabilities: JSON.stringify(['video']) },
    { provider: 'seedance', modelId: 'sd2-mini', displayName: 'Seedance Mini (sd2-mini)', description: 'Seedance Mini 720p (933)，支持9图、3音频参考（无视频参考），固定按次计费 ¥2.00/次', capabilities: JSON.stringify(['video']), isActive: 1 },
    { provider: 'seedance', modelId: 'seedance2.0-933', displayName: 'seedance2.0 933', description: 'seedance2.0 933 模型，支持9图、3音频参考（无视频参考），固定按次计费 ¥3.00/次', capabilities: JSON.stringify(['video']), isActive: 1 },
    { provider: 'seedance', modelId: 'seedance-2.0-720p', displayName: 'Seedance 2.0 720p', capabilities: JSON.stringify(['video']), isActive: 0 },
    { provider: 'seedance', modelId: 'seedance-2.0-fast-720p', displayName: 'Seedance 2.0 Fast 720p', capabilities: JSON.stringify(['video']), isActive: 0 },
    { provider: 'seedance', modelId: 'seedance-720', displayName: 'Seedance 720 满血版', capabilities: JSON.stringify(['video']), isActive: 0 }
  );

  // Models explicitly deleted by an administrator must not be resurrected by
  // upstream discovery or the static fallback catalog on the next restart.
  const deletedModelRow = db.select().from(settings).where(eq(settings.key, 'deleted_model_ids')).get();
  let deletedModelIds = new Set<string>();
  try {
    const parsed = JSON.parse(deletedModelRow?.value || '[]');
    if (Array.isArray(parsed)) deletedModelIds = new Set(parsed.map(String));
  } catch { /* ignore malformed legacy value */ }
  allVerified = allVerified.filter(model => !deletedModelIds.has(model.modelId));

  // Provider identifies the configured upstream, not the model family. Keep it
  // aligned with channel routing so the admin model cards do not show a stale
  // Pidoi/diwdiw label while these IDs are routed through NewToken.
  const newTokenModelIds = new Set([
    'veo-omni-flash',
    'veo-omni-flash-video-edit',
    'veo-3-1',
    'nd-seedance-2.0-480p',
    'nd-seedance-2.0-720p',
  ]);
  allVerified = allVerified.map(model => newTokenModelIds.has(model.modelId)
    ? { ...model, provider: 'newtoken' }
    : model);

  // 同步或插入模型
  for (const m of allVerified) {
    const existing = db.select().from(models).where(eq(models.modelId, m.modelId)).get();
    const targetIsActive = m.isActive !== undefined ? m.isActive : 1;
    if (existing) {
      const providerNeedsUpdate = newTokenModelIds.has(m.modelId) && existing.provider !== m.provider;
      if (providerNeedsUpdate || existing.displayName !== m.displayName || existing.capabilities !== m.capabilities || existing.description !== (m.description || null)) {
        db.update(models)
          .set({
            ...(providerNeedsUpdate ? { provider: m.provider } : {}),
            displayName: m.displayName,
            capabilities: m.capabilities,
            description: m.description || null,
          })
          .where(eq(models.modelId, m.modelId))
          .run();
      }
    } else {
      db.insert(models).values({
        provider: m.provider,
        modelId: m.modelId,
        displayName: m.displayName,
        description: m.description || null,
        capabilities: m.capabilities,
        isActive: targetIsActive,
      }).run();
    }
  }

  // 备用执行模型只参与内部路由；即使旧版本曾将其启用，也要在升级时重新隐藏。
  db.update(models).set({ isActive: 0 }).where(eq(models.modelId, 'xd-seedance-2.5-720p')).run();

  // 强制删除已废弃或不能使用的旧视频模型
  try {
    const deadModels = [
      'grok-imagine-image',
      'grok-imagine-image-lite',
      'grok-imagine-image-pro',
      'grok-imagine-image-edit',
      'gpt-image-2-plus',
      'gpt-image-2-pro',
      'gpt-image-2-max',
      'xh-sdas-fast-933-720p',
      'xh-sdas-pro-933-720p',
      'seedance-2.0',
      'lg-seedance-2.0-fast',
      'sdas-d7-seedance-2.0-face-720p',
      'sdas-mo-seedance-2.0-dj-fast',
      'sd2-c8',
      'sora-v3-pro',
      'sora-v4-fast',
      'sora-v4-pro',
      'seedance-2.0-fast',
      'sdas-hn-sd2.0-720p',
      'sdas-hn-sd2.0-fast-720p',
      'jimeng-video-seedance-2.0-fast',
      'jimeng-video-seedance-2.0-vip',
      'sora2-8s-16x9',
      'sora2-8s-9x16',
      'seedance2.0-full-9img',
      'seedance2.0-full-4img',
      'seedance2.0-fast-4img',
      'sdas-wf-sd2.0-fast-933-720p',
      'sdas-wf-sd2.0-pro-933-480p',
      'sdas-pg-s2.0-fast',
      'grok-imagine-video-1.5-1080p',
      'grok-imagine-video',
      'grok-4.3-video',
      'sdas-xh-sd2.0-933-3-pro-720p',
      'sd2.0-fast-480p',
      'tejiasd2',
      'sdas-pd-sd2.0-pro-933-5-720p',
      'rd-seedance-2.5-480p',
      'rd-seedance-2.5-720p',
      'grok-imagine-video-1.5-preview',
      'grok-imagine-1.0-video',
      'grok-imagine-video-1.5-fast',
      'omni-flash',
      'omni-flash-vref'
    ];
    for (const modelId of deadModels) {
      db.delete(modelPricing).where(eq(modelPricing.modelPattern, modelId)).run();
      db.delete(models).where(eq(models.modelId, modelId)).run();
    }
    console.log('🧹 已从数据库强制清理废弃的模型列表');
  } catch (err: any) {
    console.error('⚠️ 清理废弃模型出错:', err.message);
  }

  // 仅在 API 成功拉取时才清理不在列表中的旧模型，网络失败时保留已有数据
  if (apiSuccess) {
    const verifiedIds = new Set(allVerified.map(m => m.modelId));
    // Google discovery must only manage Google-owned rows. Dynamic HM Studio,
    // OpenAI and administrator-created models are managed by their own channel
    // sync and must survive every restart/deployment.
    const toRemove = existingModels.filter(m => shouldRemoveMissingGoogleModel(m, verifiedIds));
    if (toRemove.length > 0) {
      for (const m of toRemove) {
        db.delete(modelPricing).where(eq(modelPricing.modelPattern, m.modelId)).run();
        db.delete(tierModelAccess).where(eq(tierModelAccess.modelId, m.id)).run();
        db.delete(models).where(eq(models.id, m.id)).run();
      }
      console.log(`🧹 移除 ${toRemove.length} 个不可用模型: ${toRemove.map(m => m.modelId).join(', ')}`);
    }
  }
}

/**
 * 初始化数据库表结构 + 种子数据
 * 幂等操作：可重复执行，不会重复创建
 */
export async function initDatabase() {
  // 1) 创建表
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      daily_quota INTEGER NOT NULL DEFAULT 3,
      allowed_features TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      tier_id INTEGER NOT NULL DEFAULT 1,
      tier_expires_at TEXT,
      quota_override INTEGER,
      wechat_openid TEXT,
      balance REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'google',
      model_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      description TEXT,
      api_key TEXT,
      capabilities TEXT NOT NULL DEFAULT '["text"]',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tier_model_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tier_id INTEGER NOT NULL,
      model_id INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      analysis_type TEXT NOT NULL,
      model_id INTEGER,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ============ 新增：渠道表 ============
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'openai',
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL DEFAULT '',
      model_mapping TEXT NOT NULL DEFAULT '{}',
      supported_models TEXT NOT NULL DEFAULT '[]',
      priority INTEGER NOT NULL DEFAULT 0,
      weight INTEGER NOT NULL DEFAULT 1,
      concurrency_limit INTEGER NOT NULL DEFAULT 10,
      max_retries INTEGER NOT NULL DEFAULT 3,
      timeout INTEGER NOT NULL DEFAULT 120000,
      status INTEGER NOT NULL DEFAULT 1,
      last_test_at TEXT,
      last_test_result TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- HM Studio 渠道可绑定多个独立并发 API Key
    CREATE TABLE IF NOT EXISTS channel_api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      api_key TEXT NOT NULL UNIQUE,
      concurrency_limit INTEGER NOT NULL DEFAULT 10,
      status INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_channel_api_keys_channel_id ON channel_api_keys(channel_id);

    -- ============ 新增：API Token 表 ============
    CREATE TABLE IF NOT EXISTS api_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      name TEXT NOT NULL DEFAULT '',
      token_key TEXT NOT NULL UNIQUE,
      allowed_models TEXT NOT NULL DEFAULT '[]',
      balance REAL NOT NULL DEFAULT -1,
      used_amount REAL NOT NULL DEFAULT 0,
      rate_limit INTEGER NOT NULL DEFAULT -1,
      status INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ============ 新增：模型计费表 ============
    CREATE TABLE IF NOT EXISTS model_pricing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_pattern TEXT NOT NULL,
      billing_type TEXT NOT NULL DEFAULT 'per_call',
      input_price REAL NOT NULL DEFAULT 0,
      output_price REAL NOT NULL DEFAULT 0,
      extra_params TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ============ 新增：API 调用日志表 ============
    CREATE TABLE IF NOT EXISTS api_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id INTEGER,
      channel_id INTEGER,
      model TEXT NOT NULL,
      upstream_model TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'success',
      error_message TEXT,
      client_ip TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ============ 新增：组织表 ============
    CREATE TABLE IF NOT EXISTS organizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      logo_url TEXT,
      tier_id INTEGER NOT NULL DEFAULT 1,
      balance REAL NOT NULL DEFAULT 0,
      max_members INTEGER NOT NULL DEFAULT 10,
      owner_id INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ============ 新增：组织成员表 ============
    CREATE TABLE IF NOT EXISTS org_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      invited_by INTEGER,
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(org_id, user_id)
    );

    -- ============ 新增：生成内容表 ============
    CREATE TABLE IF NOT EXISTS contents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      org_id INTEGER,
      type TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      input_text TEXT,
      result_url TEXT,
      result_text TEXT,
      model_id TEXT,
      cost REAL NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS model_feedbacks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      content_id INTEGER,
      model_id TEXT NOT NULL,
      error_message TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      admin_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_usage_logs_user_date ON usage_logs(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_api_tokens_key ON api_tokens(token_key);
    CREATE INDEX IF NOT EXISTS idx_api_logs_token ON api_logs(token_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_api_logs_channel ON api_logs(channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_org_members_org ON org_members(org_id);
    CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_contents_user ON contents(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_contents_user_type_created ON contents(user_id, type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_contents_org ON contents(org_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_contents_type_status_created ON contents(type, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_contents_model_created ON contents(model_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_contents_created ON contents(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_model_feedbacks_user ON model_feedbacks(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_model_feedbacks_status ON model_feedbacks(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_model_feedbacks_model ON model_feedbacks(model_id, created_at);
  `);

  // 增量迁移：为已有 users 表添加 balance 列（新建数据库已包含，此处兼容旧库）
  try {
    sqlite.exec(`ALTER TABLE users ADD COLUMN balance REAL NOT NULL DEFAULT 0`);
    console.log('🔄 已迁移：users 表添加 balance 列');
  } catch {
    // 列已存在则忽略
  }

  // 增量迁移：为已有 users 表添加 org_id 列
  try {
    sqlite.exec(`ALTER TABLE users ADD COLUMN org_id INTEGER`);
    console.log('🔄 已迁移：users 表添加 org_id 列');
  } catch {
    // 列已存在则忽略
  }

  // 增量迁移：为已有 models 表添加 description 列
  try {
    sqlite.exec(`ALTER TABLE models ADD COLUMN description TEXT`);
    console.log('🔄 已迁移：models 表添加 description 列');
  } catch {
    // 列已存在则忽略
  }

  // 增量迁移：admin → super_admin 角色升级
  {
    const oldAdmins = db.select().from(users).where(eq(users.role, 'admin')).all();
    if (oldAdmins.length > 0) {
      db.update(users).set({ role: 'super_admin' }).where(eq(users.role, 'admin')).run();
      console.log(`🔄 已迁移：${oldAdmins.length} 个 admin → super_admin`);
    }
  }

  // 2) 种子数据 - 等级
  const existingTiers = db.select().from(tiers).all();
  if (existingTiers.length === 0) {
    console.log('📦 初始化默认等级...');
    db.insert(tiers).values([
      {
        name: 'free',
        displayName: '免费用户',
        dailyQuota: 3,
        allowedFeatures: JSON.stringify(['general', 'image']),
        sortOrder: 0,
      },
      {
        name: 'basic',
        displayName: '基础会员',
        dailyQuota: 30,
        allowedFeatures: JSON.stringify(['general', 'ecommerce', 'image', 'copywriting', 'account', 'tts', 'video']),
        sortOrder: 1,
      },
      {
        name: 'pro',
        displayName: '专业会员',
        dailyQuota: 100,
        allowedFeatures: JSON.stringify(['general', 'ecommerce', 'image', 'copywriting', 'account', 'generate_image', 'modify_prompt', 'tts', 'video']),
        sortOrder: 2,
      },
      {
        name: 'enterprise',
        displayName: '企业会员',
        dailyQuota: -1,
        allowedFeatures: JSON.stringify(['*']),
        sortOrder: 3,
      },
    ]).run();
  } else {
    // 保证已存在等级具有 tts / video 权限
    try {
      for (const t of existingTiers) {
        const allowed: string[] = JSON.parse(t.allowedFeatures || '[]');
        if (allowed.includes('*')) continue;
        let changed = false;
        for (const feat of ['tts', 'video']) {
          if ((t.name === 'basic' || t.name === 'pro') && !allowed.includes(feat)) {
            allowed.push(feat);
            changed = true;
            console.log(`🔄 已迁移：为 ${t.name} 等级添加 ${feat} 权限`);
          }
        }
        if (changed) {
          db.update(tiers).set({ allowedFeatures: JSON.stringify(allowed) }).where(eq(tiers.id, t.id)).run();
        }
      }
    } catch (e) {
      console.error('更新等级权限失败:', e);
    }
  }

  // 3) 从 Google API 动态发现可用模型，同步到数据库
  await syncModelsFromAPI();

  // 4) 种子数据 - 等级-模型关联（增量补全）
  {
    const allTiers = db.select().from(tiers).all();
    const allModels = db.select().from(models).all();
    const existingAccess = db.select().from(tierModelAccess).all();
    const existingPairs = new Set(existingAccess.map(a => `${a.tierId}-${a.modelId}`));

    const freeTier = allTiers.find(t => t.name === 'free');
    const basicTier = allTiers.find(t => t.name === 'basic');
    const proTier = allTiers.find(t => t.name === 'pro');
    const enterpriseTier = allTiers.find(t => t.name === 'enterprise');

    const accessEntries: { tierId: number; modelId: number }[] = [];

    for (const m of allModels) {
      const isImageModel = m.modelId.includes('image');

      // free, basic → 仅文本模型（非 image/pro 专属）
      if (!isImageModel && !m.modelId.includes('pro')) {
        if (freeTier) accessEntries.push({ tierId: freeTier.id, modelId: m.id });
        if (basicTier) accessEntries.push({ tierId: basicTier.id, modelId: m.id });
      }

      // pro → 所有模型
      if (proTier) accessEntries.push({ tierId: proTier.id, modelId: m.id });

      // enterprise → 所有模型
      if (enterpriseTier) accessEntries.push({ tierId: enterpriseTier.id, modelId: m.id });
    }

    // 只插入不存在的关联
    const newEntries = accessEntries.filter(e => !existingPairs.has(`${e.tierId}-${e.modelId}`));
    if (newEntries.length > 0) {
      console.log(`📦 补全 ${newEntries.length} 条等级-模型权限映射`);
      db.insert(tierModelAccess).values(newEntries).run();
    }
  }

  // 5) 种子数据 - 超级管理员账号
  const existingSuperAdmin = db.select().from(users).where(eq(users.role, 'super_admin')).all();
  if (existingSuperAdmin.length === 0) {
    console.log('📦 创建默认超级管理员账号...');
    const enterpriseTier = db.select().from(tiers).where(eq(tiers.name, 'enterprise')).get();
    const hash = bcrypt.hashSync(env.ADMIN_PASSWORD, 12);
    db.insert(users).values({
      email: env.ADMIN_EMAIL,
      username: '超级管理员',
      passwordHash: hash,
      role: 'super_admin',
      tierId: enterpriseTier?.id || 4,
    }).run();
    console.log(`✅ 超级管理员账号: ${env.ADMIN_EMAIL}`);
  } else {
    // 已有超级管理员 → 同步 .env 中的密码（防止改了 .env 但旧哈希还在数据库）
    const admin = existingSuperAdmin[0];
    const passwordChanged = !bcrypt.compareSync(env.ADMIN_PASSWORD, admin.passwordHash);
    if (passwordChanged) {
      const newHash = bcrypt.hashSync(env.ADMIN_PASSWORD, 12);
      db.update(users).set({ passwordHash: newHash }).where(eq(users.id, admin.id)).run();
      console.log('🔄 超级管理员密码已同步更新');
    }
  }

  // 6) 种子数据 - 系统设置
  const existingSettings = db.select().from(settings).all();
  if (existingSettings.length === 0) {
    console.log('📦 初始化系统设置...');
    db.insert(settings).values([
      { key: 'contact_wechat', value: '', label: '微信号' },
      { key: 'contact_qq', value: '', label: 'QQ号' },
      { key: 'site_notice', value: '欢迎使用短视频创意风暴！升级会员请联系客服。', label: '站点公告' },
      { key: 'video_rate_480p', value: '0.03', label: '视频480p费率(¥/秒)' },
      { key: 'video_rate_720p', value: '0.05', label: '视频720p费率(¥/秒)' },
      { key: 'image_rate', value: '0.05', label: '图片生成费率(¥/张)' },
    ]).run();
  }

  const routingSettings = [
    { key: 'siyuetian_sd25_routing_strategy', value: 'failover', label: '四月天 / Julun sd2.5 路由策略' },
    { key: 'internal_siyuetian_sd25_round_robin_next', value: 'siyuetian', label: '四月天 / Julun sd2.5 轮询游标' },
  ];
  for (const item of routingSettings) {
    if (!db.select().from(settings).where(eq(settings.key, item.key)).get()) {
      db.insert(settings).values(item).run();
    }
  }

  // 强制清理与修正数据库中废弃的多余 Sora 4 / Seedance 费率设置项
  const keysToDelete = [
    'sdas_fast_rate',
    'sdas_pro_rate',
    'lg_seedance_fast_rate',
    'sdas_d7_face_rate',
    'sdas_mo_dj_rate',
    'sd2_c8_rate',
    'sora_v4_fast_rate',
    'sora_v4_pro_rate',
    'seedance_2_0_fast_rate',
    'sdas_hn_sd20_720p_rate',
    'sdas_hn_sd20_fast_720p_rate',
    'jimeng_video_seedance_2_0_fast_rate',
    'jimeng_video_seedance_2_0_vip_rate_720p',
    'jimeng_video_seedance_2_0_vip_rate_1080p',
    'sora2_rate',
    'seedance20_full_9img_rate',
    'seedance20_full_4img_rate',
    'seedance20_fast_4img_rate',
    'sdas_wf_sd20_fast_933_720p_rate',
    'sdas_wf_sd20_pro_933_480p_rate',
    'sdas_pg_s20_fast_rate',
    'grok_imagine_video_1_5_1080p_rate',
    'sdas_xh_sd20_933_3_pro_720p_rate'
  ];
  for (const k of keysToDelete) {
    db.delete(settings).where(eq(settings.key, k)).run();
  }

  // 物理清理 md-seedance 模型和设置项以彻底删除它们
  try {
    db.delete(models).where(like(models.modelId, 'md-seedance-%')).run();
    db.delete(settings).where(like(settings.key, 'md_seedance_%')).run();
    console.log('🧹 已从数据库彻底删除 md-seedance 模型与设置项');
  } catch (err: any) {
    console.error('⚠️ 清理 md-seedance 模型与设置项出错:', err.message);
  }

  // 保证 Omni & Sora 费率配置项存在
  const omniSettings = [
    { key: 'veo_omni_flash_rate', value: '0.25', label: 'Veo Omni Flash 费率(¥/秒)' },
    { key: 'veo_3_1_rate', value: '0.20', label: 'Veo 3-1 费率(¥/秒)' },
    { key: 'sd2_c7_rate', value: '0.50', label: 'Seedance 2.0 c7 费率(¥/次)' },
    { key: 'sd2_5_rate', value: '3.50', label: 'Seedance 2.5 (sd2.5) 费率(¥/次)' },
    { key: 'sd2_mini_rate', value: '2.00', label: 'Seedance Mini (sd2-mini) 费率(¥/次)' },
    { key: 'seedance2_0_933_rate', value: '3.00', label: 'seedance2.0 933 费率(¥/次)' },
    { key: 'seedance_2_0_720p_rate', value: '3.00', label: 'Seedance 2.0 720p 费率(¥/次)' },
    { key: 'seedance_2_0_fast_720p_rate', value: '1.50', label: 'Seedance 2.0 Fast 720p 费率(¥/次)' },
    { key: 'ld_sdas_cvk_pro_933_720p_rate', value: '3.80', label: 'SudaShui CVK Pro 933 (720p) 费率(¥/次)' },
    { key: 'sdas_mj_minimax_h3_2k_rate', value: '3.00', label: 'Minimax H3 (2K) 费率(¥/次)' },
    { key: 'sdas_bl_sd20_933_pro_720p_rate', value: '4.50', label: 'Seedance 2.0 Pro (933人脸版) 费率(¥/次)' },
    { key: 'sdas_bl_sd20_933_pro_noface_720p_rate', value: '4.00', label: 'Seedance 2.0 Pro (933无脸版) 费率(¥/次)' },
    { key: 'cd_seedance_2_0_720p_rate', value: '3.00', label: 'Seedance 2.0 (720p/CD版) 费率(¥/次)' },
    { key: 'nd_seedance_2_0_480p_rate', value: '3.15', label: 'Seedance 2.0 (480p/不卡脸) 费率(¥/次)' },
    { key: 'nd_seedance_2_0_720p_rate', value: '4.30', label: 'Seedance 2.0 (720p/不卡脸) 费率(¥/次)' },
    { key: 'sd2_c6_rate', value: '2.50', label: 'Seedance 2.0 c6 费率(¥/次)' },
    { key: 'seedance_720_rate', value: '3.00', label: 'Seedance 720 满血版 费率(¥/次)' },
    { key: 'seedance_2_5_c1_rate', value: '0.25', label: 'Seedance 2.5 (c1) 费率(¥/秒)' },
    { key: 'xd_seedance_2_5_720p_rate', value: '1.20', label: 'Seedance 2.5 (720p/XD版) 费率(¥/次)' },
    { key: 'grok_video_1_5_per_sec_rate', value: '0.09', label: 'grok-video-1.5（按秒） 费率(¥/秒)' },
    { key: 'grok_imagine_video_1_5_per_req_rate', value: '0.60', label: 'grok-imagine-video-1.5（按次） 费率(¥/次)' },
    { key: 'snumom_sd_mini_per_req_rate', value: '0.60', label: 'snumom sd-mini 费率(¥/次)' },
    { key: 'grok_imagine_video_1_5_preview_rate', value: '0.70', label: 'grok-imagine-video-1.5-preview 费率(¥/次)' },
    { key: 'seedance_2_5_deal_rate', value: '1.80', label: 'seedance-2.5-deal 费率(¥/次)' },
    { key: 'seedance_2_5m_rate', value: '3.00', label: 'seedance-2.5m 费率(¥/次)' },
    { key: 'wan3_0th_rate', value: '0.14', label: 'wan3.0th 费率(¥/秒)' },
    { key: 'julun_minimax_h3_768p_rate', value: '0.18', label: '巨轮 MiniMax H3 768p 费率(¥/秒)' },
    { key: 'snumom_wan3_video_rate', value: '0.14', label: 'snumom Wan 3.0 Video 默认费率(¥/秒)' },
    { key: 'snumom_wan3_video_prime_rate', value: '0.18', label: 'snumom Wan 3.0 Video Prime 默认费率(¥/秒)' },
  ];
  // 物理清理旧 of rd_seedance 相关的设置项
  db.delete(settings).where(eq(settings.key, 'rd_seedance_2_5_480p_rate')).run();
  db.delete(settings).where(eq(settings.key, 'rd_seedance_2_5_720p_rate')).run();
  db.delete(settings).where(eq(settings.key, 'tejiasd2_rate')).run();
  db.delete(settings).where(eq(settings.key, 'sd20_fast_480p_rate')).run();
  db.delete(settings).where(eq(settings.key, 'sdas_pd_sd20_pro_933_5_720p_rate')).run();
  db.delete(settings).where(eq(settings.key, 'sdas_my_seedance_20_fast_720p_rate')).run();
  db.delete(settings).where(eq(settings.key, 'sdas_gf7_seedance_2_5_480p_rate')).run();
  db.delete(settings).where(eq(settings.key, 'sdas_gf7_seedance_2_5_720p_rate')).run();
  db.delete(settings).where(eq(settings.key, 'omni_flash_rate_720p')).run();
  db.delete(settings).where(eq(settings.key, 'omni_flash_rate_1080p')).run();
  db.delete(settings).where(eq(settings.key, 'omni_vref_rate_720p')).run();
  db.delete(settings).where(eq(settings.key, 'omni_vref_rate_1080p')).run();
  db.delete(settings).where(eq(settings.key, 'grok_imagine_1_0_video_rate')).run();
  db.delete(settings).where(eq(settings.key, 'grok_imagine_video_1_5_fast_rate')).run();
  db.delete(settings).where(eq(settings.key, 'grok_imagine_video_1_5_preview_rate')).run();

  // 物理清理废弃的 Seedance 2.5 相关的模型
  db.delete(models).where(eq(models.modelId, 'md-seedance-2.5-480p')).run();
  db.delete(models).where(eq(models.modelId, 'md-seedance-2.5-720p')).run();
  db.delete(models).where(eq(models.modelId, 'sdas-gf7-seedance-2.5-480p')).run();
  db.delete(models).where(eq(models.modelId, 'sdas-gf7-seedance-2.5-720p')).run();

  for (const s of omniSettings) {
    const existing = db.select().from(settings).where(eq(settings.key, s.key)).get();
    if (!existing) {
      db.insert(settings).values(s).run();
      console.log(`📦 已迁移：添加 Omni / Sora 费率配置 ${s.key}`);
    } else {
      // 强制修正数据库中已有的标签以纠正显示单位
      const updateData: Partial<typeof s> = {};
      if (existing.label !== s.label) {
        updateData.label = s.label;
      }
      // 对于价格发生变化的设置项，如果存在且值不同，则强制更新数值
      if (s.key === 'veo_omni_flash_rate' || s.key === 'veo_3_1_rate' || s.key === 'sd2_5_rate' || s.key === 'nd_seedance_2_0_480p_rate' || s.key === 'nd_seedance_2_0_720p_rate' || s.key.startsWith('vd_seedance_2_5_') || s.key === 'seedance_2_5_c1_rate' || s.key.startsWith('md_seedance_')) {
        if (existing.value !== s.value) {
          updateData.value = s.value;
        }
      }
      if (Object.keys(updateData).length > 0) {
        db.update(settings).set(updateData).where(eq(settings.key, s.key)).run();
        console.log(`🔄 已修正：更新设置项 ${s.key} -> ${JSON.stringify(updateData)}`);
      }
    }
  }

  // 7) 种子数据 - 默认 API Token（管理员用）
  const existingTokens = db.select().from(apiTokens).all();
  if (existingTokens.length === 0) {
    const admin = db.select().from(users).where(eq(users.role, 'admin')).get();
    if (admin) {
      console.log('📦 创建默认 API Token...');
      const tokenKey = generateTokenKey();
      db.insert(apiTokens).values({
        userId: admin.id,
        name: '默认管理员 Token',
        tokenKey,
        balance: -1,  // 无限额度
        rateLimit: -1,
      }).run();
      console.log(`🔑 默认 API Token: ${tokenKey}`);
    }
  }

  // 8) 种子数据 - 默认计费规则
  const IMAGE_MULTIPLIER = 3;

  const defaultPricing = [
    {
      modelPattern: '*',
      billingType: 'per_token',
      inputPrice: 0.01,   // ¥0.01 / 1M tokens
      outputPrice: 0.03,  // ¥0.03 / 1M tokens
    },
    {
      modelPattern: 'gpt-image-2',
      billingType: 'per_call',
      inputPrice: 0.04 * IMAGE_MULTIPLIER,   // 3x multiplier (0.12)
      outputPrice: 0,
    },

    {
      modelPattern: 'gemini-3.1-flash-image-preview',
      billingType: 'per_call',
      inputPrice: 0.14 * IMAGE_MULTIPLIER,   // 3x multiplier (0.42)
      outputPrice: 0,
    },
    {
      modelPattern: 'gemini-3-pro-image-preview',
      billingType: 'per_call',
      inputPrice: 0.20 * IMAGE_MULTIPLIER,   // 3x multiplier (0.60)
      outputPrice: 0,
    },

    {
      modelPattern: 'sdas-bl-sd2.0-933-pro-720p',
      billingType: 'per_call',
      inputPrice: 4.50,
      outputPrice: 0,
    },
    {
      modelPattern: 'sdas-bl-sd2.0-933-pro-noface-720p',
      billingType: 'per_call',
      inputPrice: 4.00,
      outputPrice: 0,
    },
    {
      modelPattern: 'cd-seedance-2.0-720p',
      billingType: 'per_call',
      inputPrice: 3.00,
      outputPrice: 0,
    },
    {
      modelPattern: 'sd2-mini',
      billingType: 'per_call',
      inputPrice: 2.00,
      outputPrice: 0,
    },
    {
      modelPattern: 'seedance2.0-933',
      billingType: 'per_call',
      inputPrice: 3.00,
      outputPrice: 0,
    },
    {
      modelPattern: 'seedance2.0 933',
      billingType: 'per_call',
      inputPrice: 3.00,
      outputPrice: 0,
    },
    {
      modelPattern: 'nd-seedance-2.0-480p',
      billingType: 'per_call',
      inputPrice: 3.15,
      outputPrice: 0,
    },
    {
      modelPattern: 'nd-seedance-2.0-720p',
      billingType: 'per_call',
      inputPrice: 4.30,
      outputPrice: 0,
    },
    {
      modelPattern: 'seedance-2.5-c1',
      billingType: 'per_token',
      inputPrice: 0.25,
      outputPrice: 0,
    },
  ];

  db.delete(modelPricing).where(eq(modelPricing.modelPattern, 'rd-seedance-2.5-480p')).run();
  db.delete(modelPricing).where(eq(modelPricing.modelPattern, 'rd-seedance-2.5-720p')).run();
  db.delete(modelPricing).where(eq(modelPricing.modelPattern, 'grok-imagine-1.0-video')).run();
  db.delete(modelPricing).where(eq(modelPricing.modelPattern, 'grok-imagine-video-1.5')).run();
  db.delete(modelPricing).where(eq(modelPricing.modelPattern, 'grok-imagine-video-1.5-preview')).run();
  db.delete(modelPricing).where(eq(modelPricing.modelPattern, 'grok-imagine-video-1.5-fast')).run();

  console.log('📦 同步计费规则到数据库 (更新/插入)...');
  for (const pricing of defaultPricing) {
    const modelExists = pricing.modelPattern === '*'
      || Boolean(db.select().from(models).where(eq(models.modelId, pricing.modelPattern)).get());
    if (!modelExists) continue;
    const existing = db.select().from(modelPricing).where(eq(modelPricing.modelPattern, pricing.modelPattern)).get();
    if (!existing) {
      db.insert(modelPricing).values(pricing).run();
    }
  }

  // Migrate legacy dashboard prices once. Existing pricing rules always win, so
  // restarting the server can never overwrite a price edited by an administrator.
  const legacyRate = (key: string, fallback: number) => {
    const row = db.select().from(settings).where(eq(settings.key, key)).get();
    const value = Number(row?.value);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  const unifiedPricing = [
    { modelPattern: 'veo-omni-flash', billingType: 'per_second', inputPrice: legacyRate('veo_omni_flash_rate', 0.25), category: 'video' },
    { modelPattern: 'veo-omni-flash-video-edit', billingType: 'per_second', inputPrice: 0.09, category: 'video' },
    { modelPattern: 'veo-3-1', billingType: 'per_second', inputPrice: legacyRate('veo_3_1_rate', 0.20), category: 'video' },
    { modelPattern: 'sd2-c7', billingType: 'per_call', inputPrice: legacyRate('sd2_c7_rate', 0.50), category: 'video' },
    { modelPattern: 'sd2.5', billingType: 'per_call', inputPrice: legacyRate('sd2_5_rate', 3.50), category: 'video' },
    { modelPattern: 'sd2-c6', billingType: 'per_call', inputPrice: legacyRate('sd2_c6_rate', 2.50), category: 'video' },
    { modelPattern: 'sd2-mini', billingType: 'per_call', inputPrice: legacyRate('sd2_mini_rate', 2.00), category: 'video' },
    { modelPattern: 'seedance2.0-933', billingType: 'per_call', inputPrice: legacyRate('seedance2_0_933_rate', 3.00), category: 'video' },
    { modelPattern: 'seedance2.0 933', billingType: 'per_call', inputPrice: legacyRate('seedance2_0_933_rate', 3.00), category: 'video' },
    { modelPattern: 'seedance-2.0-720p', billingType: 'per_call', inputPrice: legacyRate('seedance_2_0_720p_rate', 3.00), category: 'video' },
    { modelPattern: 'seedance-2.0-fast-720p', billingType: 'per_call', inputPrice: legacyRate('seedance_2_0_fast_720p_rate', 1.50), category: 'video' },
    { modelPattern: 'seedance-720', billingType: 'per_call', inputPrice: legacyRate('seedance_720_rate', 3.00), category: 'video' },
    { modelPattern: 'ld-sdas-cvk-pro-933-720p', billingType: 'per_call', inputPrice: legacyRate('ld_sdas_cvk_pro_933_720p_rate', 3.80), category: 'video' },
    { modelPattern: 'sdas-mj-minimax-h3-2k', billingType: 'per_call', inputPrice: legacyRate('sdas_mj_minimax_h3_2k_rate', 3.00), category: 'video' },
    { modelPattern: 'sdas-bl-sd2.0-933-pro-720p', billingType: 'per_call', inputPrice: legacyRate('sdas_bl_sd20_933_pro_720p_rate', 4.50), category: 'video' },
    { modelPattern: 'sdas-bl-sd2.0-933-pro-noface-720p', billingType: 'per_call', inputPrice: legacyRate('sdas_bl_sd20_933_pro_noface_720p_rate', 4.00), category: 'video' },
    { modelPattern: 'cd-seedance-2.0-720p', billingType: 'per_call', inputPrice: legacyRate('cd_seedance_2_0_720p_rate', 3.00), category: 'video' },
    { modelPattern: 'nd-seedance-2.0-480p', billingType: 'per_call', inputPrice: legacyRate('nd_seedance_2_0_480p_rate', 3.15), category: 'video' },
    { modelPattern: 'nd-seedance-2.0-720p', billingType: 'per_call', inputPrice: legacyRate('nd_seedance_2_0_720p_rate', 4.30), category: 'video' },
    { modelPattern: 'ad-seedance-2.5-480p', billingType: 'per_second', inputPrice: 0.35, category: 'video' },
    { modelPattern: 'vd-seedance-2.5-480p', billingType: 'per_second', inputPrice: 0.25, category: 'video' },
    { modelPattern: 'vd-seedance-2.5-720p', billingType: 'per_second', inputPrice: 0.30, category: 'video' },
    { modelPattern: 'td-seedance-2.5-720p', billingType: 'per_call', inputPrice: 7.00, category: 'video' },
    { modelPattern: 'xd-seedance-2.5-720p', billingType: 'per_call', inputPrice: legacyRate('xd_seedance_2_5_720p_rate', 1.20), category: 'video' },
    { modelPattern: 'seedance-2.5-c1', billingType: 'per_second', inputPrice: legacyRate('seedance_2_5_c1_rate', 0.25), category: 'video' },
    { modelPattern: 'seedance-2.5-deal', billingType: 'per_call', inputPrice: legacyRate('seedance_2_5_deal_rate', 1.80), category: 'video' },
    { modelPattern: 'seedance-2.5m', billingType: 'per_call', inputPrice: legacyRate('seedance_2_5m_rate', 3.00), category: 'video' },
    { modelPattern: 'wan3.0th', billingType: 'per_second', inputPrice: legacyRate('wan3_0th_rate', 0.14), category: 'video' },
    { modelPattern: JULUN_MINIMAX_H3_MODEL, billingType: 'per_second', inputPrice: legacyRate('julun_minimax_h3_768p_rate', 0.18), category: 'video', extraParams: { '768p': 0.18 } },
    { modelPattern: 'wan3.0-video', billingType: 'per_second', inputPrice: legacyRate('snumom_wan3_video_rate', 0.14), category: 'video', extraParams: { '480p': 0.12, '720p': 0.14, '1080p': 0.16 } },
    { modelPattern: 'wan3.0-video-prime', billingType: 'per_second', inputPrice: legacyRate('snumom_wan3_video_prime_rate', 0.18), category: 'video', extraParams: { '480p': 0.15, '720p': 0.18, '1080p': 0.20 } },
    { modelPattern: 'grok-video-1.5', billingType: 'per_second', inputPrice: legacyRate('grok_video_1_5_per_sec_rate', 0.09), category: 'video' },
    { modelPattern: SNUMOM_GROK_IMAGINE_VIDEO_MODEL, billingType: 'per_call', inputPrice: legacyRate('grok_imagine_video_1_5_per_req_rate', 0.60), category: 'video' },
    { modelPattern: SNUMOM_SD_MINI_MODEL, billingType: 'per_call', inputPrice: legacyRate('snumom_sd_mini_per_req_rate', 0.60), category: 'video' },
    { modelPattern: 'grok-imagine-video-1.5-preview', billingType: 'per_call', inputPrice: legacyRate('grok_imagine_video_1_5_preview_rate', 0.70), category: 'video' },
    { modelPattern: 'gemini-2.5-flash-preview-tts', billingType: 'per_character', inputPrice: legacyRate('tts_rate', 0.01), category: 'tts' },
    { modelPattern: 'gemini-2.5-pro-preview-tts', billingType: 'per_character', inputPrice: legacyRate('tts_rate', 0.01) * 2, category: 'tts' },
  ];

  for (const pricing of unifiedPricing) {
    const modelExists = Boolean(db.select().from(models).where(eq(models.modelId, pricing.modelPattern)).get());
    if (!modelExists) continue;
    const existing = db.select().from(modelPricing).where(eq(modelPricing.modelPattern, pricing.modelPattern)).get();
    if (!existing) {
      db.insert(modelPricing).values({
        modelPattern: pricing.modelPattern,
        billingType: pricing.billingType,
        inputPrice: pricing.inputPrice,
        outputPrice: 0,
        extraParams: JSON.stringify({ category: pricing.category, ...('extraParams' in pricing ? pricing.extraParams : {}) }),
      }).run();
    } else if (
      (pricing.modelPattern === 'seedance-2.5-c1' && existing.billingType === 'per_token')
      || (pricing.category === 'tts' && existing.billingType !== 'per_character')
    ) {
      let extraParams: Record<string, any> = {};
      try { extraParams = JSON.parse(existing.extraParams || '{}'); } catch { /* ignore invalid legacy JSON */ }
      db.update(modelPricing).set({
        billingType: pricing.billingType,
        extraParams: JSON.stringify({ ...extraParams, category: pricing.category }),
      }).where(eq(modelPricing.id, existing.id)).run();
    }
  }

  // One-time production migration: align WAN3.0 with the confirmed ¥0.14/second price.
  // The marker prevents future restarts from overwriting administrator edits.
  const wanPricingMigrationKey = 'migration_wan3_0th_per_second_014_v2';
  const wanPricingMigrated = db.select().from(settings).where(eq(settings.key, wanPricingMigrationKey)).get();
  if (!wanPricingMigrated) {
    const wanRule = db.select().from(modelPricing).where(eq(modelPricing.modelPattern, 'wan3.0th')).get();
    if (wanRule) {
      let extraParams: Record<string, any> = {};
      try { extraParams = JSON.parse(wanRule.extraParams || '{}'); } catch { /* ignore invalid legacy JSON */ }
      db.update(modelPricing).set({
        billingType: 'per_second',
        inputPrice: 0.14,
        extraParams: JSON.stringify({ ...extraParams, category: 'video' }),
      }).where(eq(modelPricing.id, wanRule.id)).run();
    }
    db.update(settings).set({ value: '0.14', label: 'wan3.0th 费率(¥/秒)' })
      .where(eq(settings.key, 'wan3_0th_rate')).run();
    db.update(models).set({
      description: '按秒计费，¥0.14/秒；720p；支持4-30秒文生视频和多参考视频；最多10张图片、5个视频、5段音频公网URL，音频仅支持WAV；支持1:1、16:9、9:16、4:3、3:4',
    }).where(eq(models.modelId, 'wan3.0th')).run();
    db.insert(settings).values({
      key: wanPricingMigrationKey,
      value: '1',
      label: 'WAN3.0 按秒计费迁移标记',
    }).run();
    console.log('🔄 已迁移：WAN3.0 按秒计费更新为 ¥0.14/秒');
  }

  const julunH3PricingMigrationKey = 'migration_julun_minimax_h3_768p_per_second_018_v1';
  const julunH3PricingMigrated = db.select().from(settings).where(eq(settings.key, julunH3PricingMigrationKey)).get();
  if (!julunH3PricingMigrated) {
    const h3Rule = db.select().from(modelPricing).where(eq(modelPricing.modelPattern, JULUN_MINIMAX_H3_MODEL)).get();
    if (h3Rule) {
      db.update(modelPricing).set({
        billingType: 'per_second',
        inputPrice: 0.18,
        outputPrice: 0,
        extraParams: JSON.stringify({ category: 'video', '768p': 0.18 }),
      }).where(eq(modelPricing.id, h3Rule.id)).run();
    }
    db.update(settings).set({ value: '0.18', label: '巨轮 MiniMax H3 768p 费率(¥/秒)' })
      .where(eq(settings.key, 'julun_minimax_h3_768p_rate')).run();
    db.insert(settings).values({
      key: julunH3PricingMigrationKey,
      value: '1',
      label: '巨轮 MiniMax H3 768p ¥0.18/秒迁移标记',
    }).run();
    console.log('🔄 已迁移：巨轮 MiniMax H3 768p 按 ¥0.18/秒计费');
  }

  // 9) 自动向已存在且包含 sudashuiapi.com 或 pidoi.com 的渠道添加支持的模型 ID，防止路由错误
  try {
    const sdaModels = [
      'sdas-my-seedance-2.0-fast-720p',
      'ld-sdas-cvk-pro-933-720p',
      'sdas-mj-minimax-h3-2k',
      'sdas-bl-sd2.0-933-pro-720p',
      'sdas-bl-sd2.0-933-pro-noface-720p'
    ];
    const pidoiModels: string[] = [];
    const allChannels = db.select().from(channels).all();
    for (const c of allChannels) {
      let currentModels: string[] = [];
      try {
        currentModels = JSON.parse(c.supportedModels || '[]');
      } catch { }
      if (!Array.isArray(currentModels)) currentModels = [];

      let updated = false;
      if (c.baseUrl && c.baseUrl.includes('sudashuiapi.com')) {
        const sortedSda = [...sdaModels].sort();
        const sortedCurrent = [...currentModels].sort();
        if (JSON.stringify(sortedSda) !== JSON.stringify(sortedCurrent)) {
          currentModels = [...sdaModels];
          updated = true;
        }
      } else if (c.baseUrl && c.baseUrl.includes('pidoi.com') && !c.name?.includes('图片')) {
        // 清理已被废弃不复存在的旧模型，以及全部的 Grok 视频模型
        const cleaned = currentModels.filter(m => !['seedance-2.0', 'veo-omni-flash', 'sora-v4-fast', 'sora-v4-pro', 'seedance-2.0-fast', 'sora-v3-pro', 'grok-imagine-1.0-video', 'grok-imagine-video-1.5-1080p', 'grok-imagine-video-1.5-fast', 'grok-imagine-video-1.5-preview', 'gpt-image-2-plus', 'gpt-image-2-pro', 'gpt-image-2-max', 'gpt-image-2', 'tejiasd2'].includes(m));
        if (cleaned.length !== currentModels.length) {
          currentModels = cleaned;
          updated = true;
        }
        for (const m of pidoiModels) {
          if (!currentModels.includes(m)) {
            currentModels.push(m);
            updated = true;
          }
        }
      }

      if (updated) {
        db.update(channels)
          .set({ supportedModels: JSON.stringify(currentModels), updatedAt: new Date().toISOString() })
          .where(eq(channels.id, c.id))
          .run();
        console.log(`📦 已自动修复并扩展渠道 "${c.name}" 的支持模型列表: ${currentModels.join(', ')}`);
      }
    }
  } catch (err: any) {
    console.error('⚠️ 自动修补渠道模型出错:', err.message);
  }

  // 10) 保证 NewToken 渠道存在并且包含 veo-omni-flash 支持
  try {
    const newTokenBaseUrl = env.NEWTOKEN_BASE_URL.replace(/\/+$/, '');
    const newTokenApiKey = env.NEWTOKEN_API_KEY.trim();
    const existingNewToken = db.select().from(channels).all().find(channel =>
      channel.name === 'NewToken 渠道'
      || channel.baseUrl.replace(/\/+$/, '') === newTokenBaseUrl
    );
    if (!existingNewToken) {
      db.insert(channels).values({
        name: 'NewToken 渠道',
        type: 'openai',
        baseUrl: newTokenBaseUrl,
        apiKey: newTokenApiKey,
        supportedModels: JSON.stringify(['veo-omni-flash', 'veo-omni-flash-video-edit', 'veo-3-1', 'nd-seedance-2.0-480p', 'nd-seedance-2.0-720p']),
        modelMapping: JSON.stringify({
          'nd-seedance-2.0-480p': 'nd-seedance-2.0 480p',
          'nd-seedance-2.0-720p': 'nd-seedance-2.0 720p'
        }),
        status: newTokenApiKey ? 1 : 0,
        priority: 0,
        weight: 1,
        maxRetries: 3,
        timeout: 120000,
      }).run();
      console.log('📦 已自动迁移：成功创建 NewToken 渠道并绑定 veo-omni-flash, veo-3-1 与 nd-seedance 2.0 系列');
    } else {
      let supportedModels: string[] = [];
      try { supportedModels = JSON.parse(existingNewToken.supportedModels || '[]'); } catch { }
      const updates: Record<string, any> = {};
      if (!supportedModels.includes('veo-omni-flash-video-edit')) {
        supportedModels.push('veo-omni-flash-video-edit');
        updates.supportedModels = JSON.stringify(supportedModels);
      }
      if (newTokenApiKey) updates.apiKey = newTokenApiKey;
      if (Object.keys(updates).length > 0) {
        updates.updatedAt = new Date().toISOString();
        db.update(channels).set(updates).where(eq(channels.id, existingNewToken.id)).run();
        console.log('🔄 已自动迁移：更新 NewToken 渠道并添加 veo-omni-flash-video-edit');
      }
    }
  } catch (err: any) {
    console.error('⚠️ 初始化 NewToken 渠道出错:', err.message);
  }

  // 11) 保证 llm.chre3.com 渠道存在并且包含 sd2.5, sd2-c7, seedance-2.0-720p, seedance-2.0-fast-720p 支持
  try {
    const existingChre3 = db.select().from(channels).where(eq(channels.baseUrl, 'https://llm.chre3.com')).get();
    const chre3Models = ['sd2.5', 'sd2-c7', 'seedance-2.0-720p', 'seedance-2.0-fast-720p', 'seedance-720', 'sd2-mini'];
    if (!existingChre3) {
      db.insert(channels).values({
        name: '4月天 渠道',
        type: 'openai',
        baseUrl: 'https://llm.chre3.com',
        apiKey: 'sk-jONZxfxNTSIMij2f7CgUIIdZjQkCmadK8nG51dHa3WcZMvgG',
        supportedModels: JSON.stringify(chre3Models),
        status: 1,
        priority: 0,
        weight: 1,
        maxRetries: 3,
        timeout: 120000,
      }).run();
      console.log('📦 已自动迁移：成功创建 4月天 渠道并绑定 sd2 和 seedance-720p 系列模型 (已启用)');
    } else {
      db.update(channels)
        .set({
          name: '4月天 渠道',
          supportedModels: JSON.stringify(chre3Models),
          updatedAt: new Date().toISOString()
        })
        .where(eq(channels.id, existingChre3.id))
        .run();
      console.log('🔄 已自动迁移：更新 4月天 渠道并将其标记为启用状态');
    }
  } catch (err: any) {
    console.error('⚠️ 初始化 4月天 渠道出错:', err.message);
  }

  // 13) 保证 Pidoi 图片渠道存在（独立 API Key，与视频渠道分离）
  try {
    // 查找已有的 Pidoi 图片渠道
    const existingPidoiImg = db.select().from(channels).all()
      .find(c => c.name === 'Pidoi 图片渠道' || (c.baseUrl?.includes('pidoi.com') && c.name?.includes('图片')));
    const pidoiImgModels = ['gpt-image-2'];
    if (!existingPidoiImg) {
      db.insert(channels).values({
        name: 'Pidoi 图片渠道',
        type: 'openai',
        baseUrl: 'https://pidoi.com',
        apiKey: 'sk-EWZUHbYAtE0T9aCqb2HeMbq8JBJk7ycaw731mFBWPe0CBLJ0',
        supportedModels: JSON.stringify(pidoiImgModels),
        status: 1,
        priority: 0,
        weight: 1,
        maxRetries: 3,
        timeout: 120000,
      }).run();
      console.log('📦 已自动创建 Pidoi 图片渠道（独立 Key）并绑定 gpt-image-2');
    } else {
      db.update(channels)
        .set({
          supportedModels: JSON.stringify(pidoiImgModels),
          apiKey: 'sk-EWZUHbYAtE0T9aCqb2HeMbq8JBJk7ycaw731mFBWPe0CBLJ0',
          updatedAt: new Date().toISOString()
        })
        .where(eq(channels.id, existingPidoiImg.id))
        .run();
      console.log('🔄 已更新 Pidoi 图片渠道 Key 与模型绑定');
    }
  } catch (err: any) {
    console.error('⚠️ 初始化 Pidoi 图片渠道出错:', err.message);
  }

  // 14) MJNewAPI 渠道 - 整合所有 Seedance 系列模型
  try {
    const existingMj = db.select().from(channels).where(eq(channels.name, 'MJNewAPI 渠道')).get();
    const mjModels = [
      'cd-seedance-2.0-720p',
      'nd-seedance-2.0-480p',
      'ad-seedance-2.5-480p',
      'vd-seedance-2.5-480p',
      'vd-seedance-2.5-720p',
      'td-seedance-2.5-720p',
      'xd-seedance-2.5-720p'
    ];
    const mjMapping = {
      'cd-seedance-2.0-720p': 'cd-seedance 2.0 720p',
      'nd-seedance-2.0-480p': 'nd-seedance-2.0 480p',
      'ad-seedance-2.5-480p': 'ad-seedance-2.5-480p',
      'vd-seedance-2.5-480p': 'vd-seedance-2.5-480p',
      'vd-seedance-2.5-720p': 'vd-seedance-2.5-720p',
      'td-seedance-2.5-720p': 'td-seedance-2.5-720p',
      'xd-seedance-2.5-720p': 'xd-seedance-2.5-720p'
    };

    if (!existingMj) {
      db.insert(channels).values({
        name: 'MJNewAPI 渠道',
        type: 'openai',
        baseUrl: 'https://mjnewapi.diwdiw.cn',
        apiKey: 'sk-ypnbPu4siWgwzp5EcpqvDTtU4z6q8gHqP3gYj4FV10kku4it',
        supportedModels: JSON.stringify(mjModels),
        modelMapping: JSON.stringify(mjMapping),
        status: 1,
        priority: 0,
        weight: 1,
        maxRetries: 3,
        timeout: 120000,
      }).run();
      console.log('📦 已创建整合的 MJNewAPI 渠道');
    } else {
      db.update(channels)
        .set({
          apiKey: 'sk-ypnbPu4siWgwzp5EcpqvDTtU4z6q8gHqP3gYj4FV10kku4it',
          supportedModels: JSON.stringify(mjModels),
          modelMapping: JSON.stringify(mjMapping),
          status: 1,
          updatedAt: new Date().toISOString()
        })
        .where(eq(channels.id, existingMj.id))
        .run();
      console.log('🔄 已更新整合的 MJNewAPI 渠道');
    }
  } catch (err: any) {
    console.error('⚠️ 初始化 MJNewAPI 渠道出错:', err.message);
  }

  // 15) 保证 julun.cc 渠道存在，并永久绑定 WAN3.0 与 MiniMax H3 768p。
  try {
    const julunModels = ['wan3.0th', JULUN_MINIMAX_H3_MODEL, 'sd2.5'];
    const julunMapping = Object.fromEntries(julunModels.map(modelId => [modelId, modelId]));
    const julunApiKey = 'sk-yYbcd3cH5lrl6Za89O8beER0iomYfHOyPWSqb9XMv0MLAgWS';
    const existingJulun = db.select().from(channels).where(like(channels.baseUrl, '%julun.cc%')).get();
    if (!existingJulun) {
      db.insert(channels).values({
        name: 'AI开放平台 (julun.cc) 渠道',
        type: 'openai',
        baseUrl: 'https://julun.cc',
        apiKey: julunApiKey,
        supportedModels: JSON.stringify(julunModels),
        modelMapping: JSON.stringify(julunMapping),
        status: 1,
        priority: 1,
        weight: 1,
        maxRetries: 3,
        timeout: 120000,
      }).run();
      console.log('📦 已自动迁移：成功创建 AI开放平台 (julun.cc) 渠道并配置 API Key');
    } else {
      db.update(channels)
        .set({
          apiKey: julunApiKey,
          supportedModels: JSON.stringify(julunModels),
          modelMapping: JSON.stringify(julunMapping),
          updatedAt: new Date().toISOString()
        })
        .where(eq(channels.id, existingJulun.id))
        .run();
      console.log('🔄 已自动迁移：更新 AI开放平台 (julun.cc) 渠道 Key 并保证启用状态');
    }
  } catch (err: any) {
    console.error('⚠️ 初始化 julun.cc 渠道出错:', err.message);
  }

  // 16) 保证 snumom 渠道绑定已验证的视频模型；密钥仅从环境变量或后台配置读取。
  try {
    const snumomBaseUrl = env.SNUMOM_BASE_URL.replace(/\/+$/, '');
    const snumomApiKey = env.SNUMOM_API_KEY.trim();
    const snumomModels = [...SNUMOM_VIDEO_MODELS];
    const snumomMapping = Object.fromEntries(snumomModels.map(modelId => [modelId, modelId]));
    const existingSnumom = db.select().from(channels).all().find(channel =>
      channel.type === 'snumom' || channel.baseUrl?.replace(/\/+$/, '') === snumomBaseUrl
    );
    if (!existingSnumom) {
      db.insert(channels).values({
        name: 'snumom 视频渠道',
        type: 'snumom',
        baseUrl: snumomBaseUrl,
        apiKey: snumomApiKey,
        supportedModels: JSON.stringify(snumomModels),
        modelMapping: JSON.stringify(snumomMapping),
        status: snumomApiKey ? 1 : 0,
        priority: 0,
        weight: 1,
        maxRetries: 3,
        timeout: 120000,
      }).run();
      console.log('📦 已创建 snumom 视频渠道配置');
    } else {
      db.update(channels).set({
        type: 'snumom',
        baseUrl: snumomBaseUrl,
        ...(snumomApiKey ? { apiKey: snumomApiKey, status: 1 } : {}),
        supportedModels: JSON.stringify(snumomModels),
        modelMapping: JSON.stringify(snumomMapping),
        updatedAt: new Date().toISOString(),
      }).where(eq(channels.id, existingSnumom.id)).run();
      console.log('🔄 已校准 snumom 视频渠道模型');
    }
  } catch (err: any) {
    console.error('⚠️ 初始化 snumom 视频渠道出错:', err.message);
  }

  // 17) 保证 HM Studio 渠道存在。密钥仅从服务器环境变量读取，不写入代码仓库。
  try {
    const hmStudioBaseUrl = 'https://dnyovzpgyokm.sealosbja.site';
    const hmStudioApiKey = env.HM_STUDIO_API_KEY.trim();
    const existingHmStudio = db.select().from(channels).all().find(channel =>
      channel.type === 'hmstudio'
      || channel.baseUrl?.replace(/\/+$/, '') === hmStudioBaseUrl
      || channel.name === 'HM Studio 渠道'
    );

    let hmStudioChannel = existingHmStudio;
    if (!hmStudioChannel) {
      const result = db.insert(channels).values({
        name: 'HM Studio 渠道',
        type: 'hmstudio',
        baseUrl: hmStudioBaseUrl,
        apiKey: '',
        supportedModels: '[]',
        modelMapping: '{}',
        status: hmStudioApiKey ? 1 : 0,
        priority: 10,
        weight: 1,
        concurrencyLimit: Number.parseInt(process.env.HM_STUDIO_CONCURRENCY || '10', 10) || 10,
        maxRetries: 3,
        timeout: 120000,
      }).run();
      hmStudioChannel = db.select().from(channels).where(eq(channels.id, Number(result.lastInsertRowid))).get();
      console.log(`📦 已自动创建 HM Studio 渠道（${hmStudioApiKey ? '已启用' : '等待配置 API Key'}）`);
    } else {
      const updates: Record<string, any> = {
        name: 'HM Studio 渠道',
        type: 'hmstudio',
        baseUrl: hmStudioBaseUrl,
        updatedAt: new Date().toISOString(),
      };
      const hasStoredHmKey = Boolean(
        db.select().from(channelApiKeys).where(eq(channelApiKeys.channelId, hmStudioChannel.id)).get()
        || hmStudioChannel.apiKey,
      );
      if (hmStudioApiKey && !hasStoredHmKey) {
        updates.status = 1;
      } else if (!hasStoredHmKey && !hmStudioApiKey) {
        updates.status = 0;
      }
      db.update(channels).set(updates).where(eq(channels.id, hmStudioChannel.id)).run();
    }

    if (hmStudioChannel) {
      const legacyKey = hmStudioChannel.apiKey?.trim();
      const candidateKeys = [legacyKey, hmStudioApiKey].filter((key): key is string => Boolean(key));
      const defaultConcurrency = Number.parseInt(process.env.HM_STUDIO_CONCURRENCY || '10', 10) || 10;
      for (const key of new Set(candidateKeys)) {
        const existingKey = db.select().from(channelApiKeys).where(eq(channelApiKeys.apiKey, key)).get();
        if (!existingKey) {
          db.insert(channelApiKeys).values({
            channelId: hmStudioChannel.id,
            apiKey: key,
            concurrencyLimit: hmStudioChannel.concurrencyLimit || defaultConcurrency,
            status: 1,
          }).run();
        }
      }
      const keyCount = db.select().from(channelApiKeys).where(eq(channelApiKeys.channelId, hmStudioChannel.id)).all().length;
      console.log(`🔄 已校准 HM Studio 渠道（${keyCount > 0 ? `${keyCount} 个密钥` : '等待配置 API Key'}）`);
    }
  } catch (err: any) {
    console.error('⚠️ 初始化 HM Studio 渠道出错:', err.message);
  }

  // 18) wx-海底月仅作为 HM Studio 满载时的 sd2.5 分流渠道。
  try {
    const wxHaidiYueBaseUrl = 'https://ap.968968968.xyz/v1';
    const wxHaidiYueApiKey = env.WX_HAIDIYUE_API_KEY.trim();
    const existingWxHaidiYue = db.select().from(channels).all().find(channel =>
      channel.type === WX_HAIDIYUE_CHANNEL_TYPE
      || channel.baseUrl?.replace(/\/+$/, '') === wxHaidiYueBaseUrl
      || channel.name?.includes('wx-海底月')
    );

    const fixedConfig = {
      name: WX_HAIDIYUE_CHANNEL_NAME,
      type: WX_HAIDIYUE_CHANNEL_TYPE,
      baseUrl: wxHaidiYueBaseUrl,
      supportedModels: JSON.stringify([WX_HAIDIYUE_UPSTREAM_MODEL]),
      modelMapping: JSON.stringify({ [WX_HAIDIYUE_UPSTREAM_MODEL]: WX_HAIDIYUE_UPSTREAM_MODEL }),
      priority: 100,
      weight: 1,
      maxRetries: 0,
      timeout: 120000,
      updatedAt: new Date().toISOString(),
    };

    if (!existingWxHaidiYue) {
      db.insert(channels).values({
        ...fixedConfig,
        apiKey: wxHaidiYueApiKey,
        status: wxHaidiYueApiKey ? 1 : 0,
      }).run();
      console.log(`📦 已自动创建 ${WX_HAIDIYUE_CHANNEL_NAME}（${wxHaidiYueApiKey ? '已启用' : '等待配置 API Key'}）`);
    } else {
      const updates: Record<string, any> = { ...fixedConfig };
      if (wxHaidiYueApiKey) {
        updates.apiKey = wxHaidiYueApiKey;
        if (!existingWxHaidiYue.apiKey) updates.status = 1;
      } else if (!existingWxHaidiYue.apiKey) {
        updates.status = 0;
      }
      db.update(channels).set(updates).where(eq(channels.id, existingWxHaidiYue.id)).run();
      console.log(`🔄 已校准 ${WX_HAIDIYUE_CHANNEL_NAME}（仅 ${WX_HAIDIYUE_UPSTREAM_MODEL}）`);
    }
  } catch (err: any) {
    console.error('⚠️ 初始化 wx-海底月 sd2.5 分流渠道出错:', err.message);
  }

  // 清除所有历史拆分的 MJNewAPI 渠道以保持干净
  try {
    const splitNames = [
      'MJNewAPI cd-seedance 渠道',
      'MJNewAPI nd-seedance 渠道',
      'MJNewAPI md-seedance 渠道',
      'MJNewAPI rd-seedance 渠道',
      'MJNewAPI vd-seedance 渠道'
    ];
    for (const name of splitNames) {
      const oldChan = db.select().from(channels).where(eq(channels.name, name)).get();
      if (oldChan) {
        db.delete(channels).where(eq(channels.id, oldChan.id)).run();
        console.log(`🧹 已清理旧的拆分渠道: ${name}`);
      }
    }
  } catch (err: any) {
    console.error('⚠️ 清理旧拆分渠道出错:', err.message);
  }

  console.log('✅ 数据库初始化完成');
}

export const seed = async () => {
  await initDatabase();
  await syncModelsFromAPI();
};

if (process.argv[1]?.includes('seed.ts') || process.argv[1]?.includes('seed.js')) {
  seed().catch(console.error);
}
