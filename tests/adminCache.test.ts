import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cachedAdminGet, getAdminCached, invalidateAdminCache } from '../client/src/api/adminCache';

let token = 'admin-a';
beforeEach(() => {
  token = 'admin-a';
  vi.stubGlobal('localStorage', { getItem: () => token });
  invalidateAdminCache();
});

describe('admin configuration cache', () => {
  it('deduplicates concurrent reads and reuses a fresh result', async () => {
    const fetcher = vi.fn(async () => ['model']);
    expect(await Promise.all([cachedAdminGet('models', fetcher), cachedAdminGet('models', fetcher)])).toEqual([['model'], ['model']]);
    await cachedAdminGet('models', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not reuse data from another account', async () => {
    await cachedAdminGet('models', async () => ['private']);
    token = 'admin-b';
    expect(getAdminCached('models')).toBeUndefined();
  });
  it('does not let a read started before a mutation restore stale data', async () => {
    let resolve!: (value: string[]) => void;
    const old = cachedAdminGet('models', () => new Promise<string[]>(done => { resolve = done; }));
    invalidateAdminCache();
    await cachedAdminGet('models', async () => ['new']);
    resolve(['old']);
    await old;
    expect(getAdminCached('models')).toEqual(['new']);
  });
  it('retries failed requests and expires old results', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    await expect(cachedAdminGet('models', async () => { throw Error('offline'); })).rejects.toThrow('offline');
    await cachedAdminGet('models', async () => ['ok']);
    now.mockReturnValue(17000);
    expect(getAdminCached('models')).toBeUndefined();
    now.mockRestore();
  });
});
