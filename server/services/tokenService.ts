import { db } from '../db/index.js';
import { apiTokens, users } from '../db/schema.js';
import { eq, desc, like, and, sql } from 'drizzle-orm';
import crypto from 'crypto';

function generateTokenKey(): string {
  return 'sk-' + crypto.randomBytes(24).toString('hex');
}

export class TokenService {
  /** 获取 Token 列表 */
  static getTokens(options: { page?: number; pageSize?: number; search?: string; userId?: number } = {}) {
    const { page = 1, pageSize = 20, search, userId } = options;
    const offset = (page - 1) * pageSize;

    const conditions: any[] = [];
    if (search) conditions.push(like(apiTokens.name, `%${search}%`));
    if (userId !== undefined) conditions.push(eq(apiTokens.userId, userId));

    let query = db.select({
      id: apiTokens.id,
      userId: apiTokens.userId,
      userName: users.username,
      userEmail: users.email,
      name: apiTokens.name,
      tokenKey: apiTokens.tokenKey,
      allowedModels: apiTokens.allowedModels,
      balance: apiTokens.balance,
      usedAmount: apiTokens.usedAmount,
      rateLimit: apiTokens.rateLimit,
      status: apiTokens.status,
      expiresAt: apiTokens.expiresAt,
      lastUsedAt: apiTokens.lastUsedAt,
      createdAt: apiTokens.createdAt,
    }).from(apiTokens)
      .leftJoin(users, eq(apiTokens.userId, users.id))
      .$dynamic();

    if (conditions.length > 0) query = query.where(and(...conditions));

    const items = query.orderBy(desc(apiTokens.createdAt)).limit(pageSize).offset(offset).all()
      .map(t => {
        const { tokenKey, ...safeToken } = t;
        return {
          ...safeToken,
          allowedModels: JSON.parse(t.allowedModels as string),
          tokenKeyMasked: tokenKey.slice(0, 6) + '****' + tokenKey.slice(-4),
        };
      });

    let countQuery = db.select({ count: sql<number>`count(*)` }).from(apiTokens).$dynamic();
    if (conditions.length > 0) countQuery = countQuery.where(and(...conditions));
    const total = countQuery.get()?.count || 0;

    return { items, total, page, pageSize };
  }

  /** 通过 Token Key 查找 Token（鉴权用，不脱敏） */
  static findByKey(tokenKey: string) {
    const token = db.select().from(apiTokens).where(eq(apiTokens.tokenKey, tokenKey)).get();
    if (!token) return null;
    return {
      ...token,
      allowedModels: JSON.parse(token.allowedModels) as string[],
    };
  }

  /** 获取当前用户拥有的完整 Token Key（仅用于用户主动复制单个密钥） */
  static getTokenKeyForUser(id: number, userId: number) {
    const token = db.select({
      id: apiTokens.id,
      tokenKey: apiTokens.tokenKey,
    }).from(apiTokens).where(and(
      eq(apiTokens.id, id),
      eq(apiTokens.userId, userId),
    )).get();

    if (!token) throw { status: 404, message: 'API Key 不存在' };
    return token;
  }

  /** 创建新 Token */
  static createToken(data: { userId?: number; name?: string; allowedModels?: string[]; balance?: number; rateLimit?: number; expiresAt?: string }) {
    const tokenKey = generateTokenKey();
    const result = db.insert(apiTokens).values({
      userId: data.userId || null,
      name: data.name || '',
      tokenKey,
      allowedModels: JSON.stringify(data.allowedModels || []),
      balance: data.balance ?? -1,
      rateLimit: data.rateLimit ?? -1,
      expiresAt: data.expiresAt || null,
    }).run();

    return { id: Number(result.lastInsertRowid), tokenKey };
  }

  /** 编辑 Token */
  static updateToken(id: number, data: any) {
    const token = db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
    if (!token) throw { status: 404, message: 'Token 不存在' };

    const updates: Record<string, any> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.allowedModels !== undefined) updates.allowedModels = JSON.stringify(data.allowedModels);
    if (data.balance !== undefined) updates.balance = data.balance;
    if (data.rateLimit !== undefined) updates.rateLimit = data.rateLimit;
    if (data.status !== undefined) updates.status = data.status;
    if (data.userId !== undefined) updates.userId = data.userId || null;
    if (data.expiresAt !== undefined) updates.expiresAt = data.expiresAt || null;

    if (Object.keys(updates).length > 0) {
      db.update(apiTokens).set(updates).where(eq(apiTokens.id, id)).run();
    }
  }

  /** 删除 Token */
  static deleteToken(id: number) {
    db.delete(apiTokens).where(eq(apiTokens.id, id)).run();
  }

  /** 扣减额度（原子操作） */
  static deductBalance(tokenId: number, amount: number) {
    if (amount <= 0) return;

    const token = db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get();
    if (!token) return;

    if (token.balance === -1) {
      // 无限额度，只更新 usedAmount
      db.update(apiTokens).set({
        usedAmount: sql`used_amount + ${amount}`,
        lastUsedAt: new Date().toISOString(),
      }).where(eq(apiTokens.id, tokenId)).run();
    } else {
      // 有限额度：原子扣减，使用 MAX(0, ...) 防止负数
      db.update(apiTokens).set({
        balance: sql`MAX(0, balance - ${amount})`,
        usedAmount: sql`used_amount + ${amount}`,
        lastUsedAt: new Date().toISOString(),
      }).where(eq(apiTokens.id, tokenId)).run();
    }
  }

  /** 退回已扣除的 Token 额度，并同步冲减累计用量。 */
  static refundBalance(tokenId: number, amount: number) {
    if (amount <= 0) return;

    const token = db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get();
    if (!token) return;

    if (token.balance === -1) {
      db.update(apiTokens).set({
        usedAmount: sql`MAX(0, used_amount - ${amount})`,
        lastUsedAt: new Date().toISOString(),
      }).where(eq(apiTokens.id, tokenId)).run();
    } else {
      db.update(apiTokens).set({
        balance: sql`balance + ${amount}`,
        usedAmount: sql`MAX(0, used_amount - ${amount})`,
        lastUsedAt: new Date().toISOString(),
      }).where(eq(apiTokens.id, tokenId)).run();
    }
  }

  /** 检查 Token 是否有效 */
  static validateToken(tokenKey: string): { valid: boolean; error?: string; token?: any } {
    const token = this.findByKey(tokenKey);
    if (!token) return { valid: false, error: '无效的 API Token' };
    if (token.status === 0) return { valid: false, error: 'Token 已被禁用' };
    if (token.expiresAt && new Date(token.expiresAt) < new Date()) return { valid: false, error: 'Token 已过期' };
    if (token.balance !== -1 && token.balance <= 0) return { valid: false, error: 'Token 额度已用完' };
    return { valid: true, token };
  }
}
