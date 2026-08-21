import { db } from '../server/db/index.js';
import { models } from '../server/db/schema.js';
import { eq } from 'drizzle-orm';

const sd25 = db.select().from(models).where(eq(models.modelId, 'sd2.5')).get();
console.log('sd2.5 model in DB:', sd25);
