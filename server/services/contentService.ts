import { db } from '../db/index.js';
import { contents, users } from '../db/schema.js';
import { eq, and, desc, sql, gte, lte, like, or } from 'drizzle-orm';

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
  status?: string;
  userId?: number;
  orgId?: number;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  source?: 'api';
}

const INTERNAL_VIDEO_ROUTING_FIELDS = [
  'actualModel',
  'actualChannel',
  'fallbackFrom',
  'fallbackReason',
  'fallbackAt',
  'channelId',
  'channelApiKeyId',
  'upstreamModel',
];

/** Remove administrator-only channel and failover details from ordinary content responses. */
export function sanitizeContentRoutingForClient<T extends { metadata?: string | Record<string, any> | null }>(item: T): T {
  let metadata: Record<string, any> = {};
  try {
    metadata = typeof item.metadata === 'string'
      ? JSON.parse(item.metadata || '{}')
      : { ...(item.metadata || {}) };
  } catch {
    return item;
  }

  const wasRouted = Boolean(metadata.fallbackFrom || metadata.fallbackReason || metadata.actualChannel === 'wx-haidiyue');
  for (const field of INTERNAL_VIDEO_ROUTING_FIELDS) delete metadata[field];
  if (wasRouted && typeof metadata.progressText === 'string') {
    metadata.progressText = '视频生成中';
  }

  return {
    ...item,
    metadata: typeof item.metadata === 'string' ? JSON.stringify(metadata) : metadata,
  };
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
    const { page, pageSize, type, status, search, dateFrom, dateTo, source } = options;
    const offset = (page - 1) * pageSize;

    const conditions: any[] = [eq(contents.userId, userId)];
    if (source === 'api') conditions.push(or(
      sql`json_extract(${contents.metadata}, '$.source') = 'api'`,
      sql`json_extract(${contents.metadata}, '$.tokenId') IS NOT NULL`,
    )!);
    if (type) conditions.push(eq(contents.type, type));
    if (status === 'completed') conditions.push(or(eq(contents.status, 'completed'), eq(contents.status, 'success'))!);
    else if (status === 'processing') conditions.push(or(eq(contents.status, 'processing'), eq(contents.status, 'queued'))!);
    else if (status === 'failed') conditions.push(or(eq(contents.status, 'failed'), eq(contents.status, 'error'))!);
    else if (status) conditions.push(eq(contents.status, status));
    if (search) conditions.push(or(
      like(contents.title, `%${search}%`),
      like(contents.inputText, `%${search}%`),
      like(contents.modelId, `%${search}%`),
    )!);
    if (dateFrom) conditions.push(gte(contents.createdAt, `${dateFrom} 00:00:00`));
    if (dateTo) conditions.push(lte(contents.createdAt, `${dateTo} 23:59:59`));

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

    return { items: items.map(sanitizeContentRoutingForClient), total, page, pageSize };
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

  /** 管理员查询所有内容（分页+筛选） */
  static getAllContents(options: { page: number; pageSize: number; type?: string; userId?: number; modelId?: string; status?: string; search?: string }) {
    const { page, pageSize, type, userId, modelId, status, search } = options;
    const offset = (page - 1) * pageSize;

    const conditions: any[] = [];
    if (type) conditions.push(eq(contents.type, type));
    if (userId) conditions.push(eq(contents.userId, userId));
    if (modelId) conditions.push(eq(contents.modelId, modelId));
    if (status) conditions.push(eq(contents.status, status));
    if (search) conditions.push(like(contents.title, `%${search}%`));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const items = db.select({
      id: contents.id,
      userId: contents.userId,
      orgId: contents.orgId,
      type: contents.type,
      title: contents.title,
      inputText: contents.inputText,
      resultUrl: contents.resultUrl,
      resultText: contents.resultText,
      modelId: contents.modelId,
      cost: contents.cost,
      metadata: contents.metadata,
      status: contents.status,
      createdAt: contents.createdAt,
      userEmail: users.email,
      userName: users.username,
    }).from(contents)
      .leftJoin(users, eq(contents.userId, users.id))
      .where(whereClause)
      .orderBy(desc(contents.createdAt))
      .limit(pageSize)
      .offset(offset)
      .all();

    const total = db.select({ count: sql<number>`count(*)` })
      .from(contents)
      .where(whereClause)
      .get()?.count || 0;

    return { items, total, page, pageSize };
  }
}
