import { db, sqlite } from '../db/index.js';
import { organizations, orgMembers, users, tiers, usageLogs, contents } from '../db/schema.js';
import { eq, and, gte, sql, desc, count } from 'drizzle-orm';
import bcrypt from 'bcryptjs';

// ============ 组织 CRUD ============

interface CreateOrgInput {
  name: string;
  slug: string;
  ownerId: number;
  tierId?: number;
  balance?: number;
  maxMembers?: number;
}

export class OrgService {
  /** 创建组织 + 自动将 owner 加入成员表 */
  static create(input: CreateOrgInput) {
    const { name, slug, ownerId, tierId, balance, maxMembers } = input;

    // slug 唯一检查
    const existing = db.select().from(organizations).where(eq(organizations.slug, slug)).get();
    if (existing) throw { status: 409, message: '组织标识已存在' };

    const result = db.insert(organizations).values({
      name,
      slug,
      ownerId,
      tierId: tierId || 1,
      balance: balance || 0,
      maxMembers: maxMembers || 10,
    }).run();

    const orgId = Number(result.lastInsertRowid);

    // owner 加入成员表
    db.insert(orgMembers).values({
      orgId,
      userId: ownerId,
      role: 'owner',
    }).run();

    // 更新 owner 用户的 orgId 和角色
    db.update(users).set({
      orgId,
      role: 'org_owner',
      updatedAt: new Date().toISOString(),
    }).where(eq(users.id, ownerId)).run();

    return { orgId };
  }

  /** 获取组织详情 */
  static getById(orgId: number) {
    const org = db.select().from(organizations).where(eq(organizations.id, orgId)).get();
    if (!org) throw { status: 404, message: '组织不存在' };

    const memberCount = db.select({ count: sql<number>`count(*)` })
      .from(orgMembers)
      .where(eq(orgMembers.orgId, orgId))
      .get()?.count || 0;

    const tier = db.select().from(tiers).where(eq(tiers.id, org.tierId)).get();

    return { ...org, memberCount, tierName: tier?.displayName || '-' };
  }

  /** 获取所有组织列表（超级管理员用） */
  static getAll() {
    const orgs = db.select().from(organizations).orderBy(desc(organizations.createdAt)).all();
    return orgs.map(org => {
      const memberCount = db.select({ count: sql<number>`count(*)` })
        .from(orgMembers)
        .where(eq(orgMembers.orgId, org.id))
        .get()?.count || 0;
      const tier = db.select().from(tiers).where(eq(tiers.id, org.tierId)).get();
      const owner = db.select({ email: users.email, username: users.username })
        .from(users).where(eq(users.id, org.ownerId)).get();
      return { ...org, memberCount, tierName: tier?.displayName || '-', ownerEmail: owner?.email || '-' };
    });
  }

  /** 更新组织信息 */
  static update(orgId: number, updates: Partial<{
    name: string; tierId: number; balance: number; maxMembers: number; isActive: number;
  }>) {
    const org = db.select().from(organizations).where(eq(organizations.id, orgId)).get();
    if (!org) throw { status: 404, message: '组织不存在' };

    const fields: Record<string, any> = { updatedAt: new Date().toISOString() };
    if (updates.name !== undefined) fields.name = updates.name;
    if (updates.tierId !== undefined) fields.tierId = updates.tierId;
    if (updates.balance !== undefined) fields.balance = Math.max(0, Number(updates.balance) || 0);
    if (updates.maxMembers !== undefined) fields.maxMembers = updates.maxMembers;
    if (updates.isActive !== undefined) fields.isActive = updates.isActive;

    db.update(organizations).set(fields).where(eq(organizations.id, orgId)).run();
  }

