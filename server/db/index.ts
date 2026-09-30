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

try {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS comic_drama_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, org_id INTEGER,
      title TEXT NOT NULL DEFAULT '未命名漫剧', script TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned', blueprint TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_comic_projects_user ON comic_drama_projects(user_id, updated_at);
    CREATE TABLE IF NOT EXISTS comic_drama_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      episode_number INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '未命名剧集', script TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', blueprint TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, episode_number)
    );
    CREATE INDEX IF NOT EXISTS idx_comic_episodes_project ON comic_drama_episodes(project_id, episode_number);
    CREATE TABLE IF NOT EXISTS comic_drama_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, episode_id INTEGER, user_id INTEGER NOT NULL,
      kind TEXT NOT NULL, entity_key TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', payload TEXT NOT NULL DEFAULT '{}', result_url TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, quality_score INTEGER, quality_report TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_comic_tasks_status ON comic_drama_tasks(status, sort_order);
  `);

  const taskColumns = sqlite.pragma('table_info(comic_drama_tasks)') as any[];
  if (!taskColumns.some(column => column.name === 'episode_id')) {
    sqlite.exec('ALTER TABLE comic_drama_tasks ADD COLUMN episode_id INTEGER');
  }
  sqlite.exec('DROP INDEX IF EXISTS idx_comic_tasks_entity');
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_comic_tasks_episode_entity ON comic_drama_tasks(project_id, episode_id, kind, entity_key)');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_comic_tasks_episode ON comic_drama_tasks(episode_id, status, sort_order)');

  // 无损兼容旧项目：把原项目级剧本、蓝图和任务归入第 1 集。
  sqlite.exec(`
    INSERT OR IGNORE INTO comic_drama_episodes
      (project_id, user_id, episode_number, title, script, status, blueprint, state, created_at, updated_at)
    SELECT id, user_id, 1, '第1集', script, status, blueprint, state, created_at, updated_at
    FROM comic_drama_projects;
    UPDATE comic_drama_tasks
    SET episode_id = (
      SELECT episode.id FROM comic_drama_episodes episode
      WHERE episode.project_id = comic_drama_tasks.project_id AND episode.episode_number = 1
    )
    WHERE episode_id IS NULL;
  `);
} catch (e) { console.error('[comic-drama] 初始化项目表失败:', e); }

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
