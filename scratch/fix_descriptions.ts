import { db } from '../server/db/index.js';
import { models } from '../server/db/schema.js';

const allModels = db.select().from(models).all();
console.log('Models in DB:', allModels.map(m => ({ id: m.id, modelId: m.modelId, displayName: m.displayName, description: m.description })));
