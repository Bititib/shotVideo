import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const sqlite = new Database(':memory:');
  return { sqlite, db: drizzle(sqlite) };
});
import { db } from '../server/db/index';
import { initDatabase } from '../server/db/seed';
import { channelApiKeys, channels, models, settings } from '../server/db/schema';
import { eq } from 'drizzle-orm';
import {
  addGeminiKeys,
  clearGeminiKeyCooldownsForTest,
  deleteGeminiKey,
  getRotatableGeminiKeysForChannel,
  listGeminiKeys,
  testGeminiKey,
  updateGeminiKey,
} from '../server/services/geminiKeyPool';
import { ChannelService } from '../server/services/channelService';
import { AIService } from '../server/services/aiService';

function cleanupPool() {
  clearGeminiKeyCooldownsForTest();
  const gemChannels = db.select().from(channels).where(eq(channels.type, 'gemini')).all();
  for (const ch of gemChannels) {
    db.delete(channelApiKeys).where(eq(channelApiKeys.channelId, ch.id)).run();
    db.delete(channels).where(eq(channels.id, ch.id)).run();
  }
  db.delete(settings).where(eq(settings.key, 'gemini_key_pool_meta_v1')).run();
}

beforeAll(async () => { await initDatabase(); });
beforeEach(() => { cleanupPool(); });
afterEach(() => { vi.unstubAllGlobals(); cleanupPool(); });

describe('Gemini Free-Tier Multi-Key Pool & Native Channel Sync', () => {
  it('adds multiple keys, deduplicates, rejects malformed keys, masks output, and syncs primary channel key', () => {
    const res = addGeminiKeys([
      { apiKey: 'AQ.Ab8RN6TestKeyOne_1234567890', label: '账号A-项目1' },
      { apiKey: 'AIzaSyTestKeyTwo_1234567890abcd', label: '账号B-项目1' },
      { apiKey: 'AQ.Ab8RN6TestKeyOne_1234567890', label: '重复Key' },
      { apiKey: 'bad-key', label: '非法格式' },
    ]);

    expect(res.added).toBe(2);
    expect(res.skipped).toBe(1);
    expect(res.invalid).toHaveLength(1);
    expect(res.pool.channel?.baseUrl).toBe('https://generativelanguage.googleapis.com');
    expect(res.pool.keys).toHaveLength(2);
    expect(res.pool.keys[0].maskedKey).toBe('AQ.Ab8...7890');
    expect(res.pool.keys[0].label).toBe('账号A-项目1');
    expect((res.pool.keys[0] as any).apiKey).toBeUndefined();

    // Toggling off key 1 updates primary key on channels row to key 2
    const afterDisable = updateGeminiKey(res.pool.keys[0].id, { status: 0, label: '已暂停' });
    expect(afterDisable.stats.active).toBe(1);
    const ch = db.select().from(channels).where(eq(channels.id, res.pool.channel!.id)).get();
    expect(ch?.apiKey).toBe('AIzaSyTestKeyTwo_1234567890abcd');

    // Delete key 2 -> primary key becomes empty
    const afterDelete = deleteGeminiKey(res.pool.keys[1].id);
    expect(afterDelete.keys).toHaveLength(1);
  });

  it('rotates round-robin across active keys and automatically fails over on 429 without replaying 500s', async () => {
    const { pool } = addGeminiKeys([
      { apiKey: 'AQ.Ab8RN6KeyOne_1234567890abcdef', label: '项目1' },
      { apiKey: 'AIzaSyKeyTwo_1234567890abcdefg', label: '项目2' },
    ]);
    const chId = pool.channel!.id;

    // Round-robin rotation check
    const firstOrder = getRotatableGeminiKeysForChannel(chId);
    const secondOrder = getRotatableGeminiKeysForChannel(chId);
    expect(firstOrder[0].apiKey).not.toBe(secondOrder[0].apiKey);

    clearGeminiKeyCooldownsForTest();
    const usedKeys: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: any) => {
      const usedKey = init.headers['x-goog-api-key'];
      usedKeys.push(usedKey);
      if (usedKey === 'AQ.Ab8RN6KeyOne_1234567890abcdef') {
        return Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }, { status: 429 });
      }
      return Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await AIService.callGenerateContent('gemini-2.5-flash', { contents: [] });
    expect(out.candidates[0].content.parts[0].text).toBe('ok');
    expect(usedKeys).toEqual(['AQ.Ab8RN6KeyOne_1234567890abcdef', 'AIzaSyKeyTwo_1234567890abcdefg']);

    // Key 1 is now in 429 cooldown
    const refreshed = listGeminiKeys();
    expect(refreshed.stats.coolingDown).toBe(1);
    expect(refreshed.keys[0].inCooldown).toBe(true);

    // Non-429 500 error must NOT fail over / replay
    fetchMock.mockReset().mockResolvedValue(Response.json({ error: { code: 500, status: 'INTERNAL', message: 'boom' } }, { status: 500 }));
    await expect(AIService.callGenerateContent('gemini-2.5-flash', { contents: [] })).rejects.toMatchObject({ upstreamStatus: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tests individual keys with key redaction and syncs native /v1beta/models cleanly', async () => {
    const { pool } = addGeminiKeys([{ apiKey: 'AQ.Ab8RN6TestKeyHealth_1234567890', label: '健康检查' }]);
    const keyId = pool.keys[0].id;
    const chId = pool.channel!.id;

    const okResult = await testGeminiKey(keyId, async (url: any, init: any) => {
      expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200');
      expect(init.headers['x-goog-api-key']).toBe('AQ.Ab8RN6TestKeyHealth_1234567890');
      return Response.json({ models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] });
    });
    expect(okResult.ok).toBe(true);
    expect(okResult.modelCount).toBe(1);

    const badResult = await testGeminiKey(keyId, async () =>
      Response.json({ error: { message: 'API key invalid: AQ.Ab8RN6TestKeyHealth_1234567890' } }, { status: 400 }),
    );
    expect(badResult.ok).toBe(false);
    expect(badResult.status).toBe('invalid');
    expect(badResult.message).not.toContain('AQ.Ab8RN6TestKeyHealth_1234567890');
    expect(badResult.message).toContain('[密钥已隐藏]');

    // ChannelService.testChannel & syncModels work with native /v1beta/models + x-goog-api-key
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({
      models: [
        { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash-preview-tts', displayName: 'Gemini 2.5 Flash TTS', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      ],
    })));
    const chTest = await ChannelService.testChannel(chId);
    expect(chTest.success).toBe(true);
    const synced = await ChannelService.syncModels(chId);
    expect(synced.models).toEqual(['gemini-2.5-flash', 'gemini-2.5-flash-preview-tts']);
    const ttsModel = db.select().from(models).where(eq(models.modelId, 'gemini-2.5-flash-preview-tts')).get();
    expect(ttsModel?.capabilities).toBe('["tts"]');
  });
});
