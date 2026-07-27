const Database = require('better-sqlite3');
const db = new Database('./sqlite.db');

// List all tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name).join(', '));

// Try to find channels with chre3
try {
  const rows = db.prepare("SELECT id, name, base_url, api_key, supported_models FROM channels WHERE base_url LIKE '%chre3%' OR name LIKE '%月天%'").all();
  console.log('\n四月天渠道配置:');
  console.log(JSON.stringify(rows, null, 2));
} catch(e) {
  console.log('channels table error:', e.message);
}

db.close();
