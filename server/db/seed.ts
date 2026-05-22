import { db, sqlite } from './index.js';
import { tiers, users, models, tierModelAccess, settings, channels, apiTokens, modelPricing } from './schema.js';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { env, getApiKeys } from '../config/env.js';
import { GoogleGenAI } from '@google/genai';

/** 生成 sk-xxxx 格式的 Token */
function generateTokenKey(): string {
  return 'sk-' + crypto.randomBytes(24).toString('hex');
}

/** 不适合做内容分析的模型关键词（排除） */
const EXCLUDED_KEYWORDS = ['embedding', 'tts', 'robotics', 'live', 'audio', 'computer-use', 'customtools'];

/** 排除别名和版本号变体 */
const EXCLUDED_PATTERNS = [
  /^gemini-(flash|pro|flash-lite)-(latest)$/,
  /^gemini-[\d.]+-flash-\d{3}$/,
  /^gemini-[\d.]+-flash-lite-\d{3}$/,
];

/** 验证单个模型是否真正可用（区分限流 vs 真正不支持） */
async function verifyModel(ai: GoogleGenAI, modelId: string, isImage: boolean): Promise<'ok' | 'rate_limited' | 'unsupported'> {
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (isImage) {
        const res = await ai.models.generateContent({
          model: modelId,
          contents: { parts: [{ text: 'A white square' }] },
          config: { responseModalities: ['IMAGE', 'TEXT'] },
        });
        const hasImage = (res.candidates?.[0]?.content?.parts || []).some((p: any) => p.inlineData);
        return hasImage ? 'ok' : 'unsupported';
      } else {
        const res = await ai.models.generateContent({
          model: modelId,
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          config: { maxOutputTokens: 5 },
        });
        return res.text ? 'ok' : 'unsupported';
      }
    } catch (err: any) {
      const msg = err.message || '';
      const is429 = msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED');

      if (is429 && attempt < maxRetries) {
        // 限流 → 等待后重试
        const wait = (attempt + 1) * 5000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      return is429 ? 'rate_limited' : 'unsupported';
    }
  }
  return 'unsupported';
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
  const apiKeys = getApiKeys();

  let allVerified: ModelEntry[] = [];

  if (apiKeys.length === 0) {
    console.warn('⚠️ 未配置 API Key，使用默认模型');
  } else {
    try {
      const ai = new GoogleGenAI({ apiKey: apiKeys[0] });
      const pager = await ai.models.list();

      const candidates: (ModelEntry & { isImage: boolean })[] = [];
      for await (const m of pager) {
        if (!m.name || !m.name.includes('gemini')) continue;
        const modelId = m.name.replace('models/', '');
        if (EXCLUDED_KEYWORDS.some(kw => modelId.includes(kw))) continue;
        if (EXCLUDED_PATTERNS.some(pat => pat.test(modelId))) continue;

        const isImage = modelId.includes('image');
        candidates.push({
          provider: 'google', modelId,
          displayName: m.displayName || modelId,
          capabilities: JSON.stringify(isImage ? ['text', 'image_gen'] : ['text']),
          isImage,
        });
      }

      console.log(`🔍 发现 ${candidates.length} 个候选模型，使用 ${apiKeys.length} 个 Key 并发验证...`);

      // 按 Key 数量分组
      const groups: (typeof candidates)[] = Array.from({ length: apiKeys.length }, () => []);
      candidates.forEach((c, i) => groups[i % apiKeys.length].push(c));

      // 多 Key 并发验证
      const results = await Promise.all(
        groups.map((batch, i) => verifyBatch(apiKeys[i], i, batch, existingModelIds))
      );

      for (const r of results) {
        r.log.forEach(l => console.log(l));
        allVerified.push(...r.verified);
      }

      console.log(`✅ 验证通过 ${allVerified.length}/${candidates.length} 个模型`);
    } catch (err: any) {
      console.warn(`⚠️ 无法获取模型列表: ${err.message}，使用默认模型`);
    }
  }

  // API 不可用时的最小回退集
  if (allVerified.length === 0) {
    allVerified = [
      { provider: 'google', modelId: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', capabilities: JSON.stringify(['text']) },
    ];
  }

  // 强制追加静态模型 (Grok 视频/图片 等)
  allVerified.push(
    { provider: 'grok', modelId: 'grok-imagine-video', displayName: 'Grok Video', capabilities: JSON.stringify(['video']) },
    { provider: 'grok', modelId: 'grok-4.3-video', displayName: 'Grok 4.3 Video', capabilities: JSON.stringify(['video']) },
    { provider: 'grok', modelId: 'grok-imagine-image', displayName: 'Grok Image', capabilities: JSON.stringify(['image']) },
    { provider: 'grok', modelId: 'grok-imagine-image-lite', displayName: 'Grok Image Lite', capabilities: JSON.stringify(['image']) },
    { provider: 'grok', modelId: 'grok-imagine-image-pro', displayName: 'Grok Image Pro', capabilities: JSON.stringify(['image']) },
    { provider: 'grok', modelId: 'grok-imagine-image-edit', displayName: 'Grok Image Edit', capabilities: JSON.stringify(['image']) },
  );

  // 增量插入新模型
  const newModels = allVerified.filter(m => !existingModelIds.has(m.modelId));
  if (newModels.length > 0) {
    console.log(`📦 添加 ${newModels.length} 个新模型: ${newModels.map(m => m.modelId).join(', ')}`);
    db.insert(models).values(newModels).run();
  }

  // 清理数据库中存在但验证不通过的模型（含 google 和 grok）
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

    CREATE INDEX IF NOT EXISTS idx_usage_logs_user_date ON usage_logs(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_api_tokens_key ON api_tokens(token_key);
    CREATE INDEX IF NOT EXISTS idx_api_logs_token ON api_logs(token_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_api_logs_channel ON api_logs(channel_id, created_at);
  `);

  // 增量迁移：为已有 users 表添加 balance 列（新建数据库已包含，此处兼容旧库）
  try {
    sqlite.exec(`ALTER TABLE users ADD COLUMN balance REAL NOT NULL DEFAULT 0`);
    console.log('🔄 已迁移：users 表添加 balance 列');
  } catch {
    // 列已存在则忽略
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
        allowedFeatures: JSON.stringify(['general', 'ecommerce', 'image', 'copywriting', 'account']),
        sortOrder: 1,
      },
      {
        name: 'pro',
        displayName: '专业会员',
        dailyQuota: 100,
        allowedFeatures: JSON.stringify(['general', 'ecommerce', 'image', 'copywriting', 'account', 'generate_image', 'modify_prompt']),
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

  // 5) 种子数据 - 管理员账号
  const existingAdmin = db.select().from(users).where(eq(users.role, 'admin')).all();
  if (existingAdmin.length === 0) {
    console.log('📦 创建默认管理员账号...');
    const enterpriseTier = db.select().from(tiers).where(eq(tiers.name, 'enterprise')).get();
    const hash = bcrypt.hashSync(env.ADMIN_PASSWORD, 12);
    db.insert(users).values({
      email: env.ADMIN_EMAIL,
      username: '管理员',
      passwordHash: hash,
      role: 'admin',
      tierId: enterpriseTier?.id || 4,
    }).run();
    console.log(`✅ 管理员账号: ${env.ADMIN_EMAIL}`);
  } else {
    // 已有管理员 → 同步 .env 中的密码（防止改了 .env 但旧哈希还在数据库）
    const admin = existingAdmin[0];
    const passwordChanged = !bcrypt.compareSync(env.ADMIN_PASSWORD, admin.passwordHash);
    if (passwordChanged) {
      const newHash = bcrypt.hashSync(env.ADMIN_PASSWORD, 12);
      db.update(users).set({ passwordHash: newHash }).where(eq(users.id, admin.id)).run();
      console.log('🔄 管理员密码已同步更新');
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
  const existingPricing = db.select().from(modelPricing).all();
  if (existingPricing.length === 0) {
    console.log('📦 初始化默认计费规则...');
    db.insert(modelPricing).values([
      {
        modelPattern: '*',
        billingType: 'per_token',
        inputPrice: 0.01,   // ¥0.01 / 1M tokens
        outputPrice: 0.03,  // ¥0.03 / 1M tokens
      },
      {
        modelPattern: 'grok-imagine-video',
        billingType: 'per_call',
        inputPrice: 0.1,    // ¥0.1 / 次
        outputPrice: 0,
        extraParams: JSON.stringify({ '20s': 0.2 }),
      },
      {
        modelPattern: 'grok-imagine-image',
        billingType: 'per_call',
        inputPrice: 0.05,   // ¥0.05 / 次
        outputPrice: 0,
      },
    ]).run();
  }

  console.log('✅ 数据库初始化完成');
}

