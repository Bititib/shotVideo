import { db } from '../db/index.js';
import { users, organizations } from '../db/schema.js';
import { eq, sql, and } from 'drizzle-orm';

export type BalanceSource = 'org' | 'user';
export type BalanceDeduction = {
  balance: number;
  source: BalanceSource;
  orgId?: number;
};

export class BalanceService {
  /** 查询用户当前余额 */
  static getBalance(userId: number): number {
    const user = db.select({ balance: users.balance }).from(users).where(eq(users.id, userId)).get();
    return user?.balance ?? 0;
  }

  /** 查询组织余额 */
  static getOrgBalance(orgId: number): number {
    const org = db.select({ balance: organizations.balance }).from(organizations).where(eq(organizations.id, orgId)).get();
    return org?.balance ?? 0;
  }

  /**
   * 检查余额是否充足（双轨：优先组织余额）
   */
  static checkBalance(userId: number, estimatedCost: number): { sufficient: boolean; balance: number; source: 'org' | 'user' } {
    if (estimatedCost <= 0) return { sufficient: true, balance: 0, source: 'user' };

    const user = db.select({ orgId: users.orgId, balance: users.balance }).from(users).where(eq(users.id, userId)).get();
    if (!user) return { sufficient: false, balance: 0, source: 'user' };

    // 优先检查组织余额
    if (user.orgId) {
      const orgBalance = this.getOrgBalance(user.orgId);
      if (orgBalance >= estimatedCost) {
        return { sufficient: true, balance: orgBalance, source: 'org' };
      }
    }

    // 回退到个人余额
    return { sufficient: user.balance >= estimatedCost, balance: user.balance, source: 'user' };
  }

  /**
   * 原子扣减余额（双轨：优先组织余额）
   * @returns 扣减后的剩余余额，如果余额不足则返回 null
   */
  static deduct(userId: number, amount: number, type: string, meta?: Record<string, any>): number | null {
    return this.deductWithSource(userId, amount, type, meta)?.balance ?? null;
  }

  /** 原子扣款，并返回本次实际使用的余额来源，供失败退款原路退回。 */
  static deductWithSource(userId: number, amount: number, _type: string, _meta?: Record<string, any>): BalanceDeduction | null {
    if (amount <= 0) return { balance: this.getBalance(userId), source: 'user' };

    const user = db.select({ orgId: users.orgId }).from(users).where(eq(users.id, userId)).get();

    // 优先从组织余额扣减
    if (user?.orgId) {
      const orgResult = db.update(organizations)
        .set({ balance: sql`balance - ${amount}`, updatedAt: new Date().toISOString() })
        .where(and(eq(organizations.id, user.orgId), sql`balance >= ${amount}`))
        .run();

      if (orgResult.changes > 0) {
        return { balance: this.getOrgBalance(user.orgId), source: 'org', orgId: user.orgId };
      }
    }

    // 回退到个人余额原子扣减
    const result = db.update(users)
      .set({ balance: sql`balance - ${amount}`, updatedAt: new Date().toISOString() })
      .where(and(eq(users.id, userId), sql`balance >= ${amount}`))
      .run();

    if (result.changes === 0) return null; // 余额不足

    return { balance: this.getBalance(userId), source: 'user' };
  }

  /** 充值个人余额 */
  static recharge(userId: number, amount: number): number {
    db.update(users)
      .set({ balance: sql`balance + ${amount}`, updatedAt: new Date().toISOString() })
      .where(eq(users.id, userId))
      .run();
    return this.getBalance(userId);
  }

  /**
   * 退还余额（生成失败时退还扣款）
   */
  static refund(userId: number, amount: number, type: string = 'refund', meta?: Record<string, any>): number {
    if (amount <= 0) return this.getBalance(userId);

    const user = db.select({ orgId: users.orgId }).from(users).where(eq(users.id, userId)).get();

    return this.refundToSource(userId, amount, user?.orgId ? 'org' : 'user', user?.orgId || undefined, type, meta);
  }

  /** 将退款退回指定的原始扣款来源，避免个人扣款误退到组织余额。 */
  static refundToSource(
    userId: number,
    amount: number,
    source: BalanceSource,
    orgId?: number,
    _type: string = 'refund',
    _meta?: Record<string, any>,
  ): number {
    if (amount <= 0) {
      return source === 'org' && orgId ? this.getOrgBalance(orgId) : this.getBalance(userId);
    }

    if (source === 'org' && orgId) {
      const result = db.update(organizations)
        .set({ balance: sql`balance + ${amount}`, updatedAt: new Date().toISOString() })
        .where(eq(organizations.id, orgId))
        .run();
      if (result.changes > 0) return this.getOrgBalance(orgId);
    }

    // 组织已不存在时也不能吞掉退款，安全回退到用户个人余额。
    db.update(users)
      .set({ balance: sql`balance + ${amount}`, updatedAt: new Date().toISOString() })
      .where(eq(users.id, userId))
      .run();
    return this.getBalance(userId);
  }
}
