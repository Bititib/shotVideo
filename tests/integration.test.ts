/**
 * 认证系统 + API 路由集成测试
 * 测试：注册、登录、JWT验证、权限控制、配额、管理员功能
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initDatabase } from '../server/db/seed.js';
import { db, sqlite } from '../server/db/index.js';
import { users, tiers, models, tierModelAccess, usageLogs, channels, modelPricing } from '../server/db/schema.js';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../server/config/env.js';
import { getAccessibleModelIds } from '../server/routes/v1.js';

beforeAll(async () => {
  // 确保数据库已初始化
  await initDatabase();
});

// ============ 数据库/Schema 测试 ============
describe('数据库 Schema', () => {
  it('应该有完整的5张核心表', () => {
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as any[];
    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain('tiers');
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('models');
    expect(tableNames).toContain('tier_model_access');
    expect(tableNames).toContain('usage_logs');
  });

  it('应该有正确的索引', () => {
    const indexes = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as any[];
    const names = indexes.map((i: any) => i.name);
    expect(names).toContain('idx_usage_logs_user_date');
    expect(names).toContain('idx_users_email');
  });
});

// ============ 种子数据测试 ============
describe('种子数据完整性', () => {
  it('应该有4个等级（free/basic/pro/enterprise）', () => {
    const allTiers = db.select().from(tiers).all();
    expect(allTiers.length).toBe(4);
    const names = allTiers.map(t => t.name);
    expect(names).toContain('free');
    expect(names).toContain('basic');
    expect(names).toContain('pro');
    expect(names).toContain('enterprise');
  });

  it('免费等级配额应该是3次/天', () => {
    const free = db.select().from(tiers).where(eq(tiers.name, 'free')).get();
    expect(free).toBeDefined();
    expect(free!.dailyQuota).toBe(3);
    const features = JSON.parse(free!.allowedFeatures);
    expect(features).toContain('general');
    expect(features).toContain('image');
  });

  it('企业等级应该不限配额 & 拥有全部功能', () => {
    const ent = db.select().from(tiers).where(eq(tiers.name, 'enterprise')).get();
    expect(ent!.dailyQuota).toBe(-1);
    const features = JSON.parse(ent!.allowedFeatures);
    expect(features).toContain('*');
  });

  it('应该有2个默认模型', () => {
    const allModels = db.select().from(models).all();
    expect(allModels.length).toBeGreaterThanOrEqual(2);
    const ids = allModels.map(m => m.modelId);
    expect(ids).toContain('gemini-2.5-flash');
    expect(ids).toContain('gemini-2.5-flash-image');
  });

  it('模型默认不应有独立 API Key (使用全局 fallback)', () => {
    const allModels = db.select().from(models).all();
    for (const m of allModels) {
      expect(m.apiKey).toBeNull();
    }
  });

  it('启动时应该自动创建 HM Studio 渠道占位记录', () => {
    const channel = db.select().from(channels).where(eq(channels.type, 'hmstudio')).get();
    expect(channel).toBeDefined();
    expect(channel!.baseUrl).toBe('https://dnyovzpgyokm.sealosbja.site');
    expect(channel!.status).toBe(0);
  });

  it('snumom 渠道只绑定两个 WAN3.0 视频模型并配置分辨率计费', () => {
    const channel = db.select().from(channels).where(eq(channels.type, 'snumom')).get();
    expect(channel).toBeDefined();
    expect(channel!.baseUrl).toBe('https://snumom.com');
    expect(JSON.parse(channel!.supportedModels)).toEqual(['wan3.0-video', 'wan3.0-video-prime']);
    expect(JSON.parse(channel!.modelMapping)).toEqual({
      'wan3.0-video': 'wan3.0-video',
      'wan3.0-video-prime': 'wan3.0-video-prime',
    });

    const standard = db.select().from(modelPricing).where(eq(modelPricing.modelPattern, 'wan3.0-video')).get();
    const prime = db.select().from(modelPricing).where(eq(modelPricing.modelPattern, 'wan3.0-video-prime')).get();
    expect(standard?.billingType).toBe('per_second');
    expect(JSON.parse(standard!.extraParams)).toMatchObject({ '480p': 0.12, '720p': 0.14, '1080p': 0.16 });
    expect(JSON.parse(prime!.extraParams)).toMatchObject({ '480p': 0.15, '720p': 0.18, '1080p': 0.20 });
  });

  it('内部备用模型不应暴露给 API 调用方', () => {
    const internalModel = db.select().from(models).where(eq(models.modelId, 'xd-seedance-2.5-720p')).get();
    expect(internalModel?.isActive).toBe(0);
    expect(getAccessibleModelIds({ allowedModels: [] })).not.toContain('xd-seedance-2.5-720p');
  });

  it('NewToken 模型来源应该与实际路由渠道一致', () => {
    const channel = db.select().from(channels).all()
      .find(item => item.name === 'NewToken 渠道' || item.baseUrl.includes('newtoken.club'));
    expect(channel).toBeDefined();

    const supportedModels = JSON.parse(channel!.supportedModels) as string[];
    const expectedModels = [
      'veo-omni-flash',
      'veo-omni-flash-video-edit',
      'veo-3-1',
      'nd-seedance-2.0-480p',
      'nd-seedance-2.0-720p',
    ];
    expect(supportedModels).toEqual(expect.arrayContaining(expectedModels));

    for (const modelId of expectedModels) {
      const model = db.select().from(models).where(eq(models.modelId, modelId)).get();
      expect(model?.provider).toBe('newtoken');
    }

    const editPricing = sqlite.prepare("SELECT billing_type, input_price FROM model_pricing WHERE model_pattern = ?")
      .get('veo-omni-flash-video-edit') as any;
    expect(editPricing?.billing_type).toBe('per_second');
    expect(editPricing?.input_price).toBeCloseTo(0.09, 4);
  });

  it('应该有等级-模型关联数据', () => {
    const access = db.select().from(tierModelAccess).all();
    expect(access.length).toBeGreaterThan(0);
  });

  it('应该自动创建管理员账号', () => {
    const admin = db.select().from(users).where(eq(users.role, 'super_admin')).get();
    expect(admin).toBeDefined();
    expect(admin!.email).toBe(env.ADMIN_EMAIL);
  });
});

// ============ 认证服务测试 ============
describe('认证逻辑', () => {
  it('密码应该被正确 hash (bcrypt)', () => {
    const admin = db.select().from(users).where(eq(users.role, 'super_admin')).get();
    expect(admin!.passwordHash).not.toBe(env.ADMIN_PASSWORD);
    expect(bcrypt.compareSync(env.ADMIN_PASSWORD, admin!.passwordHash)).toBe(true);
  });

  it('JWT token 应该包含 userId 和 role', () => {
    const admin = db.select().from(users).where(eq(users.role, 'super_admin')).get();
    const token = jwt.sign({ userId: admin!.id, role: admin!.role }, env.JWT_SECRET);
    const decoded = jwt.verify(token, env.JWT_SECRET) as any;
    expect(decoded.userId).toBe(admin!.id);
    expect(decoded.role).toBe(admin!.role);
  });

  it('JWT 使用错误 secret 应该验证失败', () => {
    const token = jwt.sign({ userId: 1, role: 'user' }, env.JWT_SECRET);
    expect(() => jwt.verify(token, 'wrong-secret')).toThrow();
  });

  it('注册新用户应该自动分配免费等级', () => {
    const freeTier = db.select().from(tiers).where(eq(tiers.name, 'free')).get();
    const hash = bcrypt.hashSync('testpass123', 12);
    
    // 清理可能存在的测试用户
    sqlite.prepare("DELETE FROM users WHERE email = 'unit_test@test.com'").run();
    
    db.insert(users).values({
      email: 'unit_test@test.com',
      username: 'unit_tester',
      passwordHash: hash,
      role: 'user',
      tierId: freeTier!.id,
    }).run();

    const created = db.select().from(users).where(eq(users.email, 'unit_test@test.com')).get();
    expect(created).toBeDefined();
    expect(created!.tierId).toBe(freeTier!.id);
    expect(created!.role).toBe('user');
    expect(created!.isActive).toBe(1);
    
    // 清理
    sqlite.prepare("DELETE FROM users WHERE email = 'unit_test@test.com'").run();
  });

  it('同一邮箱不能重复注册', () => {
    const admin = db.select().from(users).where(eq(users.role, 'super_admin')).get();
    const existing = db.select().from(users).where(eq(users.email, admin!.email)).all();
    expect(existing.length).toBe(1);
  });
});

// ============ 等级权限测试 ============
describe('等级权限逻辑', () => {
  it('免费用户不应有高级专属权限', () => {
    const free = db.select().from(tiers).where(eq(tiers.name, 'free')).get();
    const features: string[] = JSON.parse(free!.allowedFeatures);
    // 免费用户不应有 AI 生图和换品等高级功能
    expect(features).not.toContain('generate_image');
    expect(features).not.toContain('modify_prompt');
    // 免费用户不应有通配符
    expect(features).not.toContain('*');
  });

  it('专业会员应该有 generate_image 和 modify_prompt 权限', () => {
    const pro = db.select().from(tiers).where(eq(tiers.name, 'pro')).get();
    const features: string[] = JSON.parse(pro!.allowedFeatures);
    expect(features).toContain('generate_image');
    expect(features).toContain('modify_prompt');
  });

  it('基础会员应该有5种基础分析权限', () => {
    const basic = db.select().from(tiers).where(eq(tiers.name, 'basic')).get();
    const features: string[] = JSON.parse(basic!.allowedFeatures);
    expect(features).toContain('general');
    expect(features).toContain('ecommerce');
    expect(features).toContain('image');
    expect(features).toContain('copywriting');
    expect(features).toContain('account');
  });

  it('企业会员通配符 * 应该包含所有功能', () => {
    const ent = db.select().from(tiers).where(eq(tiers.name, 'enterprise')).get();
    const features: string[] = JSON.parse(ent!.allowedFeatures);
    const allFeatures = ['general', 'ecommerce', 'image', 'copywriting', 'account', 'generate_image', 'modify_prompt'];
    // 通配符策略
    expect(features.includes('*') || allFeatures.every(f => features.includes(f))).toBe(true);
  });

  it('等级-模型关联：免费用户只能用 Flash 模型', () => {
    const free = db.select().from(tiers).where(eq(tiers.name, 'free')).get();
    const access = db.select().from(tierModelAccess).where(eq(tierModelAccess.tierId, free!.id)).all();
    const modelList = db.select().from(models).all();
    const freeModelIds = access.map(a => a.modelId);
    const freeModels = modelList.filter(m => freeModelIds.includes(m.id));
    
    // 只有 flash，没有 image
    expect(freeModels.some(m => m.modelId === 'gemini-2.5-flash')).toBe(true);
    expect(freeModels.some(m => m.modelId.includes('image'))).toBe(false);
  });

  it('专业/企业会员应该同时拥有 Flash + Image 模型', () => {
    const pro = db.select().from(tiers).where(eq(tiers.name, 'pro')).get();
    const access = db.select().from(tierModelAccess).where(eq(tierModelAccess.tierId, pro!.id)).all();
    const modelList = db.select().from(models).all();
    const proModelIds = access.map(a => a.modelId);
    const proModels = modelList.filter(m => proModelIds.includes(m.id));
    
    expect(proModels.some(m => m.modelId === 'gemini-2.5-flash')).toBe(true);
    expect(proModels.some(m => m.modelId.includes('image'))).toBe(true);
  });
});

// ============ 配额逻辑测试 ============
describe('配额系统', () => {
  it('应该能正确记录使用日志', () => {
    const admin = db.select().from(users).where(eq(users.role, 'super_admin')).get();

    db.insert(usageLogs).values({
      userId: admin!.id,
      analysisType: 'test_type',
      durationMs: 1234,
    }).run();

    const logs = db.select().from(usageLogs).where(eq(usageLogs.userId, admin!.id)).all();
    expect(logs.length).toBeGreaterThan(0);
    const last = logs[logs.length - 1];
    expect(last.analysisType).toBe('test_type');
    expect(last.durationMs).toBe(1234);
    
    // 清理
    sqlite.prepare("DELETE FROM usage_logs WHERE analysis_type = 'test_type'").run();
  });

  it('企业会员 dailyQuota=-1 应该不受限', () => {
    const ent = db.select().from(tiers).where(eq(tiers.name, 'enterprise')).get();
    expect(ent!.dailyQuota).toBe(-1);
  });

  it('用户 quotaOverride 应该覆盖等级默认配额', () => {
    const admin = db.select().from(users).where(eq(users.role, 'super_admin')).get();
    // quotaOverride 为 null 时使用等级默认
    expect(admin!.quotaOverride).toBeNull();

    // 设置覆盖
    db.update(users).set({ quotaOverride: 999 }).where(eq(users.id, admin!.id)).run();
    const updated = db.select().from(users).where(eq(users.id, admin!.id)).get();
    expect(updated!.quotaOverride).toBe(999);

    // 还原
    db.update(users).set({ quotaOverride: null }).where(eq(users.id, admin!.id)).run();
  });
});

// ============ 管理员功能测试 ============
describe('管理员功能', () => {
  it('管理员 role 应该是 super_admin', () => {
    const admin = db.select().from(users).where(eq(users.role, 'super_admin')).get();
    expect(admin!.role).toBe('super_admin');
  });

  it('应该能修改用户等级', () => {
    const admin = db.select().from(users).where(eq(users.role, 'super_admin')).get();
    const pro = db.select().from(tiers).where(eq(tiers.name, 'pro')).get();
    const originalTier = admin!.tierId;

    db.update(users).set({ tierId: pro!.id }).where(eq(users.id, admin!.id)).run();
    const updated = db.select().from(users).where(eq(users.id, admin!.id)).get();
    expect(updated!.tierId).toBe(pro!.id);

    // 还原
    db.update(users).set({ tierId: originalTier }).where(eq(users.id, admin!.id)).run();
  });

  it('应该能禁用/启用用户', () => {
    const admin = db.select().from(users).where(eq(users.role, 'super_admin')).get();

    db.update(users).set({ isActive: 0 }).where(eq(users.id, admin!.id)).run();
    let u = db.select().from(users).where(eq(users.id, admin!.id)).get();
    expect(u!.isActive).toBe(0);

    db.update(users).set({ isActive: 1 }).where(eq(users.id, admin!.id)).run();
    u = db.select().from(users).where(eq(users.id, admin!.id)).get();
    expect(u!.isActive).toBe(1);
  });

  it('应该能 CRUD 等级', () => {
    // Create
    db.insert(tiers).values({
      name: 'test_tier',
      displayName: '测试等级',
      dailyQuota: 5,
      allowedFeatures: JSON.stringify(['general']),
      sortOrder: 99,
    }).run();
    const created = db.select().from(tiers).where(eq(tiers.name, 'test_tier')).get();
    expect(created).toBeDefined();
    expect(created!.displayName).toBe('测试等级');

    // Update
    db.update(tiers).set({ dailyQuota: 10 }).where(eq(tiers.id, created!.id)).run();
    const updated = db.select().from(tiers).where(eq(tiers.id, created!.id)).get();
    expect(updated!.dailyQuota).toBe(10);

    // Delete
    sqlite.prepare('DELETE FROM tiers WHERE name = ?').run('test_tier');
    const deleted = db.select().from(tiers).where(eq(tiers.name, 'test_tier')).get();
    expect(deleted).toBeUndefined();
  });

  it('应该能 CRUD 模型', () => {
    db.insert(models).values({
      provider: 'openai',
      modelId: 'gpt-test',
      displayName: 'GPT Test',
      capabilities: JSON.stringify(['text']),
    }).run();
    const created = db.select().from(models).where(eq(models.modelId, 'gpt-test')).get();
    expect(created).toBeDefined();
    expect(created!.provider).toBe('openai');

    db.update(models).set({ isActive: 0 }).where(eq(models.id, created!.id)).run();
    const updated = db.select().from(models).where(eq(models.id, created!.id)).get();
    expect(updated!.isActive).toBe(0);

    sqlite.prepare('DELETE FROM models WHERE model_id = ?').run('gpt-test');
  });
});

// ============ Prompt 模板测试 ============
describe('Prompt 模板', () => {
  it('通用分析 prompt 应该是函数且返回字符串', async () => {
    const { generalPrompt } = await import('../server/prompts/general.js');
    const result = generalPrompt('测试标题');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(50);
  });

  it('带货分析 prompt 应该正确处理有/无标题', async () => {
    const { ecommercePrompt } = await import('../server/prompts/ecommerce.js');
    const withTitle = ecommercePrompt('带货视频');
    expect(withTitle).toContain('带货视频');
    const withoutTitle = ecommercePrompt();
    expect(typeof withoutTitle).toBe('string');
    expect(withoutTitle.length).toBeGreaterThan(50);
  });

  it('图片分析 prompt 应该根据 requiresText 变化', async () => {
    const { imagePrompt } = await import('../server/prompts/image.js');
    const withText = imagePrompt(true);
    const withoutText = imagePrompt(false);
    expect(withText).not.toBe(withoutText);
  });

  it('电商文案 prompt 应该存在', async () => {
    const { copywritingPrompt } = await import('../server/prompts/copywriting.js');
    const result = copywritingPrompt();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(50);
  });

  it('账号分析 prompt 应该正确注入参数', async () => {
    const { accountPrompt } = await import('../server/prompts/account.js');
    const result = accountPrompt('@testuser', '这是一个测试账号');
    expect(result).toContain('@testuser');
    expect(result).toContain('测试账号');
  });

  it('换品 prompt 应该注入现有提示词', async () => {
    const { modifyPromptTemplate } = await import('../server/prompts/ecommerce.js');
    const result = modifyPromptTemplate('existing prompt here');
    expect(result).toContain('existing prompt here');
  });

  it('所有 schema 应该定义了 responseSchema 格式', async () => {
    const { generalSchema } = await import('../server/prompts/general.js');
    const { ecommerceSchema } = await import('../server/prompts/ecommerce.js');
    const { imageSchema } = await import('../server/prompts/image.js');
    const { copywritingSchema } = await import('../server/prompts/copywriting.js');
    const { accountSchema } = await import('../server/prompts/account.js');
    
    expect(generalSchema).toBeDefined();
    expect(ecommerceSchema).toBeDefined();
    expect(imageSchema).toBeDefined();
    expect(copywritingSchema).toBeDefined();
    expect(accountSchema).toBeDefined();
  });
});

// ============ 环境变量测试 ============
describe('环境配置', () => {
  it('应该有 JWT_SECRET', () => {
    expect(env.JWT_SECRET).toBeDefined();
    expect(env.JWT_SECRET.length).toBeGreaterThan(0);
  });

  it('应该有 GEMINI_API_KEY', () => {
    expect(env.GEMINI_API_KEY).toBeDefined();
  });

  it('应该有 ADMIN_EMAIL 和 ADMIN_PASSWORD', () => {
    expect(env.ADMIN_EMAIL).toBeDefined();
    expect(env.ADMIN_PASSWORD).toBeDefined();
  });
});

// ============ AI Service 配置测试 ============
describe('AI Service 模型配置', () => {
  it('模型级 Key 优先于全局 Key (null = 使用全局)', () => {
    const flash = db.select().from(models).where(eq(models.modelId, 'gemini-2.5-flash')).get();
    // apiKey 为 null 时应 fallback 到 env.GEMINI_API_KEY
    const effectiveKey = flash!.apiKey || env.GEMINI_API_KEY;
    expect(effectiveKey).toBe(env.GEMINI_API_KEY);
  });

  it('设置模型级 Key 后不使用全局 Key', () => {
    db.update(models).set({ apiKey: 'model-specific-key' }).where(eq(models.modelId, 'gemini-2.5-flash')).run();
    const flash = db.select().from(models).where(eq(models.modelId, 'gemini-2.5-flash')).get();
    const effectiveKey = flash!.apiKey || env.GEMINI_API_KEY;
    expect(effectiveKey).toBe('model-specific-key');
    
    // 还原
    db.update(models).set({ apiKey: null }).where(eq(models.modelId, 'gemini-2.5-flash')).run();
  });
});
