import type Database from 'better-sqlite3';
import { DEFAULT_TTS_CHARACTER_RATE } from '../../shared/tts.js';

/** Apply the requested tariff once; future administrator changes survive restarts. */
export function migrateTtsPricing(sqlite: Database.Database) {
  const key = 'migration_tts_price_1_per_1200_chars_v1';
  sqlite.transaction(() => {
    if (sqlite.prepare('SELECT key FROM settings WHERE key = ?').get(key)) return;
    const ttsIds = new Set<string>();
    for (const row of sqlite.prepare('SELECT model_id, capabilities FROM models').all() as any[]) {
      try { if (JSON.parse(row.capabilities || '[]').includes('tts')) ttsIds.add(row.model_id); } catch {}
    }
    for (const row of sqlite.prepare('SELECT id, model_pattern, extra_params FROM model_pricing').all() as any[]) {
      let extra: Record<string, unknown> = {};
      try { extra = JSON.parse(row.extra_params || '{}'); } catch {}
      if (!ttsIds.has(row.model_pattern) && extra?.category !== 'tts') continue;
      sqlite.prepare('UPDATE model_pricing SET billing_type = ?, input_price = ?, output_price = 0, extra_params = ? WHERE id = ?')
        .run('per_character', DEFAULT_TTS_CHARACTER_RATE, JSON.stringify({ ...extra, category: 'tts' }), row.id);
    }
    sqlite.prepare('INSERT INTO settings (key, value, label) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, label = excluded.label')
      .run('tts_rate', String(DEFAULT_TTS_CHARACTER_RATE), '语音合成单字费率（¥1/1200字，按实际字数）');
    sqlite.prepare('INSERT INTO settings (key, value, label) VALUES (?, ?, ?)').run(key, '1', 'TTS 每1200字1元价格迁移');
  })();
}
