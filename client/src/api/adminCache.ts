const TTL = 15_000;
let owner: string | null = null;
let generation = 0;
const values = new Map<string, { data: unknown; expires: number }>();
const requests = new Map<string, Promise<unknown>>();

function syncOwner() {
  const token = localStorage.getItem('token');
  if (owner !== token) { owner = token; invalidateAdminCache(); }
}

export function invalidateAdminCache() {
  generation++;
  values.clear();
  requests.clear();
}

export function getAdminCached<T>(key: string): T | undefined {
  syncOwner();
  const entry = values.get(key);
  return entry && entry.expires > Date.now() ? entry.data as T : undefined;
}

export function cachedAdminGet<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const cached = getAdminCached<T>(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = requests.get(key);
  if (pending) return pending as Promise<T>;
  const version = generation;
  const token = owner;
  const request = fetcher().then(data => {
    // A pre-mutation or previous-account response must never refill the cache.
    if (version === generation && token === localStorage.getItem('token')) {
      values.set(key, { data, expires: Date.now() + TTL });
    }
    return data;
  }).finally(() => { if (requests.get(key) === request) requests.delete(key); });
  requests.set(key, request);
  return request;
}
