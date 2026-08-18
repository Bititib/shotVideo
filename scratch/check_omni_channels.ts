import { db } from '../server/db/index.js';
import { channels } from '../server/db/schema.js';

async function check() {
  const allChannels = db.select().from(channels).all();
  console.log('--- ALL CHANNELS ---');
  for (const c of allChannels) {
    console.log(`ID: ${c.id}`);
    console.log(`Name: ${c.name}`);
    console.log(`Type: ${c.type}`);
    console.log(`Base URL: ${c.baseUrl}`);
    console.log(`API Key: ${c.apiKey ? c.apiKey.slice(0, 10) + '...' : '(none)'}`);
    console.log(`Status: ${c.status}`);
    console.log(`Supported Models: ${c.supportedModels}`);
    console.log(`Model Mapping: ${c.modelMapping}`);
    console.log('--------------------');
  }
}

check().catch(console.error);
