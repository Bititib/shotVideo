import type Database from 'better-sqlite3';
/** SQLite triggers make the balance change and its audit entry one atomic write, including legacy paths. */
export function ensureFundLedger(db: Database.Database) {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS fund_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_type TEXT NOT NULL, account_id INTEGER NOT NULL,
      account_name TEXT NOT NULL, user_id INTEGER, kind TEXT NOT NULL, delta REAL,
      balance_before REAL NOT NULL, balance_after REAL NOT NULL, actor_id INTEGER, content_id INTEGER,
      operation TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS fund_ledger_account ON fund_ledger(account_type,account_id,id);
    CREATE INDEX IF NOT EXISTS fund_ledger_time ON fund_ledger(created_at,id);
    CREATE INDEX IF NOT EXISTS fund_ledger_user ON fund_ledger(user_id,account_type,id);
    CREATE TABLE IF NOT EXISTS fund_ledger_content_links (
      entry_id INTEGER NOT NULL REFERENCES fund_ledger(id) ON DELETE CASCADE,
      content_id INTEGER NOT NULL, PRIMARY KEY(entry_id,content_id)
    );
    CREATE INDEX IF NOT EXISTS fund_ledger_content_link_task ON fund_ledger_content_links(content_id,entry_id);
    CREATE TABLE IF NOT EXISTS fund_ledger_context (id INTEGER PRIMARY KEY CHECK(id=1), kind TEXT, actor_id INTEGER, content_id INTEGER, operation TEXT);
    INSERT OR IGNORE INTO fund_ledger_context(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS fund_ledger_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT OR IGNORE INTO fund_ledger_meta VALUES('started_at',datetime('now'));`);
    for (const [table,type,name,user] of [['users','user','username','id'],['organizations','org','name','NULL'],['api_tokens','token','name','user_id']]) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      const migration='initialized_'+table;
      if (!db.prepare('SELECT 1 FROM fund_ledger_meta WHERE key=?').get(migration)) {
        db.exec(`INSERT INTO fund_ledger(account_type,account_id,account_name,user_id,kind,delta,balance_before,balance_after)
          SELECT '${type}',id,COALESCE(${name},''),${user},'opening',0,balance,balance FROM ${table};`);
        db.prepare("INSERT INTO fund_ledger_meta VALUES(?,datetime('now'))").run(migration);
      }
      const uid=user==='NULL'?'NULL':'NEW.'+user;
      db.exec(`CREATE TRIGGER IF NOT EXISTS ledger_${table}_update AFTER UPDATE OF balance ON ${table}
        WHEN NEW.balance != OLD.balance BEGIN
        INSERT INTO fund_ledger(account_type,account_id,account_name,user_id,kind,delta,balance_before,balance_after,actor_id,content_id,operation)
        SELECT '${type}',NEW.id,COALESCE(NEW.${name},''),${uid},
          CASE WHEN '${type}'='token' AND (NEW.balance=-1 OR OLD.balance=-1) THEN 'quota_mode'
          ELSE COALESCE(kind,CASE WHEN NEW.balance>OLD.balance THEN 'credit' ELSE 'debit' END) END,
          CASE WHEN '${type}'='token' AND (NEW.balance=-1 OR OLD.balance=-1) THEN NULL ELSE NEW.balance-OLD.balance END,
          OLD.balance,NEW.balance,actor_id,content_id,operation FROM fund_ledger_context WHERE id=1;
        END;
        CREATE TRIGGER IF NOT EXISTS ledger_${table}_insert AFTER INSERT ON ${table} BEGIN
        INSERT INTO fund_ledger(account_type,account_id,account_name,user_id,kind,delta,balance_before,balance_after,actor_id,content_id,operation)
        SELECT '${type}',NEW.id,COALESCE(NEW.${name},''),${uid},'initial',CASE WHEN NEW.balance=-1 THEN NULL ELSE NEW.balance END,
          0,NEW.balance,actor_id,content_id,operation FROM fund_ledger_context WHERE id=1;
        END;`);
    }
    // Audit used_amount separately: an unlimited token has no balance movement.
    // Snapshot existing counters honestly; never reconstruct old charges or change accounts.
    const tokenColumns = db.prepare('PRAGMA table_info(api_tokens)').all() as Array<{name:string}>;
    if (tokenColumns.some(column => column.name === 'used_amount')) {
      if (!db.prepare("SELECT 1 FROM fund_ledger_meta WHERE key='token_usage_started_at'").get()) {
        db.exec(`INSERT INTO fund_ledger(account_type,account_id,account_name,user_id,kind,delta,balance_before,balance_after)
          SELECT 'token_usage',id,COALESCE(name,''),user_id,'usage_opening',0,used_amount,used_amount FROM api_tokens;
          INSERT INTO fund_ledger_meta VALUES('token_usage_started_at',datetime('now'));`);
      }
      db.exec(`CREATE TRIGGER IF NOT EXISTS ledger_api_tokens_usage_update AFTER UPDATE OF used_amount ON api_tokens
        WHEN NEW.used_amount != OLD.used_amount BEGIN
        INSERT INTO fund_ledger(account_type,account_id,account_name,user_id,kind,delta,balance_before,balance_after,actor_id,content_id,operation)
        SELECT 'token_usage',NEW.id,COALESCE(NEW.name,''),NEW.user_id,
          COALESCE(kind,CASE WHEN NEW.used_amount>OLD.used_amount THEN 'usage_increase' ELSE 'usage_decrease' END),
          NEW.used_amount-OLD.used_amount,OLD.used_amount,NEW.used_amount,actor_id,content_id,operation
        FROM fund_ledger_context WHERE id=1;
        END;
        CREATE TRIGGER IF NOT EXISTS ledger_api_tokens_usage_insert AFTER INSERT ON api_tokens BEGIN
        INSERT INTO fund_ledger(account_type,account_id,account_name,user_id,kind,delta,balance_before,balance_after,actor_id,content_id,operation)
        SELECT 'token_usage',NEW.id,COALESCE(NEW.name,''),NEW.user_id,'usage_initial',0,
          NEW.used_amount,NEW.used_amount,actor_id,content_id,operation FROM fund_ledger_context WHERE id=1;
        END;`);
    }
  })();
}
export function withFundContext<T>(db: Database.Database, context: {kind?:string;actorId?:number;contentId?:number;operation?:string}, action:()=>T): T {
  ensureFundLedger(db);
  return db.transaction(() => {
    const old=db.prepare('SELECT * FROM fund_ledger_context WHERE id=1').get() as any;
    db.prepare('UPDATE fund_ledger_context SET kind=?,actor_id=?,content_id=?,operation=? WHERE id=1').run(
      context.kind??old.kind,context.actorId??old.actor_id,context.contentId??old.content_id,context.operation?.slice(0,120)??old.operation);
    try { return action(); }
    finally { db.prepare('UPDATE fund_ledger_context SET kind=?,actor_id=?,content_id=?,operation=? WHERE id=1').run(old.kind,old.actor_id,old.content_id,old.operation); }
  })();
}

/** Capture exact audit IDs within this synchronous transaction, never by time/amount. */
export function captureFundEntries<T>(db: Database.Database, action: () => T) {
  ensureFundLedger(db);
  return db.transaction(() => {
    const before = (db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM fund_ledger').get() as any).id;
    const value = action();
    const entryIds = (db.prepare("SELECT id FROM fund_ledger WHERE id>? AND kind NOT IN ('opening','initial','usage_opening','usage_initial') ORDER BY id").all(before) as Array<{id:number}>).map(r => r.id);
    return { value, entryIds };
  })();
}

/** Associate only IDs captured from a known billing operation; never overwrite another task. */
export function linkFundEntries(db: Database.Database, entryIds: unknown, contentId: number, multiple = false) {
  if (!Number.isSafeInteger(contentId) || contentId <= 0 || !Array.isArray(entryIds)) throw new Error('资金流水任务关联参数无效');
  db.transaction(() => {
    for (const id of new Set(entryIds)) {
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('资金流水编号无效');
      const row = db.prepare('SELECT content_id FROM fund_ledger WHERE id=?').get(id) as any;
      if (!row) continue;
      if (row.content_id != null && row.content_id !== contentId) throw new Error('资金流水已关联其他任务，停止关联');
      if (!multiple && db.prepare('SELECT 1 FROM fund_ledger_content_links WHERE entry_id=? AND content_id!=?').get(id,contentId)) throw new Error('资金流水已关联其他任务，停止关联');
      db.prepare('INSERT OR IGNORE INTO fund_ledger_content_links(entry_id,content_id) VALUES(?,?)').run(id,contentId);
      if (!multiple) db.prepare('UPDATE fund_ledger SET content_id=? WHERE id=? AND content_id IS NULL').run(contentId, id);
    }
  })();
}
