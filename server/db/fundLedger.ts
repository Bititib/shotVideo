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
