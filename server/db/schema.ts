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

// ============ 组织表 ============
export const organizations = sqliteTable('organizations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),                         // 企业名称
  slug: text('slug').notNull().unique(),                 // URL 友好标识 (如: acme-corp)
  logoUrl: text('logo_url'),                             // 企业 Logo
  tierId: integer('tier_id').notNull().default(1),       // 组织等级 FK → tiers.id
  balance: real('balance').notNull().default(0),          // 组织余额（统一结算）
  maxMembers: integer('max_members').notNull().default(10), // 最大成员数
  ownerId: integer('owner_id').notNull(),                // 创建者 FK → users.id
  isActive: integer('is_active').notNull().default(1),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

// ============ 组织成员表 ============
export const orgMembers = sqliteTable('org_members', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  orgId: integer('org_id').notNull(),                    // FK → organizations.id
  userId: integer('user_id').notNull(),                  // FK → users.id
  role: text('role').notNull().default('member'),        // owner / admin / member
  invitedBy: integer('invited_by'),                      // FK → users.id (谁邀请的)
  joinedAt: text('joined_at').notNull().default(sql`(datetime('now'))`),
});

// ============ 用户表 ============
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('user'),      // super_admin | org_owner | org_admin | member | user
  orgId: integer('org_id'),                          // 所属组织 FK → organizations.id, null = 散户
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
  description: text('description'),                           // 模型描述 / 提示说明
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
  status: text('status').notNull().default('success'), // success / error / failed
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
  concurrencyLimit: integer('concurrency_limit').notNull().default(10),
  maxRetries: integer('max_retries').notNull().default(3),
  timeout: integer('timeout').notNull().default(120000), // 超时 ms
  faceSplitEnabled: integer('face_split_enabled').notNull().default(0), // 仅 wx-海底月：默认是否处理参考图人脸
  status: integer('status').notNull().default(1),        // 0=禁用 1=启用
  lastTestAt: text('last_test_at'),
  lastTestResult: text('last_test_result'),              // success:1200ms / fail:timeout
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

// ============ 渠道 API Key 表 ============
// HM Studio 一个渠道可配置多个 Key；每个 Key 拥有独立的并发池。
export const channelApiKeys = sqliteTable('channel_api_keys', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  channelId: integer('channel_id').notNull(),
  apiKey: text('api_key').notNull().unique(),
  concurrencyLimit: integer('concurrency_limit').notNull().default(10),
  status: integer('status').notNull().default(1),
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

// ============ 生成内容表 ============
export const contents = sqliteTable('contents', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),                   // 创建者 FK → users.id
  orgId: integer('org_id'),                               // 所属组织 (null = 散户)
  type: text('type').notNull(),                           // video / image / analysis / copywriting
  title: text('title').notNull().default(''),              // 标题/摘要
  inputText: text('input_text'),                          // 输入的原始素材描述
  resultUrl: text('result_url'),                          // 生成结果 URL (视频/图片)
  resultText: text('result_text'),                        // 生成结果文本 (分析/文案)
  modelId: text('model_id'),                              // 使用的模型
  cost: real('cost').notNull().default(0),                 // 本次消耗金额
  metadata: text('metadata').notNull().default('{}'),      // JSON 额外信息
  status: text('status').notNull().default('completed'),   // completed / failed / processing
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ============ 模型故障反馈表 ============
export const modelFeedbacks = sqliteTable('model_feedbacks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  contentId: integer('content_id'),
  modelId: text('model_id').notNull(),
  errorMessage: text('error_message').notNull().default(''),
  description: text('description').notNull().default(''),
  status: text('status').notNull().default('pending'),
  adminNote: text('admin_note').notNull().default(''),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  resolvedAt: text('resolved_at'),
});

// ============ 漫剧项目与持久化任务 ============
export const comicDramaProjects = sqliteTable('comic_drama_projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  orgId: integer('org_id'),
  title: text('title').notNull().default('未命名漫剧'),
  script: text('script').notNull(),
  status: text('status').notNull().default('planned'),
  blueprint: text('blueprint').notNull().default('{}'),
  state: text('state').notNull().default('{}'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

// ============ 漫剧分集 ============
// 项目保存跨集共享的视觉资产与制作偏好；每一集独立保存剧本、分析结果和制作状态。
export const comicDramaEpisodes = sqliteTable('comic_drama_episodes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  userId: integer('user_id').notNull(),
  episodeNumber: integer('episode_number').notNull(),
  title: text('title').notNull().default('未命名剧集'),
  script: text('script').notNull().default(''),
  status: text('status').notNull().default('draft'),
  blueprint: text('blueprint').notNull().default('{}'),
  state: text('state').notNull().default('{}'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const comicDramaTasks = sqliteTable('comic_drama_tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  episodeId: integer('episode_id'),
  userId: integer('user_id').notNull(),
  kind: text('kind').notNull(),
  entityKey: text('entity_key').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  status: text('status').notNull().default('pending'),
  payload: text('payload').notNull().default('{}'),
  resultUrl: text('result_url'),
  attempts: integer('attempts').notNull().default(0),
  qualityScore: integer('quality_score'),
  qualityReport: text('quality_report'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});
