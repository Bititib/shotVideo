import { db } from '../db/index.js';
import { contents, users } from '../db/schema.js';
import { eq, and, desc, sql, gte, lte, like, or } from 'drizzle-orm';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

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

const OMITTED_LIST_VALUE = Symbol('omitted-list-value');
const DATA_URL_PREFIX = /^data:/i;
const IMAGE_DATA_URL_PREFIX = /^data:image\//i;
const BLOB_URL_PREFIX = /^blob:/i;
const MEDIA_FIELD_NAME = /(?:image|video|audio|frame|file|material|media|asset|reference|source|data)/i;
const MAX_LIST_MEDIA_STRING_LENGTH = 128 * 1024;
const MAX_INLINE_ASSET_BYTES = 150 * 1024 * 1024;
const HISTORY_ASSET_FIELDS = new Set([
  'reference_images', 'image_urls', 'images', 'image_refs', 'referenceImages', 'reference_image', 'image_url',
  'reference_videos', 'video_urls', 'videos', 'video_refs', 'referenceVideos', 'reference_video', 'video_url',
  'audio_urls', 'reference_audios', 'audios', 'audio_refs', 'referenceAudios', 'audio_url', 'reference_audio',
  'first_frame', 'first_frame_url', 'last_frame', 'last_frame_url', 'end_frame_url',
]);
const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
};

export type MaterializedContentAssets = {
  metadata: Record<string, any>;
  changed: boolean;
  filesWritten: number;
  bytesWritten: number;
};

/**
 * Persist inline history media as content-addressed files and replace Base64
 * values with lightweight URLs. This keeps content detail responses small and
 * deduplicates aliases that point at the same reference asset.
 */
export function materializeContentMetadataAssets(
  rawMetadata: string | Record<string, any> | null | undefined,
  options: { uploadDir?: string; publicBaseUrl?: string } = {},
): MaterializedContentAssets {
  let metadata: Record<string, any>;
  try {
    metadata = typeof rawMetadata === 'string'
      ? JSON.parse(rawMetadata || '{}')
      : { ...(rawMetadata || {}) };
  } catch {
    return { metadata: {}, changed: false, filesWritten: 0, bytesWritten: 0 };
  }

  const uploadDir = options.uploadDir || path.resolve(process.cwd(), 'data/uploads/history-assets');
  const configuredBaseUrl = String(options.publicBaseUrl || metadata.publicBaseUrl || '').trim().replace(/\/+$/, '');
  const publicBaseUrl = /^https?:\/\//i.test(configuredBaseUrl) ? configuredBaseUrl : '';
  const converted = new Map<string, string>();
  let changed = false;
  let filesWritten = 0;
  let bytesWritten = 0;

  const materializeValue = (value: unknown): unknown => {
    if (typeof value !== 'string' || !/^data:/i.test(value)) return value;
    const cached = converted.get(value);
    if (cached) return cached;

    const match = value.match(/^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$/i);
    if (!match) return value;

    try {
      const mimeType = match[1].toLowerCase();
      const buffer = Buffer.from(match[2], 'base64');
      if (buffer.length === 0 || buffer.length > MAX_INLINE_ASSET_BYTES) return value;

      const extension = MIME_EXTENSIONS[mimeType]
        || (mimeType.startsWith('image/') ? 'img' : mimeType.startsWith('video/') ? 'mp4' : mimeType.startsWith('audio/') ? 'bin' : 'bin');
      const filename = `${crypto.createHash('sha256').update(buffer).digest('hex')}.${extension}`;
      const filePath = path.join(uploadDir, filename);
      fs.mkdirSync(uploadDir, { recursive: true });
      if (!fs.existsSync(filePath)) {
        try {
          fs.writeFileSync(filePath, buffer, { flag: 'wx' });
          filesWritten += 1;
          bytesWritten += buffer.length;
        } catch (error: any) {
          if (error?.code !== 'EEXIST') throw error;
        }
      }

      const relativeUrl = `/uploads/history-assets/${filename}`;
      const url = publicBaseUrl ? `${publicBaseUrl}${relativeUrl}` : relativeUrl;
      converted.set(value, url);
      changed = true;
      return url;
    } catch (error) {
      console.error('[content-assets] Failed to materialize inline history asset:', error);
      return value;
    }
  };

  for (const [field, value] of Object.entries(metadata)) {
    if (!HISTORY_ASSET_FIELDS.has(field)) continue;
    metadata[field] = Array.isArray(value)
      ? value.map(materializeValue)
      : materializeValue(value);
  }

  if (changed) {
    delete metadata.listAssetsCompacted;
    delete metadata.omittedInlineAssetCount;
  }
  return { metadata, changed, filesWritten, bytesWritten };
}

