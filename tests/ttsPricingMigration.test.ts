import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { migrateTtsPricing } from '../server/db/ttsPricingMigration';
import { DEFAULT_TTS_CHARACTER_RATE, ttsPriceLabel } from '../shared/tts';

it('updates existing TTS prices once, preserves other prices and later admin edits', () => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.exec(`CREATE TABLE settings (key TEXT UNIQUE, value TEXT, label TEXT);
      CREATE TABLE models (model_id TEXT, capabilities TEXT);
      CREATE TABLE model_pricing (id INTEGER PRIMARY KEY, model_pattern TEXT, billing_type TEXT, input_price REAL, output_price REAL, extra_params TEXT);
      INSERT INTO settings VALUES ('tts_rate','0.01','old');
      INSERT INTO models VALUES ('flash-tts','["tts"]'),('pro-tts','["tts"]'),('image','["image_gen"]');
      INSERT INTO model_pricing VALUES (1,'flash-tts','per_character',0.01,0,'{}'),(2,'pro-tts','per_character',0.02,0,'{}'),(3,'image','per_call',0.8,0,'{}');`);
    migrateTtsPricing(sqlite);
    const rows = sqlite.prepare('SELECT input_price FROM model_pricing ORDER BY id').all() as any[];
    expect(rows.map(r => r.input_price)).toEqual([DEFAULT_TTS_CHARACTER_RATE, DEFAULT_TTS_CHARACTER_RATE, 0.8]);
    expect(rows[0].input_price * 1200).toBeCloseTo(1);
    expect(rows[0].input_price * 600).toBeCloseTo(0.5);
    expect(rows[0].input_price * 2400).toBeCloseTo(2);
    expect(ttsPriceLabel(rows[0].input_price)).toBe('¥1/1200字');
    sqlite.exec('UPDATE model_pricing SET input_price=0.002 WHERE id=1');
    migrateTtsPricing(sqlite);
    expect((sqlite.prepare('SELECT input_price FROM model_pricing WHERE id=1').get() as any).input_price).toBe(0.002);
  } finally { sqlite.close(); }
});
