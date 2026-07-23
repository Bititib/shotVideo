import { db } from '../server/db';
import { channels, models, settings } from '../server/db/schema';
import { eq, like } from 'drizzle-orm';

function queryDb() {
  console.log('=== Models ===');
  const allModels = db.select().from(models).all();
  for (const m of allModels) {
    if (m.modelId.includes('sdas-') || m.modelId.includes('seedance')) {
      console.log(`- ${m.modelId}: ${m.displayName} (${m.provider})`);
    }
  }

  console.log('\n=== Channels ===');
  const allChannels = db.select().from(channels).all();
  for (const c of allChannels) {
    console.log(`- ${c.name} (${c.baseUrl}): status=${c.status}, models=${c.supportedModels}`);
  }

  console.log('\n=== Settings ===');
  const sdasSettings = db.select().from(settings).where(like(settings.key, '%sdas%')).all();
  for (const s of sdasSettings) {
    console.log(`- ${s.key}: ${s.value} (${s.label})`);
  }
}

queryDb();
