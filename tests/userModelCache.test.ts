// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
beforeEach(() => { vi.resetModules(); localStorage.clear(); });
afterEach(() => vi.unstubAllGlobals());
describe('personal model price caches', () => {
  it.each(['video', 'image'] as const)('does not reuse %s prices after changing or signing out of an account', async kind => {
    const video = await import('../client/src/api/video');
    const image = await import('../client/src/api/imageGen');
    const load = kind === 'video' ? video.fetchVideoModels : image.fetchImageModels;
    const cached = kind === 'video' ? video.getCachedVideoModels : image.getCachedImageModels;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ id: 'test-model', name: 'Test', rate: .2, available: true }])));
    localStorage.setItem('token', 'account-one');
    await load(); expect(cached()).toHaveLength(1);
    localStorage.setItem('token', 'account-two'); expect(cached()).toEqual([]);
    localStorage.removeItem('token'); expect(cached()).toEqual([]);
  });
  it.each(['video', 'image'] as const)('does not persist an earlier %s response under a new account', async kind => {
    const video = await import('../client/src/api/video');
    const image = await import('../client/src/api/imageGen');
    const load = kind === 'video' ? video.fetchVideoModels : image.fetchImageModels;
    const cached = kind === 'video' ? video.getCachedVideoModels : image.getCachedImageModels;
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    localStorage.setItem('token', 'account-one'); const request = load();
    localStorage.setItem('token', 'account-two'); finish(Response.json([{ id: 'test-model', name: 'Test', rate: .2 }]));
    await request; expect(cached()).toEqual([]);
  });
});
