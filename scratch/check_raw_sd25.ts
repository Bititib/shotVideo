import { db } from '../server/db/index.js';
import { models } from '../server/db/schema.js';

const rows = db.select().from(models).all();
rows.forEach(r => {
  if (r.modelId.includes('sd2.5') || r.displayName.includes('2.5')) {
    console.log('Model:', r);
  }
});
