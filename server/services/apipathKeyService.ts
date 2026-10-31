import { and, eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { apipathChannelKeys } from '../db/schema.js';
import { APIPATH_MODELS } from '../../shared/apipathModels.js';

export function apipathKeys(channelId: number) {
  return db.select().from(apipathChannelKeys).where(eq(apipathChannelKeys.channelId, channelId)).all();
}

/** Blank edits retain the current key; replacement retires it without breaking existing receipts. */
export function saveApipathKeys(channelId: number, data: any) {
  const values = (['image', 'video'] as const).map(kind => {
    const value = data[kind === 'image' ? 'apipathImageKey' : 'apipathVideoKey'];
    if (value !== undefined && typeof value !== 'string') throw { status: 400, message: '通联 API Key 必须为文本' };
    const apiKey = String(value || '').trim();
    if (apiKey.startsWith('****')) throw { status: 400, message: '请填写完整的通联 API Key，不能保存脱敏值' };
    return { kind, apiKey };
  });
  sqlite.transaction(() => {
    for (const { kind, apiKey } of values) {
      if (!apiKey) continue;
      const current = apipathKeys(channelId).find(k => k.kind === kind && k.status === 1);
      if (current?.apiKey === apiKey) continue;
      if (current) db.update(apipathChannelKeys).set({ status: 0 }).where(eq(apipathChannelKeys.id, current.id)).run();
      db.insert(apipathChannelKeys).values({ channelId, kind, apiKey }).run();
    }
  })();
}

export function apipathExecutions<T extends { id: number; apiKey: string; supportedModels: string[] }>(channel: T) {
  const keys = apipathKeys(channel.id);
  if (!keys.length) return [{ ...channel, apiKeyId: null as number | null }];
  return keys.filter(key => key.status === 1).map(key => ({
    ...channel, apiKey: key.apiKey, apiKeyId: key.id,
    supportedModels: channel.supportedModels.filter(id =>
      APIPATH_MODELS.some(model => model.id === id && model.kind === key.kind)
      && (JSON.parse(key.supportedModels) as string[]).includes(id)),
  }));
}

export function apipathKeyForReceipt(channelId: number, keyId: number) {
  return db.select().from(apipathChannelKeys).where(and(eq(apipathChannelKeys.channelId, channelId), eq(apipathChannelKeys.id, keyId))).get();
}