function compactMetadataValue(value: any, fieldName = ''): { value: any; omitted: number } {
  if (typeof value === 'string') {
    const isInlineMedia = BLOB_URL_PREFIX.test(value)
      || (DATA_URL_PREFIX.test(value)
        && (!IMAGE_DATA_URL_PREFIX.test(value) || value.length > MAX_LIST_MEDIA_STRING_LENGTH))
      || (value.length > MAX_LIST_MEDIA_STRING_LENGTH && MEDIA_FIELD_NAME.test(fieldName));
    return isInlineMedia
      ? { value: OMITTED_LIST_VALUE, omitted: 1 }
      : { value, omitted: 0 };
  }

  if (Array.isArray(value)) {
    let omitted = 0;
    const compacted: any[] = [];
    for (const entry of value) {
      const result = compactMetadataValue(entry, fieldName);
      omitted += result.omitted;
      if (result.value !== OMITTED_LIST_VALUE) compacted.push(result.value);
    }
    return { value: compacted, omitted };
  }

  if (value && typeof value === 'object') {
    let omitted = 0;
    const compacted: Record<string, any> = {};
    for (const [key, entry] of Object.entries(value)) {
      const result = compactMetadataValue(entry, key);
      omitted += result.omitted;
      if (result.value !== OMITTED_LIST_VALUE) compacted[key] = result.value;
    }
    return { value: compacted, omitted };
  }

  return { value, omitted: 0 };
}

const REFERENCE_ASSET_FIELDS = {
  images: ['reference_images', 'image_urls', 'images', 'image_refs', 'referenceImages', 'reference_image', 'image_url', 'first_frame', 'last_frame'],
  videos: ['reference_videos', 'video_urls', 'videos', 'video_refs', 'referenceVideos', 'reference_video', 'video_url'],
  audios: ['audio_urls', 'reference_audios', 'audios', 'audio_refs', 'referenceAudios', 'audio_url', 'reference_audio'],
} as const;

function countReferenceAssets(metadata: Record<string, any>) {
  const countFields = (fields: readonly string[]) => {
    const values = new Set<string>();
    for (const field of fields) {
      const candidate = metadata[field];
      const entries = Array.isArray(candidate) ? candidate : [candidate];
      for (const entry of entries) {
        if (typeof entry === 'string' && entry.trim()) values.add(entry);
      }
    }
    return values.size;
  };
  return {
    images: countFields(REFERENCE_ASSET_FIELDS.images),
    videos: countFields(REFERENCE_ASSET_FIELDS.videos),
    audios: countFields(REFERENCE_ASSET_FIELDS.audios),
  };
}

/**
 * Keep paginated video history responses small. Full inline reference media remains
 * available from GET /api/contents/:id when the user applies a history item.
 */
