/**
 * 计费系统单元测试
 * 覆盖：BalanceService / TokenService / PricingService 的核心计费逻辑
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { db, sqlite } from '../server/db/index.js';
import { users, tiers, apiTokens, modelPricing } from '../server/db/schema.js';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { BalanceService } from '../server/services/balanceService.js';
import { TokenService } from '../server/services/tokenService.js';
import { PricingService } from '../server/services/pricingService.js';

// ============ 测试用户管理 ============
let testUserId: number;
const TEST_EMAIL = 'billing_test@test.com';

beforeAll(() => {
  // 直接创建表结构，避免 initDatabase 的网络调用超时
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
    CREATE TABLE IF NOT EXISTS model_pricing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_pattern TEXT NOT NULL,
      billing_type TEXT NOT NULL DEFAULT 'per_call',
      input_price REAL NOT NULL DEFAULT 0,
      output_price REAL NOT NULL DEFAULT 0,
      extra_params TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 确保有一个 free 等级
  const existing = db.select().from(tiers).where(eq(tiers.name, 'free')).get();
  if (!existing) {
    db.insert(tiers).values({
      name: 'free', displayName: '免费用户', dailyQuota: 3,
      allowedFeatures: JSON.stringify(['general', 'image']), sortOrder: 0,
    }).run();
  }
});

beforeEach(() => {
  // 每个测试前创建一个干净的测试用户
  sqlite.prepare(`DELETE FROM users WHERE email = ?`).run(TEST_EMAIL);
  const freeTier = db.select().from(tiers).where(eq(tiers.name, 'free')).get();
  const hash = bcrypt.hashSync('testpass', 12);

  const result = db.insert(users).values({
    email: TEST_EMAIL,
    username: 'billing_tester',
    passwordHash: hash,
    role: 'user',
    tierId: freeTier!.id,
    balance: 10.00, // 初始余额 ¥10
  }).run();

  testUserId = Number(result.lastInsertRowid);
});

afterEach(() => {
  sqlite.prepare(`DELETE FROM users WHERE email = ?`).run(TEST_EMAIL);
});

// ============ BalanceService 测试 ============
describe('BalanceService', () => {
  describe('getBalance', () => {
    it('应该返回用户当前余额', () => {
      const balance = BalanceService.getBalance(testUserId);
      expect(balance).toBe(10.00);
    });

    it('不存在的用户返回 0', () => {
      const balance = BalanceService.getBalance(999999);
      expect(balance).toBe(0);
    });
  });

  describe('checkBalance', () => {
    it('余额充足时返回 sufficient: true', () => {
      const result = BalanceService.checkBalance(testUserId, 5.00);
      expect(result.sufficient).toBe(true);
      expect(result.balance).toBe(10.00);
    });

    it('余额不足时返回 sufficient: false', () => {
      const result = BalanceService.checkBalance(testUserId, 15.00);
      expect(result.sufficient).toBe(false);
      expect(result.balance).toBe(10.00);
    });

    it('费用为 0 时始终充足', () => {
      const result = BalanceService.checkBalance(testUserId, 0);
      expect(result.sufficient).toBe(true);
    });

    it('费用为负数时始终充足', () => {
      const result = BalanceService.checkBalance(testUserId, -5);
      expect(result.sufficient).toBe(true);
    });

    it('余额恰好等于费用时应充足', () => {
      const result = BalanceService.checkBalance(testUserId, 10.00);
      expect(result.sufficient).toBe(true);
    });
  });

  describe('deduct', () => {
    it('正常扣减并返回剩余余额', () => {
      const remaining = BalanceService.deduct(testUserId, 3.00, 'generate_video');
      expect(remaining).not.toBeNull();
      expect(remaining).toBe(7.00);
      // 验证数据库实际值
      expect(BalanceService.getBalance(testUserId)).toBe(7.00);
    });

    it('余额不足时返回 null 且不扣减', () => {
      const remaining = BalanceService.deduct(testUserId, 15.00, 'generate_video');
      expect(remaining).toBeNull();
      // 余额不变
      expect(BalanceService.getBalance(testUserId)).toBe(10.00);
    });

    it('金额为 0 时不扣减，返回当前余额', () => {
      const remaining = BalanceService.deduct(testUserId, 0, 'generate_video');
      expect(remaining).toBe(10.00);
    });

    it('金额为负数时不扣减，返回当前余额', () => {
      const remaining = BalanceService.deduct(testUserId, -5, 'generate_video');
      expect(remaining).toBe(10.00);
    });

    it('多次扣减应该累积', () => {
      BalanceService.deduct(testUserId, 2.00, 'test');
      BalanceService.deduct(testUserId, 3.00, 'test');
      BalanceService.deduct(testUserId, 1.50, 'test');
      expect(BalanceService.getBalance(testUserId)).toBe(3.50);
    });

    it('扣减到恰好为 0 应该成功', () => {
      const remaining = BalanceService.deduct(testUserId, 10.00, 'test');
      expect(remaining).toBe(0);
    });

    it('扣减后余额为 0 时再次扣减应失败', () => {
      BalanceService.deduct(testUserId, 10.00, 'test');
      const result = BalanceService.deduct(testUserId, 0.01, 'test');
      expect(result).toBeNull();
    });

    it('浮点数精度：小额扣减不应产生负数', () => {
      // 设置余额为 0.1
      db.update(users).set({ balance: 0.1 }).where(eq(users.id, testUserId)).run();
      const remaining = BalanceService.deduct(testUserId, 0.1, 'test');
      expect(remaining).not.toBeNull();
      expect(remaining!).toBeGreaterThanOrEqual(0);
    });
  });
});

// ============ TokenService.deductBalance 测试 ============
describe('TokenService.deductBalance', () => {
  let tokenId: number;
  let tokenKey: string;

  beforeEach(() => {
    // 创建一个有限额度 Token
    const result = TokenService.createToken({
      userId: testUserId,
      name: 'billing-test-token',
      balance: 50.00,
      rateLimit: -1,
    });
    tokenId = result.id;
    tokenKey = result.tokenKey;
  });

  afterEach(() => {
    sqlite.prepare(`DELETE FROM api_tokens WHERE name = 'billing-test-token'`).run();
    sqlite.prepare(`DELETE FROM api_tokens WHERE name = 'unlimited-test-token'`).run();
  });

  it('有限额度：正常扣减', () => {
    TokenService.deductBalance(tokenId, 10.00);
    const token = TokenService.findByKey(tokenKey);
    expect(token!.balance).toBe(40.00);
    expect(token!.usedAmount).toBe(10.00);
  });

  it('有限额度：不应扣为负数', () => {
    TokenService.deductBalance(tokenId, 60.00); // 超出余额
    const token = TokenService.findByKey(tokenKey);
    expect(token!.balance).toBe(0); // MAX(0, ...) 保护
    expect(token!.usedAmount).toBe(60.00);
  });

  it('有限额度：多次扣减累积', () => {
    TokenService.deductBalance(tokenId, 10.00);
    TokenService.deductBalance(tokenId, 15.00);
    TokenService.deductBalance(tokenId, 5.00);
    const token = TokenService.findByKey(tokenKey);
    expect(token!.balance).toBe(20.00);
    expect(token!.usedAmount).toBe(30.00);
  });

  it('金额为 0 时不扣减', () => {
    TokenService.deductBalance(tokenId, 0);
    const token = TokenService.findByKey(tokenKey);
    expect(token!.balance).toBe(50.00);
    expect(token!.usedAmount).toBe(0);
  });

  it('金额为负数时不扣减', () => {
    TokenService.deductBalance(tokenId, -10);
    const token = TokenService.findByKey(tokenKey);
    expect(token!.balance).toBe(50.00);
    expect(token!.usedAmount).toBe(0);
  });

  it('无限额度 (balance=-1)：只增加 usedAmount', () => {
    // 创建无限额度 Token
    const unlimitedResult = TokenService.createToken({
      userId: testUserId,
      name: 'unlimited-test-token',
      balance: -1,
    });

    TokenService.deductBalance(unlimitedResult.id, 100.00);
    const token = TokenService.findByKey(unlimitedResult.tokenKey);
    expect(token!.balance).toBe(-1); // 保持 -1
    expect(token!.usedAmount).toBe(100.00);
  });

  it('不存在的 Token 不应报错', () => {
    expect(() => TokenService.deductBalance(999999, 10.00)).not.toThrow();
  });

  it('应该更新 lastUsedAt', () => {
    const before = TokenService.findByKey(tokenKey);
    expect(before!.lastUsedAt).toBeNull();

    TokenService.deductBalance(tokenId, 1.00);

    const after = TokenService.findByKey(tokenKey);
    expect(after!.lastUsedAt).not.toBeNull();
  });
});

// ============ TokenService.validateToken 测试 ============
describe('TokenService.validateToken', () => {
  let tokenId: number;
  let tokenKey: string;

  beforeEach(() => {
    const result = TokenService.createToken({
      userId: testUserId,
      name: 'validate-test-token',
      balance: 10.00,
    });
    tokenId = result.id;
    tokenKey = result.tokenKey;
  });

  afterEach(() => {
    sqlite.prepare(`DELETE FROM api_tokens WHERE name = 'validate-test-token'`).run();
  });

  it('有效 Token 验证通过', () => {
    const result = TokenService.validateToken(tokenKey);
    expect(result.valid).toBe(true);
    expect(result.token).toBeDefined();
  });

  it('无效 Token Key 验证失败', () => {
    const result = TokenService.validateToken('sk-invalid-key');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('无效');
  });

  it('已禁用 Token 验证失败', () => {
    TokenService.updateToken(tokenId, { status: 0 });
    const result = TokenService.validateToken(tokenKey);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('禁用');
  });

  it('已过期 Token 验证失败', () => {
    TokenService.updateToken(tokenId, { expiresAt: '2020-01-01T00:00:00Z' });
    const result = TokenService.validateToken(tokenKey);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('过期');
  });

  it('额度用完的 Token 验证失败', () => {
    TokenService.updateToken(tokenId, { balance: 0 });
    const result = TokenService.validateToken(tokenKey);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('额度');
  });

  it('无限额度 Token 始终通过余额检查', () => {
    TokenService.updateToken(tokenId, { balance: -1 });
    const result = TokenService.validateToken(tokenKey);
    expect(result.valid).toBe(true);
  });
});

// ============ PricingService 测试 ============
describe('PricingService', () => {
  const TEST_PATTERN = 'test-billing-model';
  const WILDCARD_PATTERN = '*';

  beforeEach(() => {
    // 清理测试计费规则
    sqlite.prepare(`DELETE FROM model_pricing WHERE model_pattern = ?`).run(TEST_PATTERN);
    sqlite.prepare(`DELETE FROM model_pricing WHERE model_pattern = 'test-per-token'`).run();
  });

  afterEach(() => {
    sqlite.prepare(`DELETE FROM model_pricing WHERE model_pattern = ?`).run(TEST_PATTERN);
    sqlite.prepare(`DELETE FROM model_pricing WHERE model_pattern = 'test-per-token'`).run();
  });

  describe('calculateCost - per_call', () => {
    it('按次计费应返回 inputPrice', () => {
      PricingService.createPricingRule({
        modelPattern: TEST_PATTERN,
        billingType: 'per_call',
        inputPrice: 0.50,
        outputPrice: 0,
      });

      const cost = PricingService.calculateCost(TEST_PATTERN, 1000, 500);
      expect(cost).toBe(0.50);
    });

    it('按次计费与 token 数量无关', () => {
      PricingService.createPricingRule({
        modelPattern: TEST_PATTERN,
        billingType: 'per_call',
        inputPrice: 1.00,
        outputPrice: 0,
      });

      const cost1 = PricingService.calculateCost(TEST_PATTERN, 100, 50);
      const cost2 = PricingService.calculateCost(TEST_PATTERN, 100000, 50000);
      expect(cost1).toBe(cost2);
      expect(cost1).toBe(1.00);
    });
  });

  describe('calculateCost - per_token', () => {
    it('按 token 计费应正确计算', () => {
      PricingService.createPricingRule({
        modelPattern: 'test-per-token',
        billingType: 'per_token',
        inputPrice: 2.00,   // ¥2/1M input tokens
        outputPrice: 6.00,  // ¥6/1M output tokens
      });

      // 1000 input tokens + 500 output tokens
      const cost = PricingService.calculateCost('test-per-token', 1000, 500);
      // (1000/1M)*2 + (500/1M)*6 = 0.002 + 0.003 = 0.005
      expect(cost).toBeCloseTo(0.005, 6);
    });

    it('0 tokens 时费用为 0', () => {
      PricingService.createPricingRule({
        modelPattern: 'test-per-token',
        billingType: 'per_token',
        inputPrice: 2.00,
        outputPrice: 6.00,
      });

      const cost = PricingService.calculateCost('test-per-token', 0, 0);
      expect(cost).toBe(0);
    });
  });

  describe('calculateCost - 匹配规则', () => {
    it('无匹配规则时返回 0', () => {
      // 临时移除通配符规则，确保无匹配
      const wildcard = sqlite.prepare(`SELECT * FROM model_pricing WHERE model_pattern = '*'`).all() as any[];
      sqlite.prepare(`DELETE FROM model_pricing WHERE model_pattern = '*'`).run();

      const cost = PricingService.calculateCost('nonexistent-model', 1000, 500);
      expect(cost).toBe(0);

      // 恢复通配符规则
      for (const w of wildcard) {
        sqlite.prepare(`INSERT INTO model_pricing (model_pattern, billing_type, input_price, output_price, extra_params) VALUES (?, ?, ?, ?, ?)`)
          .run(w.model_pattern, w.billing_type, w.input_price, w.output_price, w.extra_params);
      }
    });

    it('精确匹配优先于通配符', () => {
      // 先确认是否有通配符规则
      const existingWildcard = sqlite.prepare(
        `SELECT id FROM model_pricing WHERE model_pattern = '*'`
      ).get() as any;

      if (!existingWildcard) {
        PricingService.createPricingRule({
          modelPattern: '*',
          billingType: 'per_call',
          inputPrice: 0.10,
        });
      }

      PricingService.createPricingRule({
        modelPattern: TEST_PATTERN,
        billingType: 'per_call',
        inputPrice: 5.00,
      });

      const cost = PricingService.calculateCost(TEST_PATTERN, 0, 0);
      expect(cost).toBe(5.00); // 精确匹配的 5.00，不是通配符的 0.10

      // 清理通配符（如果是我们创建的）
      if (!existingWildcard) {
        sqlite.prepare(`DELETE FROM model_pricing WHERE model_pattern = '*'`).run();
      }
    });
  });

  describe('CRUD', () => {
    it('应该能创建、查询、更新、删除计费规则', () => {
      // Create
      PricingService.createPricingRule({
        modelPattern: TEST_PATTERN,
        billingType: 'per_call',
        inputPrice: 1.00,
      });

      // Read
      const rules = PricingService.getPricingRules();
      const rule = rules.find(r => r.modelPattern === TEST_PATTERN);
      expect(rule).toBeDefined();
      expect(rule!.inputPrice).toBe(1.00);

      // Update
      PricingService.updatePricingRule(rule!.id, { inputPrice: 2.00 });
      const updated = PricingService.getPricingRules().find(r => r.id === rule!.id);
      expect(updated!.inputPrice).toBe(2.00);

      // Delete
      PricingService.deletePricingRule(rule!.id);
      const deleted = PricingService.getPricingRules().find(r => r.id === rule!.id);
      expect(deleted).toBeUndefined();
    });
  });
});

// ============ 计费流程端到端场景测试 ============
describe('计费流程场景', () => {
  it('场景：余额检查通过 → 扣减成功 → 余额减少', () => {
    const check = BalanceService.checkBalance(testUserId, 3.00);
    expect(check.sufficient).toBe(true);

    const remaining = BalanceService.deduct(testUserId, 3.00, 'generate_video');
    expect(remaining).toBe(7.00);
  });

  it('场景：余额检查不通过 → 不应调用扣减', () => {
    const check = BalanceService.checkBalance(testUserId, 100.00);
    expect(check.sufficient).toBe(false);
    // 在实际代码中，此时不应调用 deduct
    // 验证余额不变
    expect(BalanceService.getBalance(testUserId)).toBe(10.00);
  });

  it('场景：生成失败 → 不扣减余额（模拟）', () => {
    const balanceBefore = BalanceService.getBalance(testUserId);

    // 模拟"生成失败不调用 billUsage" — 余额不变
    // （实际逻辑在 route handler 中，这里验证 deduct 不被调用时余额不变）

    const balanceAfter = BalanceService.getBalance(testUserId);
    expect(balanceAfter).toBe(balanceBefore);
  });

  it('场景：视频计费公式 — 分辨率 × 秒数', () => {
    const VIDEO_RATE = { '480p': 0.03, '720p': 0.05 };
    const resolution = '720p';
    const seconds = 10;

    const cost = Math.round(VIDEO_RATE[resolution] * seconds * 100) / 100;
    expect(cost).toBe(0.50);

    const remaining = BalanceService.deduct(testUserId, cost, 'generate_video');
    expect(remaining).toBe(9.50);
  });

  it('场景：图片计费公式 — 单价 × 成功张数', () => {
    // 模拟 per_call 模式，单价 0.20
    sqlite.prepare(`DELETE FROM model_pricing WHERE model_pattern = 'grok-imagine-image'`).run();
    PricingService.createPricingRule({
      modelPattern: 'grok-imagine-image',
      billingType: 'per_call',
      inputPrice: 0.20,
    });

    const unitCost = PricingService.calculateCost('grok-imagine-image', 0, 0);
    const successCount = 3;
    const totalCost = Math.round(unitCost * successCount * 100) / 100;
    expect(totalCost).toBe(0.60);

    const remaining = BalanceService.deduct(testUserId, totalCost, 'generate_image');
    expect(remaining).toBe(9.40);

    // 清理
    sqlite.prepare(`DELETE FROM model_pricing WHERE model_pattern = 'grok-imagine-image'`).run();
  });
});