  /** 删除组织 */
  static delete(orgId: number) {
    // 移除所有成员的组织关联
    const members = db.select().from(orgMembers).where(eq(orgMembers.orgId, orgId)).all();
    for (const m of members) {
      db.update(users).set({ orgId: null, role: 'user', updatedAt: new Date().toISOString() })
        .where(eq(users.id, m.userId)).run();
    }
    db.delete(orgMembers).where(eq(orgMembers.orgId, orgId)).run();
    db.delete(organizations).where(eq(organizations.id, orgId)).run();
  }

  // ============ 成员管理 ============

  /** 获取组织成员列表 */
  static getMembers(orgId: number) {
    const members = db.select({
      id: orgMembers.id,
      userId: orgMembers.userId,
      role: orgMembers.role,
      joinedAt: orgMembers.joinedAt,
      email: users.email,
      username: users.username,
      balance: users.balance,
      isActive: users.isActive,
    }).from(orgMembers)
      .innerJoin(users, eq(orgMembers.userId, users.id))
      .where(eq(orgMembers.orgId, orgId))
      .all();

    // 附加今日用量
    const today = new Date().toISOString().split('T')[0];
    return members.map(m => {
      const usage = db.select({ count: sql<number>`count(*)` })
        .from(usageLogs)
        .where(and(eq(usageLogs.userId, m.userId), gte(usageLogs.createdAt, today)))
        .get();
      return { ...m, usedToday: usage?.count || 0 };
    });
  }

  /** 组织管理员直接创建员工 */
  static async createMember(orgId: number, invitedBy: number, data: {
    email: string; username?: string; password: string; role?: string;
  }) {
    const org = db.select().from(organizations).where(eq(organizations.id, orgId)).get();
    if (!org) throw { status: 404, message: '组织不存在' };

    // 检查成员上限
    const memberCount = db.select({ count: sql<number>`count(*)` })
      .from(orgMembers)
      .where(eq(orgMembers.orgId, orgId))
      .get()?.count || 0;
    if (memberCount >= org.maxMembers) {
      throw { status: 400, message: `已达最大成员数 (${org.maxMembers})` };
    }

    // 检查邮箱是否已存在
    const existing = db.select().from(users).where(eq(users.email, data.email)).get();
    if (existing) throw { status: 409, message: '该邮箱已被注册' };

    // 创建用户
    const passwordHash = bcrypt.hashSync(data.password, 12);
    const memberRole = data.role === 'admin' ? 'org_admin' : 'member';

    const result = db.insert(users).values({
      email: data.email,
      username: data.username || data.email.split('@')[0],
      passwordHash,
      role: memberRole,
      orgId,
      tierId: org.tierId, // 继承组织等级
    }).run();

    const userId = Number(result.lastInsertRowid);

    // 加入成员表
    db.insert(orgMembers).values({
      orgId,
      userId,
      role: memberRole === 'org_admin' ? 'admin' : 'member',
      invitedBy,
    }).run();

    return { userId };
  }

