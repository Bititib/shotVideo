import { sqlite } from '../db/index.js';
import type { ChatConversation, ChatTurn } from '../../shared/websiteChat.js';
import { reserveUserCharge } from './billingReservation.js';
import type { PricingSnapshot } from './pricingService.js';
import type { PreparedChatAttachment } from './websiteChatAttachments.js';

const replyDeadlineMs = 5 * 60_000;
const recoveryGraceMs = 60_000;
const contextLimitBytes = 120_000;
const turnFields = `id, model, question, answer, status, error,
  (SELECT json_group_array(json_object('name', json_extract(value, '$.name'), 'kind', json_extract(value, '$.kind')))
   FROM json_each(attachments)) AS attachmentMetadata`;
type ChatTurnRow = Omit<ChatTurn, 'attachments'> & { attachmentMetadata: string };

function publicTurn({ attachmentMetadata, ...turn }: ChatTurnRow): ChatTurn {
  const attachments = JSON.parse(attachmentMetadata);
  return attachments.length ? { ...turn, attachments } : turn;
}

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS website_chat_conversations (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS website_chat_owner ON website_chat_conversations(user_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS website_chat_turns (
    conversation_id TEXT NOT NULL REFERENCES website_chat_conversations(id) ON DELETE CASCADE,
    id TEXT NOT NULL, model TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL, error TEXT, deadline INTEGER NOT NULL, reservation_id TEXT,
    PRIMARY KEY (conversation_id, id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS website_chat_one_active ON website_chat_turns(conversation_id) WHERE status = 'running';
`);
sqlite.transaction(() => {
  if (!(sqlite.pragma('table_info(website_chat_turns)') as Array<{ name: string }>).some(column => column.name === 'attachments')) {
    sqlite.exec("ALTER TABLE website_chat_turns ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
  }
}).immediate();

function chatError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function requireConversation(userId: number, id: string) {
  const row = sqlite.prepare('SELECT id FROM website_chat_conversations WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, userId);
  if (!row) throw chatError(404, '对话不存在');
}

const expireTurn = sqlite.transaction((id: string) => {
  const expired = sqlite.prepare(`UPDATE website_chat_turns SET
      status = CASE WHEN reservation_id IS NULL THEN 'failed' ELSE 'review' END,
      error = CASE WHEN reservation_id IS NULL THEN ? ELSE ? END
    WHERE conversation_id = ? AND status = 'running' AND deadline < ? RETURNING reservation_id`)
    .get('对话请求在提交前中断', '对话请求已中断，原请求结果待核实', id, Date.now() - recoveryGraceMs) as { reservation_id: string | null } | undefined;
  if (expired?.reservation_id) {
    sqlite.prepare("UPDATE billing_reservations SET state = 'review' WHERE id = ? AND state = 'reserved'").run(expired.reservation_id);
  }
});

export const reserveChatTurn = sqlite.transaction((userId: number, id: string, requestId: string, cost: number, model: string, pricingSnapshot?: PricingSnapshot) => {
  const reservation = reserveUserCharge(userId, cost, 'website_chat', { model, pricingSnapshot, chatConversationId: id, chatRequestId: requestId });
  const record = sqlite.prepare(`UPDATE website_chat_turns SET reservation_id = ?
    WHERE conversation_id = ? AND id = ? AND status = 'running' AND deadline > ? AND reservation_id IS NULL`)
    .run(reservation.id, id, requestId, Date.now());
  if (!record.changes) throw chatError(409, '原请求已处理或超过提交时限');
  return reservation;
});

function getTurns(id: string) {
  return (sqlite.prepare(`SELECT ${turnFields} FROM website_chat_turns WHERE conversation_id = ? ORDER BY rowid`).all(id) as ChatTurnRow[]).map(publicTurn);
}

export function listChatConversations(userId: number) {
  return sqlite.prepare(`SELECT id, title, updated_at AS updatedAt FROM website_chat_conversations
    WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC`).all(userId) as ChatConversation[];
}

export function listChatTurns(userId: number, id: string) {
  requireConversation(userId, id);
  expireTurn(id);
  return getTurns(id);
}

export const deleteChatConversation = sqlite.transaction((userId: number, id: string) => {
  const turns = listChatTurns(userId, id);
  if (turns.some(turn => turn.status === 'running')) throw chatError(409, '请等当前回复结束后再删除对话');
  sqlite.prepare('DELETE FROM website_chat_turns WHERE conversation_id = ?').run(id);
  sqlite.prepare("UPDATE website_chat_conversations SET deleted_at = ?, title = '' WHERE id = ? AND user_id = ?")
    .run(Date.now(), id, userId);
});

type ChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export const claimChatTurn = sqlite.transaction((userId: number, id: string, requestId: string, model: string, question: string, create: boolean,
  attachments: PreparedChatAttachment[], imageInput: boolean) => {
  const now = Date.now();
  if (create) {
    sqlite.prepare(`INSERT OR IGNORE INTO website_chat_conversations (id, user_id, title, updated_at) VALUES (?, ?, ?, ?)`)
      .run(id, userId, [...(question || attachments[0]?.name || '新对话').replace(/\s+/g, ' ')].slice(0, 48).join(''), now);
  }
  const turns = listChatTurns(userId, id);
  const existing = turns.find(turn => turn.id === requestId);
  if (existing) {
    const { attachments: raw } = sqlite.prepare('SELECT attachments FROM website_chat_turns WHERE conversation_id = ? AND id = ?')
      .get(id, requestId) as { attachments: string };
    const saved = JSON.parse(raw) as PreparedChatAttachment[];
    if (existing.model !== model || existing.question !== question || saved.length !== attachments.length ||
      saved.some((item, i) => item.digest !== attachments[i].digest || item.name !== attachments[i].name)) {
      throw chatError(409, '请求编号已用于另一条消息');
    }
    return { existing } as const;
  }
  if (turns.some(turn => turn.status === 'running')) throw chatError(409, '当前对话正在回复');
  const messages: Array<{ role: 'user' | 'assistant'; content: string | ChatPart[] }> = [];
  const getAttachments = sqlite.prepare('SELECT attachments FROM website_chat_turns WHERE conversation_id = ? AND id = ?');
  let imageCount = 0;
  let imageBytes = 0;
  const appendUser = (question: string, files: PreparedChatAttachment[]) => {
    const documents = files.filter(file => file.kind === 'document');
    const text = [question || '请阅读并概述附件。', ...documents.map(file =>
      `［附件 ${file.name} 的正文开始］\n${file.content}\n［附件正文结束］`)].join('\n\n');
    const images = files.filter(file => file.kind === 'image');
    imageCount += images.length;
    imageBytes += images.reduce((size, file) => size + file.content.length, 0);
    messages.push({ role: 'user', content: images.length ? [{ type: 'text', text }, ...images.map(file =>
      ({ type: 'image_url' as const, image_url: { url: file.content } }))] : text });
  };
  for (const turn of turns) {
    if (turn.status !== 'complete') continue;
    const files = turn.attachments?.length ? JSON.parse((getAttachments.get(id, turn.id) as { attachments: string }).attachments) : [];
    appendUser(turn.question, files);
    messages.push({ role: 'assistant', content: turn.answer });
  }
  appendUser(question, attachments);
  if (imageCount && !imageInput) throw chatError(400, '这段对话含有图片，请切换到支持看图的模型');
  if (imageCount > 6 || imageBytes > 16 * 1024 * 1024) throw chatError(400, '此对话的图片已超过上下文上限，请开启新对话');
  if (Buffer.byteLength(JSON.stringify(messages, (key, value) => key === 'url' ? undefined : value)) > contextLimitBytes) {
    throw chatError(400, '此对话已超过网页上下文长度上限，请开启新对话');
  }
  const deadline = now + replyDeadlineMs;
  sqlite.prepare(`INSERT INTO website_chat_turns (conversation_id, id, model, question, status, deadline, attachments)
    VALUES (?, ?, ?, ?, 'running', ?, ?)`).run(id, requestId, model, question, deadline, JSON.stringify(attachments));
  sqlite.prepare('UPDATE website_chat_conversations SET updated_at = ? WHERE id = ?').run(now, id);
  return { deadline, messages, imageCount } as const;
});

export function saveChatAnswer(id: string, requestId: string, answer: string) {
  sqlite.prepare(`UPDATE website_chat_turns SET answer = ? WHERE conversation_id = ? AND id = ? AND status = 'running'`)
    .run(answer, id, requestId);
}

export function finishChatTurn(id: string, requestId: string, answer: string, status: Exclude<ChatTurn['status'], 'running'>, error?: string) {
  const row = sqlite.prepare(`UPDATE website_chat_turns SET answer = ?, status = ?, error = ?
    WHERE conversation_id = ? AND id = ? AND status = 'running' RETURNING ${turnFields}`)
    .get(answer, status, error || null, id, requestId) as ChatTurnRow | undefined;
  return row && publicTurn(row);
}
