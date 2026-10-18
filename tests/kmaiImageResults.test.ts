import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import sharp from 'sharp';
vi.mock('../server/routes/imageGen.js', () => ({ localizeGeneratedImage: vi.fn(async () => '/api/uploads/mj-grid.png') }));
import { localizeGeneratedImage } from '../server/routes/imageGen.js';
import { saveMjImageBatch, splitMjGrid, type MjImageBatch } from '../server/services/kmaiImageResults.js';

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
const colors = [[255,0,0], [0,255,0], [0,0,255], [255,255,0]];
async function grid(width = 11, height = 9) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y >= Math.floor(height / 2) ? 2 : 0) + Number(x >= Math.floor(width / 2));
    pixels.set(colors[index], (y * width + x) * 3);
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}
describe('MJ four-image result persistence', () => {
  it('splits a 2x2 preview in reading order without resizing or dropping odd edge pixels', async () => {
    const images = await splitMjGrid(await grid());
    expect(images).toHaveLength(4);
    for (const [index, buffer] of images.entries()) {
      const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
      expect([info.width, info.height]).toEqual([index % 2 ? 6 : 5, index >= 2 ? 5 : 4]);
      expect([...data.subarray(0, 3)]).toEqual(colors[index]);
      expect([...data.subarray(-3)]).toEqual(colors[index]);
    }
  });
  it('saves four independent files from a single downloaded preview and reuses them when resumed', async () => {
    const buffer = await grid();
    vi.spyOn(fs, 'readFile').mockResolvedValue(buffer);
    const write = vi.spyOn(fs, 'writeFile').mockResolvedValue();
    const batch: MjImageBatch = { sourceUrls: ['https://cdn.example/mj-grid.png'], jobs: [] };
    const persist = vi.fn(), ready = vi.fn();
    const urls = await saveMjImageBatch(batch, 123, {} as any, { baseUrl: 'https://kmai.us.ci', apiKey: 'test' }, persist, ready);
    expect(new Set(urls).size).toBe(4); expect(ready).toHaveBeenCalledTimes(4);
    expect(write).toHaveBeenCalledTimes(4); expect(localizeGeneratedImage).toHaveBeenCalledOnce();
    expect(batch.gridLocalUrl).toBe('/api/uploads/mj-grid.png');
    expect(await saveMjImageBatch(batch, 123, {} as any, { baseUrl: 'https://kmai.us.ci', apiKey: 'test' }, persist, ready)).toEqual(urls);
    expect(write).toHaveBeenCalledTimes(4); expect(localizeGeneratedImage).toHaveBeenCalledOnce();
  });
});
