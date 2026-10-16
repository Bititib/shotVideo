import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readValidatedImage } from './wxHaidiYueImageService.js';
import { registerUpload } from './uploadAccess.js';

/** Signed Pidoi result links are downloaded without API credentials. */
export async function localizeRecoveredImages(sources: { url: string; channelId: number; channelApiKeyId: number | null }[], contentId: number, ownerId: number, publicBaseUrl: string) {
  const urls: string[] = [], issues: string[] = [], failures: unknown[] = [];
  const uploadsRoot = path.resolve('data/uploads');
  for (const source of sources) {
    try {
      const image = await readValidatedImage(source.url, { uploadsRoot, publicBaseUrl, timeoutMs: 60_000 });
      const hash = createHash('sha256').update(image.buffer).digest('hex').slice(0, 32);
      const filename = `recovered_image_${contentId}_${hash}.${image.extension}`;
      await fs.mkdir(uploadsRoot, { recursive: true });
      await fs.writeFile(path.join(uploadsRoot, filename), image.buffer);
      registerUpload('/uploads/' + filename, ownerId);
      urls.push('/api/uploads/' + filename);
    } catch (error) { failures.push(error); issues.push('图片保存暂不可用'); }
  }
  return { urls, issues, failures };
}
