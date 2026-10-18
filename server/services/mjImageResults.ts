import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Request } from 'express';
import { registerUpload } from './uploadAccess.js';
import { mjBaseUrl } from './mjAdapter.js';

export type MjImageJob = { index: number; sourceUrl: string; localUrl?: string; status: 'saving' | 'completed' };
export type MjImageBatch = { sourceUrls: string[]; gridLocalUrl?: string; jobs: MjImageJob[] };

/** MJ's combined preview is a 2-by-2 grid, ordered left-to-right, then top-to-bottom. */
export async function splitMjGrid(buffer: Buffer): Promise<Buffer[]> {
  const image = await sharp(buffer).rotate().toBuffer();
  const { width, height } = await sharp(image).metadata();
  if (!width || !height || width < 2 || height < 2) throw new Error('MJ 四宫格图片尺寸无效');
  const halfWidth = Math.floor(width / 2), halfHeight = Math.floor(height / 2);
  return Promise.all([0, 1, 2, 3].map(index => {
    const left = index % 2 ? halfWidth : 0, top = index >= 2 ? halfHeight : 0;
    return sharp(image).extract({ left, top, width: index % 2 ? width - halfWidth : halfWidth,
      height: index >= 2 ? height - halfHeight : halfHeight }).png().toBuffer();
  }));
}

/** Persist every source before downloads. Retrying this function never submits another generation. */
export async function saveMjImageBatch(batch: MjImageBatch, contentId: number, req: Request,
  channel: { baseUrl: string; apiKey: string }, persist: () => void,
  onReady: (url: string, index: number) => void): Promise<string[]> {
  channel = { ...channel, baseUrl: mjBaseUrl(channel.baseUrl) };
  const { localizeGeneratedImage } = await import('../routes/imageGen.js');
  if (batch.sourceUrls.length === 1 && !batch.jobs.length) {
    if (!batch.gridLocalUrl) {
      batch.gridLocalUrl = await localizeGeneratedImage(batch.sourceUrls[0], 'mj_grid_' + contentId, req, channel, { relative: true });
      persist();
    }
    if (!batch.gridLocalUrl.startsWith('/api/uploads/')) throw new Error('MJ 四宫格尚未保存到本站');
    const uploadDir = path.resolve('data/uploads');
    const buffers = await splitMjGrid(await fs.readFile(path.join(uploadDir, path.basename(batch.gridLocalUrl))));
    const prefix = 'mj_' + contentId + '_' + randomUUID();
    for (const [index, buffer] of buffers.entries()) {
      const name = prefix + '_' + (index + 1) + '.png';
      await fs.writeFile(path.join(uploadDir, name), buffer);
      const localUrl = registerUpload('/uploads/' + name).replace(/^\/uploads\//, '/api/uploads/');
      batch.jobs.push({ index, sourceUrl: batch.sourceUrls[0], localUrl, status: 'completed' });
    }
    persist();
  } else if (!batch.jobs.length) {
    batch.jobs = batch.sourceUrls.map((sourceUrl, index) => ({ index, sourceUrl, status: 'saving' }));
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
