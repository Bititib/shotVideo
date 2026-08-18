import Database from 'better-sqlite3';

const db = new Database('./data/app.db');
const row = db.prepare("SELECT * FROM channels WHERE baseUrl LIKE '%diwdiw.cn%'").get() as any;
db.close();

if (row) {
  console.log('--- MJNewAPI Channel In DB ---');
  console.log('Name:', row.name);
  console.log('BaseURL:', row.base_url);
  console.log('SupportedModels:', row.supported_models);
  console.log('ModelMapping:', row.model_mapping);
  
  const parsed = JSON.parse(row.supported_models);
  if (parsed.length === 1 && parsed[0] === 'cd-seedance-2.0-720p') {
    console.log('✅ Success: supportedModels is exactly ["cd-seedance-2.0-720p"]');
  } else {
    console.log('❌ Error: supportedModels has issues:', row.supported_models);
  }
} else {
  console.log('❌ Error: MJNewAPI channel not found!');
}
