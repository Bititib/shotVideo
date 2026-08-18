import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.resolve('data/app.db');
const sqlite = new Database(dbPath);

const chre3Models = ['sd2.5', 'sd2-c7', 'seedance-2.0-720p', 'seedance-2.0-fast-720p', 'seedance-720'];
console.log('=== 4月天渠道模型的 isActive 状态 ===\n');
for (const id of chre3Models) {
  const row = sqlite.prepare('SELECT model_id, display_name, is_active FROM models WHERE model_id = ?').get(id) as any;
  if (row) {
    console.log(`  ${row.model_id.padEnd(30)} ${row.is_active === 1 ? '✅ 前端可见' : '❌ 前端隐藏'}  (${row.display_name})`);
  } else {
    console.log(`  ${id.padEnd(30)} ⚠️ 不在数据库中`);
  }
}
sqlite.close();
