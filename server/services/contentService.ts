import { db } from '../db/index.js';
import { contents, users } from '../db/schema.js';
import { eq, and, desc, sql, gte, like } from 'drizzle-orm';

export interface SaveContentInput {
  userId: number;
  orgId?: number | null;
  type: string;        // video / image / analysis / copywriting
  title?: string;
  inputText?: string;
  resultUrl?: string;
  resultText?: string;
  modelId?: string;
  cost?: number;
  metadata?: Record<string, any>;
  status?: string;
}

interface GetContentsOptions {
  page: number;
  pageSize: number;
  type?: string;
  userId?: number;   // 筛选指定用户
  orgId?: number;    // 筛选指定组织
  search?: string;
}

export class ContentService {
  /** 保存生成内容 */
  static save(input: SaveContentInput): number {
    const result = db.insert(contents).values({
      userId: input.userId,
      orgId: input.orgId || null,
      type: input.type,
      title: input.title || '',
      inputText: input.inputText || null,
      resultUrl: input.resultUrl || null,
      resultText: input.resultText || null,
      modelId: input.modelId || null,
      cost: input.cost || 0,
      metadata: JSON.stringify(input.metadata || {}),
      status: input.status || 'completed',
    }).run();

    return Number(result.lastInsertRowid);
  }

  /** 查询个人内容（分页） */
  static getMyContents(userId: number, options: GetContentsOptions) {
    const { page, pageSize, type, search } = options;
    const offset = (page - 1) * pageSize;

    const conditions: any[] = [eq(contents.userId, userId)];
    if (type) conditions.push(eq(contents.type, type));
    if (search) conditions.push(like(contents.title, `%${search}%`));

    const items = db.select().from(contents)
      .where(and(...conditions))
      .orderBy(desc(contents.createdAt))
      .limit(pageSize)
      .offset(offset)
      .all();

    const total = db.select({ count: sql<number>`count(*)` })
      .from(contents)
      .where(and(...conditions))
      .get()?.count || 0;

    return { items, total, page, pageSize };
  }

  /** 查询组织内容（组织管理员可查看所有成员的内容） */
  static getOrgContents(orgId: number, options: GetContentsOptions) {
    const { page, pageSize, type, userId, search } = options;
    const offset = (page - 1) * pageSize;

    const conditions: any[] = [eq(contents.orgId, orgId)];
    if (type) conditions.push(eq(contents.type, type));
    if (userId) conditions.push(eq(contents.userId, userId));
    if (search) conditions.push(like(contents.title, `%${search}%`));

    const items = db.select({
      id: contents.id,
      userId: contents.userId,
      type: contents.type,
      title: contents.title,
      resultUrl: contents.resultUrl,
      resultText: contents.resultText,
      modelId: contents.modelId,
      cost: contents.cost,
      status: contents.status,
      createdAt: contents.createdAt,
      // join user info
      userEmail: users.email,
      userName: users.username,
    }).from(contents)
      .leftJoin(users, eq(contents.userId, users.id))
      .where(and(...conditions))
      .orderBy(desc(contents.createdAt))
      .limit(pageSize)
      .offset(offset)
      .all();

    const total = db.select({ count: sql<number>`count(*)` })
      .from(contents)
      .where(and(...conditions))
      .get()?.count || 0;

    return { items, total, page, pageSize };
  }

  /** 获取内容详情 */
  static getById(contentId: number) {
    const item = db.select().from(contents).where(eq(contents.id, contentId)).get();
    if (!item) throw { status: 404, message: '内容不存在' };
    return item;
  }

  /** 删除内容（仅限本人） */
  static delete(contentId: number, userId: number) {
    const item = db.select().from(contents).where(eq(contents.id, contentId)).get();
    if (!item) throw { status: 404, message: '内容不存在' };
    if (item.userId !== userId) throw { status: 403, message: '无权删除此内容' };

    db.delete(contents).where(eq(contents.id, contentId)).run();
  }

  /** 删除内容（组织管理员 — 可删除组织内任意内容） */
  static deleteByOrg(contentId: number, orgId: number) {
    const item = db.select().from(contents).where(eq(contents.id, contentId)).get();
    if (!item) throw { status: 404, message: '内容不存在' };
    if (item.orgId !== orgId) throw { status: 403, message: '无权删除此内容' };

    db.delete(contents).where(eq(contents.id, contentId)).run();
  }
}
