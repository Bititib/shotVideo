import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { channelApiKeys, channels, settings } from '../db/schema.js';
import { isRetiredGeminiEndpoint, normalizeGeminiBaseUrl } from './geminiEndpoint.js';

export const GEMINI_POOL_CHANNEL_NAME = 'Gemini 免费层 Key 池';
export const GEMINI_OFFICIAL_BASE_URL = 'https://generativelanguage.googleapis.com';
export const GEMINI_POOL_META_KEY = 'gemini_key_pool_meta_v1';
const DEFAULT_FREE_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.5-flash-preview-tts',
];

export type GeminiKeyMeta = {
  label?: string;
  lastCheckedAt?: string;
  lastStatus?: 'ok' | 'rate_limited' | 'invalid' | 'error';
  lastMessage?: string;
  lastLatencyMs?: number;
  modelCount?: number;
};

const keyCooldowns = new Map<number, number>();
let roundRobinCursor = 0;

export function clearGeminiKeyCooldownsForTest() {
  keyCooldowns.clear();
  roundRobinCursor = 0;
}

export function markGeminiKeyRateLimited(keyId: number | null | undefined, cooldownMs = 60_000) {
  if (!keyId) return;
  keyCooldowns.set(keyId, Date.now() + cooldownMs);
}

export function maskGeminiKey(raw: string): string {
  const s = String(raw || '').trim();
  if (s.length <= 10) return s ? `${s.slice(0, 3)}***` : '';
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

export function redactGeminiSecret(text: string, secret: string): string {
  if (!secret) return text;
  return String(text || '').split(secret).join('[密钥已隐藏]');
}

function isValidGeminiKeyFormat(raw: string): boolean {
  return /^(AIza|AQ\.)[A-Za-z0-9._-]{16,200}$/.test(raw.trim());
}

function readPoolMeta(): Record<string, GeminiKeyMeta> {
  try {
    const row = db.select().from(settings).where(eq(settings.key, GEMINI_POOL_META_KEY)).get();
    if (!row?.value) return {};
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writePoolMeta(meta: Record<string, GeminiKeyMeta>) {
  const now = new Date().toISOString();
  db.insert(settings).values({
    key: GEMINI_POOL_META_KEY,
    value: JSON.stringify(meta),
    label: 'Gemini Key 池状态元数据',
    updatedAt: now,
  }).onConflictDoUpdate({
    target: settings.key,
    set: { value: JSON.stringify(meta), updatedAt: now },
  }).run();
}

export function findPrimaryGeminiChannel() {
  const all = db.select().from(channels).where(eq(channels.type, 'gemini')).all()
    .filter(c => !isRetiredGeminiEndpoint(c.name, c.baseUrl))
    .sort((a, b) => (b.status - a.status) || (a.priority - b.priority) || (a.id - b.id));
  return all[0] || null;
}

export function getOrCreateGeminiPoolChannel(customBaseUrl?: string) {
  const existing = findPrimaryGeminiChannel();
  if (existing) {
    if (customBaseUrl) {
      const normalized = normalizeGeminiBaseUrl(customBaseUrl);
      if (normalized && !isRetiredGeminiEndpoint('', normalized) && normalized !== normalizeGeminiBaseUrl(existing.baseUrl)) {
        db.update(channels).set({ baseUrl: normalized, updatedAt: new Date().toISOString() }).where(eq(channels.id, existing.id)).run();
        return db.select().from(channels).where(eq(channels.id, existing.id)).get()!;
      }
    }
    return existing;
  }

  const baseUrl = normalizeGeminiBaseUrl(customBaseUrl || GEMINI_OFFICIAL_BASE_URL) || GEMINI_OFFICIAL_BASE_URL;
  if (isRetiredGeminiEndpoint('', baseUrl)) {
    throw Object.assign(new Error('禁止使用已下线的 AIStudio2API 地址'), { status: 400 });
  }
  const mapping = Object.fromEntries(DEFAULT_FREE_MODELS.map(m => [m, m]));
  const result = db.insert(channels).values({
    name: GEMINI_POOL_CHANNEL_NAME,
    type: 'gemini',
    baseUrl,
    apiKey: '',
    modelMapping: JSON.stringify(mapping),
    supportedModels: JSON.stringify(DEFAULT_FREE_MODELS),
    status: 1,
    priority: 0,
    weight: 100,
    maxRetries: 1,
    timeout: 30_000,
  }).run();
  return db.select().from(channels).where(eq(channels.id, Number(result.lastInsertRowid))).get()!;
}

/** 将 channel_api_keys 中首个启用 Key 同步到 channels.api_key，供仅读主表的模块兼容使用。 */
export function syncChannelPrimaryApiKey(channelId: number) {
  const keys = db.select().from(channelApiKeys)
    .where(and(eq(channelApiKeys.channelId, channelId), eq(channelApiKeys.status, 1)))
    .all()
    .sort((a, b) => a.id - b.id);
  const nextKey = keys[0]?.apiKey || '';
  db.update(channels).set({ apiKey: nextKey, updatedAt: new Date().toISOString() })
    .where(eq(channels.id, channelId)).run();
}

/** 返回某个 gemini 渠道当前所有可用的密钥列表（已做轮转且跳过 429 冷却中 Key）。 */
export function getRotatableGeminiKeysForChannel(channelId: number, fallbackApiKey?: string | null): Array<{ id: number | null; apiKey: string }> {
  const poolRows = db.select().from(channelApiKeys)
    .where(and(eq(channelApiKeys.channelId, channelId), eq(channelApiKeys.status, 1)))
    .all()
    .sort((a, b) => a.id - b.id);

  const candidates: Array<{ id: number | null; apiKey: string }> = poolRows.map(r => ({ id: r.id, apiKey: r.apiKey }));
  if (fallbackApiKey?.trim() && !candidates.some(c => c.apiKey === fallbackApiKey.trim())) {
    candidates.push({ id: null, apiKey: fallbackApiKey.trim() });
  }
  if (!candidates.length) return [];

  const now = Date.now();
  const healthy = candidates.filter(c => c.id === null || (keyCooldowns.get(c.id) || 0) <= now);
  const list = healthy.length > 0 ? healthy : candidates;
  const offset = roundRobinCursor++ % list.length;
  return [...list.slice(offset), ...list.slice(0, offset)];
}

export function listGeminiKeys() {
  const channel = findPrimaryGeminiChannel();
  if (!channel) {
    return {
      channel: null,
      keys: [],
      stats: { total: 0, active: 0, coolingDown: 0, invalid: 0 },
    };
  }
  const rows = db.select().from(channelApiKeys)
    .where(eq(channelApiKeys.channelId, channel.id))
    .all()
    .sort((a, b) => a.id - b.id);
  const meta = readPoolMeta();
  const now = Date.now();

  const keys = rows.map(row => {
    const m = meta[String(row.id)] || {};
    const cooldownUntil = keyCooldowns.get(row.id) || 0;
    const cooldownSecondsLeft = cooldownUntil > now ? Math.ceil((cooldownUntil - now) / 1000) : 0;
    return {
      id: row.id,
      channelId: row.channelId,
      maskedKey: maskGeminiKey(row.apiKey),
      status: row.status,
      label: m.label || '',
      inCooldown: cooldownSecondsLeft > 0,
      cooldownSecondsLeft,
      lastCheckedAt: m.lastCheckedAt || null,
      lastStatus: m.lastStatus || null,
      lastMessage: m.lastMessage || '',
      lastLatencyMs: m.lastLatencyMs ?? null,
      modelCount: m.modelCount ?? null,
      createdAt: row.createdAt,
    };
  });

  return {
    channel: {
      id: channel.id,
      name: channel.name,
      baseUrl: normalizeGeminiBaseUrl(channel.baseUrl),
      status: channel.status,
      supportedModels: (() => { try { return JSON.parse(channel.supportedModels); } catch { return []; } })(),
    },
    keys,
    stats: {
      total: keys.length,
      active: keys.filter(k => k.status === 1 && !k.inCooldown).length,
      coolingDown: keys.filter(k => k.inCooldown).length,
      invalid: keys.filter(k => k.lastStatus === 'invalid').length,
    },
  };
}

export function addGeminiKeys(entries: Array<{ apiKey: string; label?: string }>, customBaseUrl?: string) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw Object.assign(new Error('请提供至少一个 Gemini API Key'), { status: 400 });
  }
  const channel = getOrCreateGeminiPoolChannel(customBaseUrl);
  const meta = readPoolMeta();
  let added = 0;
  let skipped = 0;
  const invalid: string[] = [];

  for (const entry of entries) {
    const cleanKey = String(entry?.apiKey || '').trim();
    if (!cleanKey) continue;
    if (!isValidGeminiKeyFormat(cleanKey)) {
      invalid.push(maskGeminiKey(cleanKey) || '(空)');
      continue;
    }
    const existing = db.select().from(channelApiKeys).where(eq(channelApiKeys.apiKey, cleanKey)).get();
    if (existing) {
      skipped++;
      continue;
    }
    const inserted = db.insert(channelApiKeys).values({
      channelId: channel.id,
      apiKey: cleanKey,
      concurrencyLimit: 5,
      status: 1,
    }).run();
    const id = Number(inserted.lastInsertRowid);
    if (entry.label?.trim()) {
      meta[String(id)] = { ...(meta[String(id)] || {}), label: entry.label.trim().slice(0, 80) };
    }
    added++;
  }

  writePoolMeta(meta);
  syncChannelPrimaryApiKey(channel.id);
  return { added, skipped, invalid, pool: listGeminiKeys() };
}

export function updateGeminiKey(id: number, patch: { status?: number; label?: string }) {
  const row = db.select().from(channelApiKeys).where(eq(channelApiKeys.id, id)).get();
  if (!row) throw Object.assign(new Error('Key 不存在'), { status: 404 });

  if (patch.status !== undefined) {
    const nextStatus = patch.status === 1 ? 1 : 0;
    db.update(channelApiKeys).set({ status: nextStatus, updatedAt: new Date().toISOString() })
      .where(eq(channelApiKeys.id, id)).run();
    if (nextStatus === 1) keyCooldowns.delete(id);
  }
  if (patch.label !== undefined) {
    const meta = readPoolMeta();
    meta[String(id)] = { ...(meta[String(id)] || {}), label: String(patch.label || '').trim().slice(0, 80) };
    writePoolMeta(meta);
  }
  syncChannelPrimaryApiKey(row.channelId);
  return listGeminiKeys();
}

export function deleteGeminiKey(id: number) {
  const row = db.select().from(channelApiKeys).where(eq(channelApiKeys.id, id)).get();
  if (!row) throw Object.assign(new Error('Key 不存在'), { status: 404 });

  db.delete(channelApiKeys).where(eq(channelApiKeys.id, id)).run();
  keyCooldowns.delete(id);
  const meta = readPoolMeta();
  delete meta[String(id)];
  writePoolMeta(meta);
  syncChannelPrimaryApiKey(row.channelId);
  return listGeminiKeys();
}

export async function testGeminiKey(id: number, fetchImpl: typeof fetch = fetch) {
  const row = db.select().from(channelApiKeys).where(eq(channelApiKeys.id, id)).get();
  if (!row) throw Object.assign(new Error('Key 不存在'), { status: 404 });
  const channel = db.select().from(channels).where(eq(channels.id, row.channelId)).get();
  const baseUrl = normalizeGeminiBaseUrl(channel?.baseUrl || GEMINI_OFFICIAL_BASE_URL) || GEMINI_OFFICIAL_BASE_URL;
  if (isRetiredGeminiEndpoint(channel?.name, baseUrl)) {
    throw Object.assign(new Error('已拒绝测试退市代理地址'), { status: 400 });
  }

  const start = Date.now();
  const meta = readPoolMeta();
  const prev = meta[String(id)] || {};
  try {
    const res = await fetchImpl(`${baseUrl}/v1beta/models?pageSize=200`, {
      headers: { 'x-goog-api-key': row.apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    const latencyMs = Date.now() - start;
    const raw = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(raw); } catch {}

    if (res.ok && Array.isArray(parsed?.models)) {
      keyCooldowns.delete(id);
      meta[String(id)] = {
        ...prev,
        lastCheckedAt: new Date().toISOString(),
        lastStatus: 'ok',
        lastMessage: `可用（发现 ${parsed.models.length} 个模型，${latencyMs}ms）`,
        lastLatencyMs: latencyMs,
        modelCount: parsed.models.length,
      };
      writePoolMeta(meta);
      return { ok: true, status: 'ok', latencyMs, modelCount: parsed.models.length, message: meta[String(id)].lastMessage };
    }

    const rawMsg = parsed?.error?.message || `HTTP ${res.status}`;
    const safeMsg = redactGeminiSecret(rawMsg, row.apiKey).slice(0, 200);
    const statusKind: GeminiKeyMeta['lastStatus'] = res.status === 429
      ? 'rate_limited'
      : (res.status === 400 || res.status === 401 || res.status === 403) ? 'invalid' : 'error';
    if (statusKind === 'rate_limited') markGeminiKeyRateLimited(id, 60_000);

    meta[String(id)] = {
      ...prev,
      lastCheckedAt: new Date().toISOString(),
      lastStatus: statusKind,
      lastMessage: safeMsg,
      lastLatencyMs: latencyMs,
    };
    writePoolMeta(meta);
    return { ok: false, status: statusKind, latencyMs, message: safeMsg };
  } catch (error: any) {
    const latencyMs = Date.now() - start;
    const safeMsg = redactGeminiSecret(error?.message || '网络异常', row.apiKey).slice(0, 200);
    meta[String(id)] = {
      ...prev,
      lastCheckedAt: new Date().toISOString(),
      lastStatus: 'error',
      lastMessage: safeMsg,
      lastLatencyMs: latencyMs,
    };
    writePoolMeta(meta);
    return { ok: false, status: 'error', latencyMs, message: safeMsg };
  }
}

export async function testAllGeminiKeys(fetchImpl: typeof fetch = fetch) {
  const pool = listGeminiKeys();
  for (const k of pool.keys) {
    if (k.status === 1) await testGeminiKey(k.id, fetchImpl);
  }
  return listGeminiKeys();
}