export function compactContentForList<T extends { metadata?: string | Record<string, any> | null }>(item: T): T {
  const sanitized = sanitizeContentRoutingForClient(item);
  let metadata: Record<string, any>;
  try {
    metadata = typeof sanitized.metadata === 'string'
      ? JSON.parse(sanitized.metadata || '{}')
      : { ...(sanitized.metadata || {}) };
  } catch {
    return sanitized;
  }

  const result = compactMetadataValue(metadata);
  if (result.omitted > 0) {
    result.value.listAssetsCompacted = true;
    result.value.omittedInlineAssetCount = result.omitted;
    result.value.referenceAssetCounts = countReferenceAssets(metadata);
  }

  return {
    ...sanitized,
    metadata: typeof sanitized.metadata === 'string' ? JSON.stringify(result.value) : result.value,
  };
}

/** Admin lists keep routing fields but defer large media to the existing detail endpoint. */
export function compactAdminContentForList<T extends {
  metadata?: string | Record<string, any> | null;
  resultText?: string | null;
}>(item: T): T {
  let metadata: Record<string, any>;
  try {
    metadata = typeof item.metadata === 'string'
      ? JSON.parse(item.metadata || '{}')
      : { ...(item.metadata || {}) };
  } catch {
    return item;
  }

  const result = compactMetadataValue(metadata);
  const compactResultText = typeof item.resultText === 'string'
    && item.resultText.length > MAX_LIST_MEDIA_STRING_LENGTH;
  if (result.omitted > 0) {
    result.value.listAssetsCompacted = true;
    result.value.omittedInlineAssetCount = result.omitted;
    result.value.referenceAssetCounts = countReferenceAssets(metadata);
  }
  if (compactResultText) result.value.listResultCompacted = true;

  return {
    ...item,
    resultText: compactResultText ? null : item.resultText,
    metadata: typeof item.metadata === 'string' ? JSON.stringify(result.value) : result.value,
  };
}

/** Audio payloads are stored as Base64 in resultText; lists only need the record summary. */
export function compactAudioContentForList<T extends {
  metadata?: string | Record<string, any> | null;
  resultText?: string | null;
}>(item: T): T {
  const compacted = compactContentForList(item);
  if (typeof compacted.resultText !== 'string'
    || (!/"audioBase64"\s*:/.test(compacted.resultText)
      && compacted.resultText.length <= MAX_LIST_MEDIA_STRING_LENGTH)) {
    return compacted;
  }

  let metadata: Record<string, any> = {};
  try {
    metadata = typeof compacted.metadata === 'string'
      ? JSON.parse(compacted.metadata || '{}')
      : { ...(compacted.metadata || {}) };
  } catch { /* keep an empty marker object */ }
  metadata.listResultCompacted = true;

  return {
    ...compacted,
    resultText: null,
    metadata: typeof compacted.metadata === 'string' ? JSON.stringify(metadata) : metadata,
  };
}

export class ContentService {
  /** Save generated content, materializing inline video references first. */
  static save(input: SaveContentInput): number {
    const persistedMetadata = input.type === 'video'
      ? materializeContentMetadataAssets(input.metadata).metadata
      : (input.metadata || {});
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
      metadata: JSON.stringify(persistedMetadata),
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

    return {
      items: items.map(item => {
        if (item.type === 'video') return compactContentForList(item);
        if (item.type === 'audio') return compactAudioContentForList(item);
        return sanitizeContentRoutingForClient(item);
      }),
      total,
      page,
      pageSize,
    };
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

  /** Materialize legacy inline video assets before returning a detail payload. */
  static materializeAssetsForContent<T extends ReturnType<typeof ContentService.getById>>(
    contentId: number,
    existingItem?: T,
  ): T {
    const item = (existingItem || this.getById(contentId)) as T;
    if (item.type !== 'video') return item;

    const materialized = materializeContentMetadataAssets(item.metadata);
    if (!materialized.changed) return item;

    const metadata = JSON.stringify(materialized.metadata);
    db.update(contents).set({ metadata }).where(eq(contents.id, contentId)).run();
    return { ...item, metadata } as T;
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

    return { items: items.map(compactAdminContentForList), total, page, pageSize };
  }
}
