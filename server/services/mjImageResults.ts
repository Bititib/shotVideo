import fs from 'node:fs';
import path from 'node:path';
import type { Request } from 'express';
import { mjBaseUrl } from './mjAdapter.js';

export type MjImageJob = { index: number; sourceUrl: string; localUrl?: string; status: 'saving' | 'completed' };
export type MjImageBatch = { sourceUrls: string[]; gridLocalUrl?: string; jobs: MjImageJob[]; legacyCroppedJobs?: MjImageJob[] };

/** Signature of the old automatic crop, not evidence that an image is a grid. */
export function isLegacyCroppedMjBatch(batch?: MjImageBatch): boolean {
  return Boolean(Array.isArray(batch?.sourceUrls) && batch.sourceUrls.length === 1 && Array.isArray(batch.jobs) && batch.jobs.length === 4
    && batch.jobs.every(job => job.sourceUrl === batch.sourceUrls[0]));
}

/** Restore the original cache, retaining crop references for audit and existing projects. */
export function restoreCachedMjOriginal(batch: MjImageBatch): string | undefined {
  if (!isLegacyCroppedMjBatch(batch) || !batch.gridLocalUrl
    || !/^\/api\/uploads\/[\w.-]+$/.test(batch.gridLocalUrl)
    || !fs.existsSync(path.resolve('data/uploads', path.basename(batch.gridLocalUrl)))) return;
  batch.legacyCroppedJobs ||= batch.jobs;
  batch.jobs = [{ index: 0, sourceUrl: batch.sourceUrls[0], localUrl: batch.gridLocalUrl, status: 'completed' }];
  return batch.gridLocalUrl;
}

/** One upstream URL is one intact image. Never infer a grid or synthesize extra outputs. */
export async function saveMjImageBatch(batch: MjImageBatch, contentId: number, req: Request,
  channel: { baseUrl: string; apiKey: string }, persist: () => void,
  onReady: (url: string, index: number) => void): Promise<string[]> {
  channel = { ...channel, baseUrl: mjBaseUrl(channel.baseUrl) };
  const { localizeGeneratedImage } = await import('../routes/imageGen.js');
  if (isLegacyCroppedMjBatch(batch)) {
    if (!restoreCachedMjOriginal(batch)) {
      batch.legacyCroppedJobs ||= batch.jobs;
      batch.jobs = [];
    }
    persist();
  }
  if (!batch.jobs.length) {
    batch.jobs = batch.sourceUrls.map((sourceUrl, index) => ({ index, sourceUrl, status: 'saving' }));
    // Old processes could stop after caching the original but before saving crop jobs.
    if (batch.sourceUrls.length === 1 && batch.gridLocalUrl && /^\/api\/uploads\/[\w.-]+$/.test(batch.gridLocalUrl)
      && fs.existsSync(path.resolve('data/uploads', path.basename(batch.gridLocalUrl)))) {
      batch.jobs[0].localUrl = batch.gridLocalUrl;
      batch.jobs[0].status = 'completed';
    }
    persist();
  }
  for (const job of batch.jobs) {
    if (!job.localUrl) {
      job.localUrl = await localizeGeneratedImage(job.sourceUrl, 'mj_' + contentId + '_' + job.index, req, channel, { relative: true });
      job.status = 'completed'; persist();
    }
    onReady(job.localUrl, job.index);
  }
  return batch.jobs.sort((a, b) => a.index - b.index).map(job => job.localUrl!).filter(Boolean);
}
