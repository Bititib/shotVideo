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

export const db = drizzle(sqlite, { schema });
export { sqlite };
