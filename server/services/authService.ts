import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { db } from '../db/index.js';
import { users, tiers, usageLogs, organizations, orgMembers } from '../db/schema.js';
import { eq, and, gte, lt, sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { TokenService } from './tokenService.js';
import { beijingDateKey, beijingDayBounds } from '../../shared/time.js';

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
    if (!input || typeof input.email !== 'string' || typeof input.username !== 'string' || typeof input.password !== 'string')
      throw { status: 400, message: '请填写邮箱、用户名和密码' };
    const email = input.email.trim().toLowerCase(), username = input.username.trim(), password = input.password;
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw { status: 400, message: '请输入有效的邮箱地址' };
    if (!username || username.length > 50) throw { status: 400, message: '用户名需为1–50个字符' };
    if (password.length < 6) throw { status: 400, message: '密码至少为6位' };
    if (Buffer.byteLength(password, 'utf8') > 72) throw { status: 400, message: '密码过长，请使用更短的密码' };

    // 检查邮箱是否已存在
    const existing = db.select().from(users).where(sql`lower(${users.email}) = ${email}`).get();
    if (existing) {
      throw { status: 409, message: '该邮箱已被注册' };
    }

    // 获取免费等级ID
    const freeTier = db.select().from(tiers).where(eq(tiers.name, 'free')).get();
    if (!freeTier) {
      throw { status: 500, message: '系统未初始化等级配置' };
    }

    const passwordHash = await bcrypt.hash(password, 12);

    let result;
    try { result = db.insert(users).values({
      email,
      username,
      passwordHash,
      role: 'user',
      tierId: freeTier.id,
      balance: 0,
      orgId: null,
      isActive: 1,
    }).run(); }
    catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.cause?.code === 'SQLITE_CONSTRAINT_UNIQUE')
        throw { status: 409, message: '该邮箱已被注册' };
      throw { status: 500, message: '注册失败，请稍后重试' };
    }

    const user = db.select().from(users).where(eq(users.id, Number(result.lastInsertRowid))).get();
    return this.generateAuthResponse(user!);
  }

  /** 登录 */
  static async login(input: LoginInput) {
    const { email, password } = input;
    if (typeof email !== 'string' || typeof password !== 'string') throw { status: 400, message: '请填写邮箱和密码' };

    const address = email.trim();
    const user = db.select().from(users).where(eq(users.email, address)).get()
      || db.select().from(users).where(sql`lower(${users.email}) = ${address.toLowerCase()}`).get();
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

  /** 修改密码 */
  static async changePassword(userId: number, oldPass: string, newPass: string) {
    const user = db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) {
      throw { status: 404, message: '用户不存在' };
    }

    const valid = bcrypt.compareSync(oldPass, user.passwordHash);
    if (!valid) {
      throw { status: 400, message: '当前密码输入错误' };
    }

    if (newPass.length < 6) {
      throw { status: 400, message: '新密码至少为6位' };
    }

    const newHash = bcrypt.hashSync(newPass, 12);
    db.update(users).set({ passwordHash: newHash, updatedAt: new Date().toISOString() }).where(eq(users.id, userId)).run();
    return { message: '密码修改成功' };
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
    const today = beijingDayBounds(beijingDateKey())!;
    const todayUsage = db.select({ count: sql<number>`count(*)` })
      .from(usageLogs)
      .where(and(
        eq(usageLogs.userId, userId),
        gte(usageLogs.createdAt, today.start),
        lt(usageLogs.createdAt, today.end),
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
      hasActiveApiKey: TokenService.hasActiveTokenForUser(userId),
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
      { expiresIn: env.JWT_EXPIRES_IN as any }
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
