import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
vi.mock('../server/routes/imageGen.js', () => ({ localizeGeneratedImage: vi.fn(async () => '/api/uploads/mj-grid.png') }));
import { localizeGeneratedImage } from '../server/routes/imageGen.js';
import { saveMjImageBatch, restoreCachedMjOriginal, type MjImageBatch } from '../server/services/mjImageResults.js';

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
const channel = { baseUrl: 'https://mj-provider.example', apiKey: 'test' };
const original = 'https://cdn.example/complete-image.png';
const cropped = () => [0,1,2,3].map(index => ({ index, sourceUrl: original, localUrl: '/api/uploads/crop-' + index + '.png', status: 'completed' as const }));
describe('intact MJ result persistence', () => {
  it.each([1,2,3,4])('preserves exactly %i original results and reuses them without resubmission', async count => {
    const batch: MjImageBatch = { sourceUrls: Array.from({ length: count }, (_, i) => original + '-' + i), jobs: [] };
    const persist = vi.fn(), ready = vi.fn();
    const urls = await saveMjImageBatch(batch, 123, {} as any, channel, persist, ready);
    expect(urls).toHaveLength(count);
    expect(batch.jobs).toHaveLength(count);
    expect(ready).toHaveBeenCalledTimes(count);
    expect(localizeGeneratedImage).toHaveBeenCalledTimes(count);
    expect(vi.mocked(localizeGeneratedImage).mock.calls.map(call => call[0])).toEqual(batch.sourceUrls);
    expect(batch.gridLocalUrl).toBeUndefined();
    expect(await saveMjImageBatch(batch, 123, {} as any, channel, persist, ready)).toEqual(urls);
    expect(localizeGeneratedImage).toHaveBeenCalledTimes(count);
  });
  it('restores a cached original instead of serving the four old crops', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const batch: MjImageBatch = { sourceUrls: [original], gridLocalUrl: '/api/uploads/intact.png', jobs: cropped() };
    const persist = vi.fn(), ready = vi.fn();
    expect(await saveMjImageBatch(batch, 123, {} as any, channel, persist, ready)).toEqual(['/api/uploads/intact.png']);
    expect(batch.legacyCroppedJobs).toEqual(cropped());
    expect(batch.jobs).toHaveLength(1);
    expect(localizeGeneratedImage).not.toHaveBeenCalled();
    expect(ready).toHaveBeenCalledExactlyOnceWith('/api/uploads/intact.png', 0);
  });
  it('downloads the original once when the old original cache is missing', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const batch: MjImageBatch = { sourceUrls: [original], gridLocalUrl: '/api/uploads/missing.png', jobs: cropped() };
    expect(restoreCachedMjOriginal(batch)).toBeUndefined();
    expect(batch.jobs).toHaveLength(4);
    expect(await saveMjImageBatch(batch, 123, {} as any, channel, vi.fn(), vi.fn())).toHaveLength(1);
    expect(localizeGeneratedImage).toHaveBeenCalledOnce();
    expect(batch.legacyCroppedJobs).toHaveLength(4);
  });
  it('reuses an original cached before the old cropping process stopped', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const batch: MjImageBatch = { sourceUrls: [original], gridLocalUrl: '/api/uploads/intact.png', jobs: [] };
    expect(await saveMjImageBatch(batch, 123, {} as any, channel, vi.fn(), vi.fn())).toEqual(['/api/uploads/intact.png']);
    expect(localizeGeneratedImage).not.toHaveBeenCalled();
  });
});
