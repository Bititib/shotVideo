import type Database from 'better-sqlite3';
const initialized = new WeakSet<object>();

/** Additive migration; existing accounts keep their current access and prices. */
export function ensureUserModelTables(sqlite: Database.Database) {
  if (initialized.has(sqlite)) return;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS user_model_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      access_mode TEXT NOT NULL CHECK(access_mode IN ('allow','deny')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id,model_id)
    );
    CREATE TABLE IF NOT EXISTS user_model_pricing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      billing_type TEXT NOT NULL,
      input_price REAL NOT NULL CHECK(input_price >= 0),
      output_price REAL NOT NULL CHECK(output_price >= 0),
      extra_params TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      updated_by INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id,model_id)
    );
    CREATE TABLE IF NOT EXISTS user_model_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, model_id INTEGER NOT NULL,
      actor_id INTEGER NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS user_model_access_pair ON user_model_access(user_id,model_id);
    CREATE UNIQUE INDEX IF NOT EXISTS user_model_pricing_pair ON user_model_pricing(user_id,model_id);
  `);
  initialized.add(sqlite);
}
