import { db } from '../server/db/index.js';
import { channels } from '../server/db/schema.js';
import { eq } from 'drizzle-orm';

async function checkRealKey() {
  const channel = db.select().from(channels).where(eq(channels.baseUrl, 'https://newtoken.club')).get();
  if (channel) {
    console.log('--- Database NewToken Channel ---');
    console.log('ID:', channel.id);
    console.log('Name:', channel.name);
    console.log('Base URL:', channel.baseUrl);
    console.log('API Key in DB:', channel.apiKey);
  } else {
    console.log('NewToken channel not found in DB!');
  }
}

checkRealKey().catch(console.error);
