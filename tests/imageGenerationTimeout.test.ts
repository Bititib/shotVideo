import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { DEFAULT_IMAGE_GENERATION_TIMEOUT_MS, imageGenerationTimeout } from '../server/services/imageGenerationTimeout.js';
import { migratePidoiImageTimeout } from '../server/db/imageTimeoutMigration.js';

describe('configurable image generation timeout', () => {
  it.each([undefined, null, {}, { timeout: 0 }, { timeout: -1 }, { timeout: 1.5 }, { timeout: 'invalid' }, { timeout: Infinity }, { timeout: 2_147_483_648 }])('defaults invalid or missing configuration to 15 minutes: %j', channel => {
    expect(imageGenerationTimeout(channel)).toBe(900_000);
  });
  it.each([60_000, 600_000, 900_000, 1_800_000])('honors an explicitly configured timeout of %i ms', timeout => {
    expect(imageGenerationTimeout({ timeout })).toBe(timeout);
  });
});

describe('Pidoi legacy timeout migration', () => {
  const create = () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT,label TEXT);
      CREATE TABLE channels(id INTEGER PRIMARY KEY,name TEXT,base_url TEXT,timeout INTEGER,updated_at TEXT);
      INSERT INTO channels VALUES
        (1,'Pidoi 图片渠道','https://pidoi.com',120000,NULL),
        (2,'备用图片','https://pidoi.com',180000,NULL),
        (3,'定制图片','https://pidoi.com',600000,NULL),
        (4,'Pidoi 视频渠道','https://pidoi.com',120000,NULL),
        (5,'其他图片','https://other.invalid',120000,NULL);`);
    return sqlite;
  };
  it('upgrades old image defaults without changing custom values or video/other channels', () => {
    const sqlite = create();
    try {
      expect(migratePidoiImageTimeout(sqlite)).toBe(2);
      expect(sqlite.prepare('SELECT timeout FROM channels ORDER BY id').all()).toEqual([
        { timeout: DEFAULT_IMAGE_GENERATION_TIMEOUT_MS }, { timeout: DEFAULT_IMAGE_GENERATION_TIMEOUT_MS },
        { timeout: 600_000 }, { timeout: 120_000 }, { timeout: 120_000 },
      ]);
    } finally { sqlite.close(); }
  });
  it('does not overwrite a later administrator edit on restart', () => {
    const sqlite = create();
    try {
      migratePidoiImageTimeout(sqlite);
      sqlite.prepare('UPDATE channels SET timeout=120000 WHERE id=1').run();
      expect(migratePidoiImageTimeout(sqlite)).toBe(0);
      expect(sqlite.prepare('SELECT timeout FROM channels WHERE id=1').get()).toEqual({ timeout: 120_000 });
    } finally { sqlite.close(); }
  });
});
