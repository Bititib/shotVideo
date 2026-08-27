import { and, desc, eq, like, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { contents, modelFeedbacks, users } from '../db/schema.js';

const FEEDBACK_STATUSES = ['pending', 'reviewing', 'resolved', 'ignored'] as const;
type FeedbackStatus = typeof FEEDBACK_STATUSES[number];

interface AdminFeedbackOptions {
  page: number;
  pageSize: number;
  status?: string;
  modelId?: string;
  search?: string;
}

export class FeedbackService {
  static create(userId: number, input: {
    contentId?: number | null;
    modelId?: string;
    errorMessage?: string;
    description?: string;
  }) {
    const modelId = String(input.modelId || '').trim().slice(0, 200);
    const errorMessage = String(input.errorMessage || '').trim().slice(0, 2000);
    const description = String(input.description || '').trim().slice(0, 1000);
    const contentId = input.contentId ? Number(input.contentId) : null;

    if (!modelId) throw { status: 400, message: '缺少模型信息' };
    if (!errorMessage) throw { status: 400, message: '缺少失败信息' };

    if (contentId) {
      const content = db.select().from(contents).where(eq(contents.id, contentId)).get();
      if (!content) throw { status: 404, message: '关联任务不存在' };
      if (content.userId !== userId) throw { status: 403, message: '无权反馈该任务' };
    }

    const existing = db.select().from(modelFeedbacks).where(and(
      eq(modelFeedbacks.userId, userId),
      eq(modelFeedbacks.modelId, modelId),
      contentId ? eq(modelFeedbacks.contentId, contentId) : eq(modelFeedbacks.errorMessage, errorMessage),
      or(eq(modelFeedbacks.status, 'pending'), eq(modelFeedbacks.status, 'reviewing')),
    )).get();

    if (existing) return { id: existing.id, duplicate: true };

    const result = db.insert(modelFeedbacks).values({
      userId,
      contentId,
      modelId,
      errorMessage,
      description,
    }).run();

    return { id: Number(result.lastInsertRowid), duplicate: false };
  }

  static getAdminList(options: AdminFeedbackOptions) {
    const { page, pageSize, status, modelId, search } = options;
    const offset = (page - 1) * pageSize;
    const conditions: any[] = [];

    if (status && FEEDBACK_STATUSES.includes(status as FeedbackStatus)) {
      conditions.push(eq(modelFeedbacks.status, status));
    }
    if (modelId) conditions.push(eq(modelFeedbacks.modelId, modelId));
    if (search) {
      const keyword = `%${search}%`;
      conditions.push(or(
        like(modelFeedbacks.modelId, keyword),
        like(modelFeedbacks.errorMessage, keyword),
        like(modelFeedbacks.description, keyword),
        like(users.email, keyword),
        like(users.username, keyword),
      ));
    }

    const whereClause = conditions.length ? and(...conditions) : undefined;
    let itemsQuery = db.select({
      id: modelFeedbacks.id,
      userId: modelFeedbacks.userId,
      userEmail: users.email,
      userName: users.username,
      contentId: modelFeedbacks.contentId,
      contentTitle: contents.title,
      contentStatus: contents.status,
      modelId: modelFeedbacks.modelId,
      errorMessage: modelFeedbacks.errorMessage,
      description: modelFeedbacks.description,
      status: modelFeedbacks.status,
      adminNote: modelFeedbacks.adminNote,
      createdAt: modelFeedbacks.createdAt,
      updatedAt: modelFeedbacks.updatedAt,
      resolvedAt: modelFeedbacks.resolvedAt,
    }).from(modelFeedbacks)
      .leftJoin(users, eq(modelFeedbacks.userId, users.id))
      .leftJoin(contents, eq(modelFeedbacks.contentId, contents.id))
      .$dynamic();

    let countQuery = db.select({ count: sql<number>`count(*)` })
      .from(modelFeedbacks)
      .leftJoin(users, eq(modelFeedbacks.userId, users.id))
      .$dynamic();

    if (whereClause) {
      itemsQuery = itemsQuery.where(whereClause);
      countQuery = countQuery.where(whereClause);
    }

    const items = itemsQuery.orderBy(desc(modelFeedbacks.createdAt)).limit(pageSize).offset(offset).all();
    const total = countQuery.get()?.count || 0;
    const pending = db.select({ count: sql<number>`count(*)` }).from(modelFeedbacks)
      .where(or(eq(modelFeedbacks.status, 'pending'), eq(modelFeedbacks.status, 'reviewing'))).get()?.count || 0;

    return { items, total, pending, page, pageSize };
  }

  static update(id: number, input: { status?: string; adminNote?: string }) {
    const existing = db.select().from(modelFeedbacks).where(eq(modelFeedbacks.id, id)).get();
    if (!existing) throw { status: 404, message: '反馈不存在' };

    const updates: Record<string, any> = { updatedAt: new Date().toISOString() };
    if (input.status !== undefined) {
      if (!FEEDBACK_STATUSES.includes(input.status as FeedbackStatus)) {
        throw { status: 400, message: '反馈状态无效' };
      }
      updates.status = input.status;
      updates.resolvedAt = input.status === 'resolved' ? new Date().toISOString() : null;
    }
    if (input.adminNote !== undefined) updates.adminNote = String(input.adminNote).trim().slice(0, 2000);

    db.update(modelFeedbacks).set(updates).where(eq(modelFeedbacks.id, id)).run();
  }
}
