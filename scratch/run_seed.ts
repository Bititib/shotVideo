import { initDatabase } from '../server/db/seed.js';
import { db } from '../server/db';
import { channels, models } from '../server/db/schema';
import { eq } from 'drizzle-orm';

async function run() {
  console.log('Running initDatabase...');
  await initDatabase();
  console.log('Done initialization. Querying database:');

  const allModels = db.select().from(models).all();
  for (const m of allModels) {
    if (m.modelId.includes('sdas-') || m.modelId.includes('seedance') || m.modelId.includes('sd2')) {
      console.log(`- Model: ${m.modelId} | displayName: ${m.displayName} | isActive: ${m.isActive}`);
    }
  }

  const allChannels = db.select().from(channels).all();
  for (const c of allChannels) {
    console.log(`- Channel: ${c.name} | baseUrl: ${c.baseUrl} | status: ${c.status}`);
  }
}

run().catch(console.error);
