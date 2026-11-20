import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { settings } from '../db/schema.js';

const KEY = 'apipath_merged_image_models';
export function archivedApipathModelIds(): Set<string> {
  const row = db.select().from(settings).where(eq(settings.key, KEY)).get();
  return new Set(row ? JSON.parse(row.value) : []);
}
export function archiveApipathModels(ids: string[]) {
  const value = JSON.stringify([...new Set([...archivedApipathModelIds(), ...ids])]);
  db.insert(settings).values({ key: KEY, value, label: '通联合并的旧图片入口' })
    .onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}
