import Database from 'better-sqlite3';

const db = new Database('./data/app.db');
const channelsList = db.prepare("SELECT * FROM channels").all() as any[];
db.close();

console.log('🔍 数据库中的全部渠道字段和渠道列表:');
for (const c of channelsList) {
  if (c.name.includes('星河') || c.name.includes('SudaShui') || JSON.stringify(c).includes('sudashui')) {
    console.log(JSON.stringify(c, null, 2));
  }
}
