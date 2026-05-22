import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ============ 等级配置表 ============
export const tiers = sqliteTable('tiers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),            // free / basic / pro / enterprise
  displayName: text('display_name').notNull(),       // 免费用户 / 基础会员 / ...
  dailyQuota: integer('daily_quota').notNull().default(3), // -1 = 不限
  allowedFeatures: text('allowed_features').notNull().default('[]'),  // JSON array
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: integer('is_active').notNull().default(1),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ============ 用户表 ============
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('user'),      // admin | user
  tierId: integer('tier_id').notNull().default(1),   // FK → tiers.id
  tierExpiresAt: text('tier_expires_at'),             // null = 永久
  quotaOverride: integer('quota_override'),           // null = 使用等级默认配额
  wechatOpenid: text('wechat_openid'),                // 预留微信
  balance: real('balance').notNull().default(0),         // 账户余额(元)
  isActive: integer('is_active').notNull().default(1),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

// ============ 模型配置表 ============
export const models = sqliteTable('models', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  provider: text('provider').notNull().default('google'),   // google / openai / ...
  modelId: text('model_id').notNull().unique(),              // gemini-2.5-flash
  displayName: text('display_name').notNull(),
  apiKey: text('api_key'),                                    // 可选，留空则用全局 GEMINI_API_KEY
  capabilities: text('capabilities').notNull().default('["text"]'), // JSON: text/image_gen/video
  isActive: integer('is_active').notNull().default(1),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ============ 等级-模型关联表 ============
export const tierModelAccess = sqliteTable('tier_model_access', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tierId: integer('tier_id').notNull(),
  modelId: integer('model_id').notNull(),
});

// ============ 使用日志表 ============
export const usageLogs = sqliteTable('usage_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  analysisType: text('analysis_type').notNull(),   // general/ecommerce/image/copywriting/account
  modelId: integer('model_id'),
  durationMs: integer('duration_ms'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ============ 系统设置表 (Key-Value) ============
export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key').notNull().unique(),
  value: text('value').notNull().default(''),
  label: text('label').notNull().default(''),       // 后台显示名
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

// ============ 渠道表 ============
export const channels = sqliteTable('channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),                         // 渠道名称
  type: text('type').notNull().default('openai'),       // openai / custom
  baseUrl: text('base_url').notNull(),                  // 上游 API 地址
  apiKey: text('api_key').notNull().default(''),        // 上游 API Key
  modelMapping: text('model_mapping').notNull().default('{}'),      // JSON: {"对外名":"上游名"}
  supportedModels: text('supported_models').notNull().default('[]'), // JSON: ["grok-4","grok-video"]
  priority: integer('priority').notNull().default(0),    // 优先级（越小越优先）
  weight: integer('weight').notNull().default(1),        // 权重（同优先级负载均衡）
  maxRetries: integer('max_retries').notNull().default(3),
  timeout: integer('timeout').notNull().default(120000), // 超时 ms
  status: integer('status').notNull().default(1),        // 0=禁用 1=启用
  lastTestAt: text('last_test_at'),
  lastTestResult: text('last_test_result'),              // success:1200ms / fail:timeout
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

// ============ API Token 表 ============
export const apiTokens = sqliteTable('api_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id'),                            // 所属用户 FK → users.id, null=系统级
  name: text('name').notNull().default(''),               // Token 备注名
  tokenKey: text('token_key').notNull().unique(),         // sk-xxxxxxxxxx
  allowedModels: text('allowed_models').notNull().default('[]'), // JSON: 空数组=全部
  balance: real('balance').notNull().default(-1),         // 剩余额度(元), -1=无限
  usedAmount: real('used_amount').notNull().default(0),   // 已消耗额度
  rateLimit: integer('rate_limit').notNull().default(-1), // 每分钟请求限制, -1=不限
  status: integer('status').notNull().default(1),         // 0=禁用 1=启用
  expiresAt: text('expires_at'),                          // 过期时间, null=永久
  lastUsedAt: text('last_used_at'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ============ 模型计费表 ============
export const modelPricing = sqliteTable('model_pricing', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  modelPattern: text('model_pattern').notNull(),          // 模型匹配（如 grok-4, grok-imagine-video）
  billingType: text('billing_type').notNull().default('per_call'), // per_call / per_token
  inputPrice: real('input_price').notNull().default(0),    // 输入价格
  outputPrice: real('output_price').notNull().default(0),  // 输出价格
  extraParams: text('extra_params').notNull().default('{}'), // JSON 额外计费参数
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ============ API 调用日志表 ============
export const apiLogs = sqliteTable('api_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tokenId: integer('token_id'),                           // FK → api_tokens.id
  channelId: integer('channel_id'),                       // FK → channels.id
  model: text('model').notNull(),                          // 请求的模型名
  upstreamModel: text('upstream_model'),                   // 实际上游模型名
  promptTokens: integer('prompt_tokens').notNull().default(0),
  completionTokens: integer('completion_tokens').notNull().default(0),
  totalTokens: integer('total_tokens').notNull().default(0),
  cost: real('cost').notNull().default(0),                  // 本次消耗金额
  durationMs: integer('duration_ms'),                      // 耗时
  status: text('status').notNull().default('success'),     // success / error
  errorMessage: text('error_message'),
  clientIp: text('client_ip'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});
