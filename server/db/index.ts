import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import path from 'path';
import fs from 'fs';
import * as schema from './schema.js';

const dataDir = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'app.db');
const sqlite = new Database(dbPath);

// 开启 WAL 模式提升并发性能
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

// 自动向旧表补充可能缺失的列 (如 status / description)
try {
  const usageLogsCols = sqlite.pragma('table_info(usage_logs)') as any[];
  if (Array.isArray(usageLogsCols) && usageLogsCols.length > 0) {
    if (!usageLogsCols.some((c: any) => c.name === 'status')) {
      sqlite.exec("ALTER TABLE usage_logs ADD COLUMN status TEXT NOT NULL DEFAULT 'success'");
    }
  }
} catch (e) {}

try {
  const modelsCols = sqlite.pragma('table_info(models)') as any[];
  if (Array.isArray(modelsCols) && modelsCols.length > 0) {
    if (!modelsCols.some((c: any) => c.name === 'description')) {
      sqlite.exec("ALTER TABLE models ADD COLUMN description TEXT");
    }
  }
} catch (e) {}

try {
  const channelCols = sqlite.pragma('table_info(channels)') as any[];
  if (Array.isArray(channelCols) && channelCols.length > 0) {
    if (!channelCols.some((c: any) => c.name === 'concurrency_limit')) {
      const fallback = Number.parseInt(process.env.HM_STUDIO_CONCURRENCY || '10', 10);
      const defaultLimit = Number.isInteger(fallback) && fallback > 0 ? fallback : 10;
      sqlite.exec(`ALTER TABLE channels ADD COLUMN concurrency_limit INTEGER NOT NULL DEFAULT ${defaultLimit}`);
    }
    if (!channelCols.some((c: any) => c.name === 'face_split_enabled')) {
      sqlite.exec("ALTER TABLE channels ADD COLUMN face_split_enabled INTEGER NOT NULL DEFAULT 0");
      sqlite.exec("UPDATE channels SET face_split_enabled = 1 WHERE type = 'wx-haidiyue'");
    }
  }
} catch (e) {}

// HM Studio 密钥从渠道主表拆分为一对多子表。保留 channels.api_key 仅用于
// 兼容旧数据，启动时会把旧密钥无损迁移到新表。
try {
  const fallback = Number.parseInt(process.env.HM_STUDIO_CONCURRENCY || '10', 10);
  const defaultLimit = Number.isInteger(fallback) && fallback > 0 ? fallback : 10;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS channel_api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      api_key TEXT NOT NULL UNIQUE,
      concurrency_limit INTEGER NOT NULL DEFAULT ${defaultLimit},
      status INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_channel_api_keys_channel_id ON channel_api_keys(channel_id);
  `);
  const channelCols = sqlite.pragma('table_info(channels)') as any[];
  if (Array.isArray(channelCols) && channelCols.some((column: any) => column.name === 'api_key')) {
    sqlite.exec(`
      INSERT OR IGNORE INTO channel_api_keys (channel_id, api_key, concurrency_limit, status)
      SELECT id, api_key, COALESCE(concurrency_limit, ${defaultLimit}), status
      FROM channels
      WHERE type = 'hmstudio' AND TRIM(api_key) <> '';
    `);
  }
} catch (e) {}

export const db = drizzle(sqlite, { schema });
export { sqlite };
