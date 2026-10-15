import type Database from 'better-sqlite3';
import { DEFAULT_IMAGE_GENERATION_TIMEOUT_MS } from '../services/imageGenerationTimeout.js';

const MIGRATION_KEY = 'migration_pidoi_image_timeout_v1';

/** Upgrade old Pidoi defaults once; later administrator edits must remain authoritative. */
export function migratePidoiImageTimeout(sqlite: Database.Database): number {
  return sqlite.transaction(() => {
    if (sqlite.prepare('SELECT 1 FROM settings WHERE key=?').get(MIGRATION_KEY)) return 0;
    const rows = sqlite.prepare('SELECT id,name,base_url AS baseUrl,timeout FROM channels').all() as {
      id: number; name: string; baseUrl: string; timeout: number;
    }[];
    let updated = 0;
    for (const row of rows) {
      const pidoiImage = row.name === 'Pidoi 图片渠道'
        || (/pidoi\.com/i.test(row.baseUrl) && row.name.includes('图片'));
      if (pidoiImage && [120_000, 180_000].includes(row.timeout)) {
        updated += sqlite.prepare("UPDATE channels SET timeout=?,updated_at=datetime('now') WHERE id=?")
          .run(DEFAULT_IMAGE_GENERATION_TIMEOUT_MS, row.id).changes;
      }
    }
    sqlite.prepare('INSERT INTO settings(key,value,label) VALUES(?,?,?)')
      .run(MIGRATION_KEY, '1', 'Pidoi 图片生成超时默认值升级为 15 分钟');
    return updated;
  })();
}
