import { db } from '../server/db/index.js';
import { apiLogs, channels } from '../server/db/schema.js';
import { desc } from 'drizzle-orm';

async function checkLogs() {
  const logs = db.select().from(apiLogs).orderBy(desc(apiLogs.id)).limit(15).all();
  console.log('--- LATEST 15 API LOGS ---');
  for (const log of logs) {
    let channelName = 'None';
    if (log.channelId) {
      const ch = db.select().from(channels).where(eq(channels.id, log.channelId)).get();
      channelName = ch ? ch.name : `ID:${log.channelId}`;
    }
    console.log(`Log ID: ${log.id}`);
    console.log(`Time: ${log.createdAt}`);
    console.log(`Model: ${log.model}`);
    console.log(`Upstream Model: ${log.upstreamModel}`);
    console.log(`Channel: ${channelName}`);
    console.log(`Status: ${log.status}`);
    console.log(`Cost: ${log.cost}`);
    console.log(`Duration: ${log.durationMs}ms`);
    console.log(`Error Message: ${log.errorMessage}`);
    console.log('--------------------------');
  }
}

// helper since eq requires import
import { eq } from 'drizzle-orm';
checkLogs().catch(console.error);
