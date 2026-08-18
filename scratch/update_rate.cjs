const Database = require('better-sqlite3');
const db = new Database('./data/app.db');

try {
  const res1 = db.prepare("UPDATE settings SET value = '3.00' WHERE key = 'tejiasd2_rate'").run();
  console.log('Updated settings table:', res1.changes);

  const res2 = db.prepare("UPDATE model_pricing SET input_price = 3.00 WHERE model_pattern = 'tejiasd2'").run();
  console.log('Updated model_pricing table:', res2.changes);
} catch (e) {
  console.error('Error updating database:', e.message);
} finally {
  db.close();
}
