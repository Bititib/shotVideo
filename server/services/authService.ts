import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { db } from '../db/index.js';
import { users, tiers, usageLogs, organizations, orgMembers } from '../db/schema.js';
import { eq, and, gte, sql } from 'drizzle-orm';
import { env } from '../config/env.js';

interface RegisterInput {
  email: string;
  username: string;
  password: string;
}

interface LoginInput {
  email: string;
  password: string;
}

export class AuthService {
  /** 注册新用户（默认免费等级） */
  static async register(input: RegisterInput) {
    const { email, username, password } = input;

    // 检查邮箱是否已存在
    const existing = db.select().from(users).where(eq(users.email, email)).get();
    if (existing) {
      throw { status: 409, message: '该邮箱已被注册' };
    }

    // 获取免费等级ID
    const freeTier = db.select().from(tiers).where(eq(tiers.name, 'free')).get();
    if (!freeTier) {
      throw { status: 500, message: '系统未初始化等级配置' };
    }

    const passwordHash = bcrypt.hashSync(password, 12);

    const result = db.insert(users).values({
      email,
      username,
      passwordHash,
      role: 'user',
      tierId: freeTier.id,
    }).run();

    const user = db.select().from(users).where(eq(users.id, Number(result.lastInsertRowid))).get();
    return this.generateAuthResponse(user!);
  }

  /** 登录 */
  static async login(input: LoginInput) {
    const { email, password } = input;

    const user = db.select().from(users).where(eq(users.email, email)).get();
    if (!user) {
      throw { status: 401, message: '邮箱或密码错误' };
    }

    if (!user.isActive) {
      throw { status: 403, message: '账号已被禁用，请联系管理员' };
    }

    const valid = bcrypt.compareSync(password, user.passwordHash);
    if (!valid) {
      throw { status: 401, message: '邮箱或密码错误' };
    }

    return this.generateAuthResponse(user);
  }

  /** 获取当前用户信息（含等级 + 今日剩余配额） */
  static async getProfile(userId: number) {
    const user = db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) {
      throw { status: 404, message: '用户不存在' };
    }

    const tier = db.select().from(tiers).where(eq(tiers.id, user.tierId)).get();

    // 检查会员是否过期
    if (user.tierExpiresAt && new Date(user.tierExpiresAt) < new Date()) {
      // 过期，降级为免费
      const freeTier = db.select().from(tiers).where(eq(tiers.name, 'free')).get();
      if (freeTier) {
        db.update(users).set({ tierId: freeTier.id, tierExpiresAt: null }).where(eq(users.id, userId)).run();
        return this.getProfile(userId); // 递归获取更新后的信息
      }
    }

    // 今日已使用次数
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const todayUsage = db.select({ count: sql<number>`count(*)` })
      .from(usageLogs)
      .where(and(
        eq(usageLogs.userId, userId),
        gte(usageLogs.createdAt, today)
      ))
      .get();

    const dailyQuota = user.quotaOverride ?? tier?.dailyQuota ?? 3;
    const usedToday = todayUsage?.count ?? 0;

    return {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      tier: tier ? {
        id: tier.id,
        name: tier.name,
        displayName: tier.displayName,
        dailyQuota: dailyQuota,
        allowedFeatures: JSON.parse(tier.allowedFeatures),
      } : null,
      tierExpiresAt: user.tierExpiresAt,
      usedToday,
      remainingToday: dailyQuota === -1 ? -1 : Math.max(0, dailyQuota - usedToday),
      balance: user.balance,
      isActive: user.isActive,
      createdAt: user.createdAt,
      // 组织信息
      org: user.orgId ? (() => {
        const org = db.select().from(organizations).where(eq(organizations.id, user.orgId!)).get();
        const membership = db.select().from(orgMembers)
          .where(and(eq(orgMembers.orgId, user.orgId!), eq(orgMembers.userId, userId)))
          .get();
        return org ? { id: org.id, name: org.name, slug: org.slug, myRole: membership?.role || 'member', balance: org.balance } : null;
      })() : null,
    };
  }

  /** 生成 JWT token + 用户信息 */
  private static generateAuthResponse(user: typeof users.$inferSelect) {
    const token = jwt.sign(
      { userId: user.id, role: user.role, orgId: user.orgId || null },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN }
    );

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        orgId: user.orgId || null,
      },
    };
  }
}
