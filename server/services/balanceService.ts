import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';

export class BalanceService {
  /** 查询用户当前余额 */
  static getBalance(userId: number): number {
    const user = db.select({ balance: users.balance }).from(users).where(eq(users.id, userId)).get();
    return user?.balance ?? 0;
  }

  /** 检查余额是否充足 */
  static checkBalance(userId: number, estimatedCost: number): { sufficient: boolean; balance: number } {
    const balance = this.getBalance(userId);
    return { sufficient: estimatedCost <= 0 || balance >= estimatedCost, balance };
  }

  /**
   * 原子扣减用户余额
   * @returns 扣减后的剩余余额，如果余额不足则返回 null
   */
  static deduct(userId: number, amount: number, type: string, meta?: Record<string, any>): number | null {
    if (amount <= 0) return this.getBalance(userId);

    const current = this.getBalance(userId);
    if (current < amount) return null;

    // 原子扣减，使用 MAX(0, ...) 防止并发场景下负数
    db.update(users)
      .set({ balance: sql`MAX(0, balance - ${amount})`, updatedAt: new Date().toISOString() })
      .where(eq(users.id, userId))
      .run();

    return this.getBalance(userId);
  }
}
