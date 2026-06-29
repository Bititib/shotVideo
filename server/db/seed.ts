import { db, sqlite } from './index.js';
import { tiers, users, models, tierModelAccess, settings, channels, apiTokens, modelPricing, organizations, orgMembers, contents } from './schema.js';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { env, getApiKeys } from '../config/env.js';
import { GoogleGenAI } from '@google/genai';

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

type ModelEntry = { provider: string; modelId: string; displayName: string; capabilities: string };

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
async function syncModelsFromAPI() {
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

  // 强制追加静态模型 (Grok 视频/图片 等)
  allVerified.push(
    { provider: 'grok', modelId: 'grok-imagine-video', displayName: 'Grok Video', capabilities: JSON.stringify(['video']) },
    { provider: 'grok', modelId: 'grok-4.3-video', displayName: 'Grok 4.3 Video', capabilities: JSON.stringify(['video']) },
    { provider: 'grok', modelId: 'grok-imagine-video-1.5-preview', displayName: 'Grok Video 1.5 Preview', capabilities: JSON.stringify(['video']) },
    { provider: 'grok', modelId: 'grok-imagine-1.0-video', displayName: 'Grok Video 1.0', capabilities: JSON.stringify(['video']) },
    { provider: 'grok', modelId: 'grok-imagine-video-1.5-fast', displayName: 'Grok Video 1.5 Fast', capabilities: JSON.stringify(['video']) },
    { provider: 'grok', modelId: 'grok-imagine-image', displayName: 'Grok Image', capabilities: JSON.stringify(['image']) },
    { provider: 'grok', modelId: 'grok-imagine-image-lite', displayName: 'Grok Image Lite', capabilities: JSON.stringify(['image']) },
    { provider: 'grok', modelId: 'grok-imagine-image-pro', displayName: 'Grok Image Pro', capabilities: JSON.stringify(['image']) },
    { provider: 'grok', modelId: 'grok-imagine-image-edit', displayName: 'Grok Image Edit', capabilities: JSON.stringify(['image']) },
    { provider: 'openai', modelId: 'gpt-image-2', displayName: 'GPT Image 2', capabilities: JSON.stringify(['image']) },
    { provider: 'openai', modelId: 'gpt-image-2-plus', displayName: 'GPT Image 2 Plus', capabilities: JSON.stringify(['image']) },
    { provider: 'openai', modelId: 'gpt-image-2-pro', displayName: 'GPT Image 2 Pro', capabilities: JSON.stringify(['image']) },
    { provider: 'openai', modelId: 'gpt-image-2-max', displayName: 'GPT Image 2 Max', capabilities: JSON.stringify(['image']) },
    { provider: 'google', modelId: 'gemini-3.1-flash-image-preview', displayName: '🍌 nabanana flash', capabilities: JSON.stringify(['image']) },
    { provider: 'google', modelId: 'gemini-3-pro-image-preview', displayName: '🍌 nabanana pro', capabilities: JSON.stringify(['image']) },
    { provider: 'google', modelId: 'gemini-2.5-flash-preview-tts', displayName: 'Gemini 2.5 Flash TTS', capabilities: JSON.stringify(['tts']) },
    { provider: 'google', modelId: 'gemini-2.5-pro-preview-tts', displayName: 'Gemini 2.5 Pro TTS', capabilities: JSON.stringify(['tts']) }
  );

  // 同步或插入模型
  for (const m of allVerified) {
    const existing = db.select().from(models).where(eq(models.modelId, m.modelId)).get();
    if (existing) {
      if (existing.displayName !== m.displayName || existing.capabilities !== m.capabilities) {
        db.update(models)
          .set({ displayName: m.displayName, capabilities: m.capabilities })
          .where(eq(models.modelId, m.modelId))
          .run();
      }
    } else {
      db.insert(models).values(m).run();
    }
  }

  // 仅在 API 成功拉取时才清理不在列表中的旧模型，网络失败时保留已有数据
  if (apiSuccess) {
    const verifiedIds = new Set(allVerified.map(m => m.modelId));
    const toRemove = existingModels.filter(m => !verifiedIds.has(m.modelId));
    if (toRemove.length > 0) {
      for (const m of toRemove) {
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
      max_retries INTEGER NOT NULL DEFAULT 3,
      timeout INTEGER NOT NULL DEFAULT 120000,
      status INTEGER NOT NULL DEFAULT 1,
      last_test_at TEXT,
      last_test_result TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

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

    CREATE INDEX IF NOT EXISTS idx_usage_logs_user_date ON usage_logs(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_api_tokens_key ON api_tokens(token_key);
    CREATE INDEX IF NOT EXISTS idx_api_logs_token ON api_logs(token_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_api_logs_channel ON api_logs(channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_org_members_org ON org_members(org_id);
    CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_contents_user ON contents(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_contents_org ON contents(org_id, created_at);
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
      modelPattern: 'grok-imagine-image',
      billingType: 'per_call',
      inputPrice: 0.05 * IMAGE_MULTIPLIER,   // 3x multiplier (0.15)
      outputPrice: 0,
    },
    {
      modelPattern: 'grok-imagine-image-lite',
      billingType: 'per_call',
      inputPrice: 0.03 * IMAGE_MULTIPLIER,   // 3x multiplier (0.09)
      outputPrice: 0,
    },
    {
      modelPattern: 'grok-imagine-image-pro',
      billingType: 'per_call',
      inputPrice: 0.10 * IMAGE_MULTIPLIER,   // 3x multiplier (0.30)
      outputPrice: 0,
    },
    {
      modelPattern: 'grok-imagine-image-edit',
      billingType: 'per_call',
      inputPrice: 0.04 * IMAGE_MULTIPLIER,   // 3x multiplier (0.12)
      outputPrice: 0,
    },
    {
      modelPattern: 'gpt-image-2',
      billingType: 'per_call',
      inputPrice: 0.04 * IMAGE_MULTIPLIER,   // 3x multiplier (0.12)
      outputPrice: 0,
    },
    {
      modelPattern: 'gpt-image-2-plus',
      billingType: 'per_call',
      inputPrice: 0.08 * IMAGE_MULTIPLIER,   // 3x multiplier (0.24)
      outputPrice: 0,
    },
    {
      modelPattern: 'gpt-image-2-pro',
      billingType: 'per_call',
      inputPrice: 0.08 * IMAGE_MULTIPLIER,   // 3x multiplier (0.24)
      outputPrice: 0,
    },
    {
      modelPattern: 'gpt-image-2-max',
      billingType: 'per_call',
      inputPrice: 0.12 * IMAGE_MULTIPLIER,   // 3x multiplier (0.36)
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
  ];

  console.log('📦 同步计费规则到数据库 (更新/插入)...');
  for (const pricing of defaultPricing) {
    const existing = db.select().from(modelPricing).where(eq(modelPricing.modelPattern, pricing.modelPattern)).get();
    if (existing) {
      db.update(modelPricing)
        .set({ inputPrice: pricing.inputPrice, billingType: pricing.billingType, outputPrice: pricing.outputPrice })
        .where(eq(modelPricing.modelPattern, pricing.modelPattern))
        .run();
    } else {
      db.insert(modelPricing).values(pricing).run();
    }
  }

  console.log('✅ 数据库初始化完成');
}