  /** 修改成员角色 */
  static updateMemberRole(orgId: number, memberId: number, newRole: string) {
    const membership = db.select().from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.id, memberId))).get();
    if (!membership) throw { status: 404, message: '成员不存在' };
    if (membership.role === 'owner') throw { status: 400, message: '不能修改创建者的角色' };

    const validRoles = ['admin', 'member'];
    if (!validRoles.includes(newRole)) throw { status: 400, message: '无效的角色' };

    db.update(orgMembers).set({ role: newRole }).where(eq(orgMembers.id, memberId)).run();

    // 同步更新 users 表的角色
    const userRole = newRole === 'admin' ? 'org_admin' : 'member';
    db.update(users).set({ role: userRole, updatedAt: new Date().toISOString() })
      .where(eq(users.id, membership.userId)).run();
  }

  /** 移除成员 */
  static removeMember(orgId: number, memberId: number) {
    const membership = db.select().from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.id, memberId))).get();
    if (!membership) throw { status: 404, message: '成员不存在' };
    if (membership.role === 'owner') throw { status: 400, message: '不能移除组织创建者' };

    // 移除成员关联
    db.delete(orgMembers).where(eq(orgMembers.id, memberId)).run();

    // 将用户变为散户
    db.update(users).set({ orgId: null, role: 'user', updatedAt: new Date().toISOString() })
      .where(eq(users.id, membership.userId)).run();
  }

  // ============ 组织统计 ============

  /** 组织用量统计（增强版） */
  static getUsageStats(orgId: number) {
    const members = db.select({ userId: orgMembers.userId })
      .from(orgMembers)
      .where(eq(orgMembers.orgId, orgId))
      .all();
    const memberIds = members.map(m => m.userId);
    if (memberIds.length === 0) return { todayCalls: 0, totalCalls: 0, totalContents: 0, memberStats: [], trend7Days: [], featureDistribution: [], costBreakdown: [] };

    const today = new Date().toISOString().split('T')[0];
    const memberIdList = memberIds.join(',');

    // 按成员统计用量
    const memberStats = memberIds.map(uid => {
      const user = db.select({ email: users.email, username: users.username })
        .from(users).where(eq(users.id, uid)).get();
      const todayUsage = db.select({ count: sql<number>`count(*)` })
        .from(usageLogs)
        .where(and(eq(usageLogs.userId, uid), gte(usageLogs.createdAt, today)))
        .get()?.count || 0;
      const totalUsage = db.select({ count: sql<number>`count(*)` })
        .from(usageLogs)
        .where(eq(usageLogs.userId, uid))
        .get()?.count || 0;
      const contentCount = db.select({ count: sql<number>`count(*)` })
        .from(contents)
        .where(eq(contents.userId, uid))
        .get()?.count || 0;
      // 成员消费总额（从 contents 的 cost 字段汇总）
      const totalCost = db.select({ sum: sql<number>`coalesce(sum(cost), 0)` })
        .from(contents)
        .where(eq(contents.userId, uid))
        .get()?.sum || 0;
      return { userId: uid, email: user?.email, username: user?.username, todayUsage, totalUsage, contentCount, totalCost: Math.round(totalCost * 100) / 100 };
    });

    // 近 7 天调用趋势
    const trend7Days: { date: string; count: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const nextDate = new Date(d);
      nextDate.setDate(nextDate.getDate() + 1);
      const nextDateStr = nextDate.toISOString().split('T')[0];

      const row = sqlite.prepare(
        `SELECT count(*) as cnt FROM usage_logs WHERE user_id IN (${memberIdList}) AND created_at >= ? AND created_at < ?`
      ).get(dateStr, nextDateStr) as any;
      trend7Days.push({ date: dateStr, count: row?.cnt || 0 });
    }

    // 功能使用分布
    const featureRows = sqlite.prepare(
      `SELECT analysis_type as type, count(*) as count FROM usage_logs WHERE user_id IN (${memberIdList}) GROUP BY analysis_type ORDER BY count DESC`
    ).all() as any[];

    // 按内容类型的消费金额分布
    const costRows = sqlite.prepare(
      `SELECT type, coalesce(sum(cost), 0) as total_cost, count(*) as count FROM contents WHERE user_id IN (${memberIdList}) GROUP BY type ORDER BY total_cost DESC`
    ).all() as any[];

    return {
      todayCalls: memberStats.reduce((s, m) => s + m.todayUsage, 0),
      totalCalls: memberStats.reduce((s, m) => s + m.totalUsage, 0),
      totalContents: memberStats.reduce((s, m) => s + m.contentCount, 0),
      totalCost: memberStats.reduce((s, m) => s + m.totalCost, 0),
      memberStats,
      trend7Days,
      featureDistribution: featureRows || [],
      costBreakdown: (costRows || []).map((r: any) => ({
        type: r.type,
        totalCost: Math.round((r.total_cost || 0) * 100) / 100,
        count: r.count,
      })),
    };
  }
}
