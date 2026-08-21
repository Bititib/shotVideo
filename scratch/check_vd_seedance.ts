import { seed } from '../server/db/seed.ts';
import { db } from '../server/db/index.ts';
import { channels, models, settings, modelPricing } from '../server/db/schema.ts';

async function test() {
  await seed();
  console.log('--- ALL CHANNELS ---');
  console.log(db.select().from(channels).all().map(c => ({ id: c.id, name: c.name, models: c.supportedModels })));

  console.log('--- ALL SETTINGS (vd/rd) ---');
  console.log(db.select().from(settings).all().filter(s => s.key.includes('seedance') || s.key.includes('vd')));

  console.log('--- ALL PRICING (vd/rd) ---');
  console.log(db.select().from(modelPricing).all().filter(p => p.modelPattern.includes('seedance') || p.modelPattern.includes('vd')));
}

test().catch(console.error);
