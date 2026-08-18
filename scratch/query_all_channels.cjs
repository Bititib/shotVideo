const Database = require('better-sqlite3');
const fs = require('fs');

function queryDb(dbPath) {
  if (!fs.existsSync(dbPath)) {
    console.log(`\n=== Database not found at ${dbPath} ===`);
    return;
  }
  console.log(`\n=== Querying channels from ${dbPath} ===`);
  const db = new Database(dbPath);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log('Tables:', tables.map(t => t.name).join(', '));
    if (tables.some(t => t.name === 'channels')) {
      const rows = db.prepare("SELECT id, name, type, base_url, api_key, supported_models, status, priority, weight, last_test_result FROM channels").all();
      console.log('Channels found:');
      rows.forEach(r => {
        console.log(`- ID: ${r.id}, Name: ${r.name}, Type: ${r.type}, BaseURL: ${r.base_url}, Status: ${r.status}, Priority: ${r.priority}, Weight: ${r.weight}`);
        console.log(`  Models: ${r.supported_models}`);
        console.log(`  Last test: ${r.last_test_result || 'N/A'}`);
      });
    } else {
      console.log('No "channels" table found.');
    }
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    db.close();
  }
}

queryDb('./sqlite.db');
queryDb('./data/app.db');
