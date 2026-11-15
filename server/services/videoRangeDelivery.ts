import fs from 'node:fs';
import crypto from 'node:crypto';
import type { Response } from 'express';

const hashes = new Map<string, { signature: string; digest: Promise<string> }>();

/** sendFile handles Range/If-Range; supply a strong content validator, not its weak default. */
export async function sendVideoFile(res: Response, file: string) {
  const stat = await fs.promises.stat(file);
  const signature = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  let cached = hashes.get(file);
  if (cached?.signature !== signature) {
    const digest = (async () => {
      const hash = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
      const after = await fs.promises.stat(file);
      if ([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs].join(':') !== signature) {
        throw new Error('Video changed during download preparation; retry original task');
      }
      return `"sha256-${hash.digest('hex')}"`;
    })();
    cached = { signature, digest };
    hashes.set(file, cached);
    if (hashes.size > 128) hashes.delete(hashes.keys().next().value!);
    void digest.catch(() => { if (hashes.get(file)?.digest === digest) hashes.delete(file); });
  }
  res.setHeader('ETag', await cached.digest);
  res.setHeader('Cache-Control', 'private, no-store, no-transform');
  return res.sendFile(file, { acceptRanges: true, cacheControl: false });
}
