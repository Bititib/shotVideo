import { afterEach, describe, expect, it } from 'vitest';
import { HmStudioQueueFullError, HmStudioQueueService } from '../server/services/hmStudioQueueService.js';

const originalEnv = {
  concurrency: process.env.HM_STUDIO_CONCURRENCY,
  userConcurrency: process.env.HM_STUDIO_USER_CONCURRENCY,
  maxUserQueue: process.env.HM_STUDIO_MAX_USER_QUEUE,
  maxQueue: process.env.HM_STUDIO_MAX_QUEUE,
};

afterEach(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore('HM_STUDIO_CONCURRENCY', originalEnv.concurrency);
  restore('HM_STUDIO_USER_CONCURRENCY', originalEnv.userConcurrency);
  restore('HM_STUDIO_MAX_USER_QUEUE', originalEnv.maxUserQueue);
  restore('HM_STUDIO_MAX_QUEUE', originalEnv.maxQueue);
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

async function flushQueue() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('HM Studio fair queue', () => {
  it('enforces both global and per-user concurrency while rotating users', async () => {
    process.env.HM_STUDIO_CONCURRENCY = '2';
    process.env.HM_STUDIO_USER_CONCURRENCY = '1';
    const queue = new HmStudioQueueService();
    const a1 = deferred();
    const a2 = deferred();
    const b1 = deferred();

    const first = queue.enqueue({ id: 'a1', userKey: 'a', task: () => a1.promise });
    const second = queue.enqueue({ id: 'a2', userKey: 'a', task: () => a2.promise });
    const third = queue.enqueue({ id: 'b1', userKey: 'b', task: () => b1.promise });
    await flushQueue();

    expect(queue.snapshot('a1').status).toBe('running');
    expect(queue.snapshot('b1').status).toBe('running');
    expect(queue.snapshot('a2').status).toBe('queued');
    expect(queue.getLimits().running).toBe(2);
    expect(queue.getUserLoad('a')).toEqual({ running: 1, queued: 1, load: 2, limit: 1 });

    a1.resolve();
    await first.completion;
    await flushQueue();
    expect(queue.snapshot('a2').status).toBe('running');

    a2.resolve();
    b1.resolve();
    await Promise.all([second.completion, third.completion]);
    expect(queue.getLimits()).toEqual(expect.objectContaining({ running: 0, queued: 0 }));
  });

  it('rejects a user when their pending queue is full', () => {
    process.env.HM_STUDIO_CONCURRENCY = '1';
    process.env.HM_STUDIO_USER_CONCURRENCY = '1';
    process.env.HM_STUDIO_MAX_USER_QUEUE = '1';
    const queue = new HmStudioQueueService();
    const blocker = deferred();

    queue.enqueue({ id: 'first', userKey: 'same-user', task: () => blocker.promise });
    expect(() => queue.enqueue({ id: 'second', userKey: 'same-user', task: async () => undefined }))
      .toThrow(HmStudioQueueFullError);
    blocker.resolve();
  });

  it('provides an independent concurrency pool for each unique API key', async () => {
    process.env.HM_STUDIO_CONCURRENCY = '2';
    process.env.HM_STUDIO_USER_CONCURRENCY = '10';
    const queue = new HmStudioQueueService();
    queue.syncPools(['key-a', 'key-b', 'key-b']);
    const blockers = Array.from({ length: 6 }, () => deferred());
    const jobs = blockers.map((blocker, index) => queue.enqueue({
      id: `multi-${index}`,
      userKey: `user-${index}`,
      poolKey: index < 3 ? 'key-a' : 'key-b',
      task: () => blocker.promise,
    }));

    await flushQueue();
    expect(queue.getLimits()).toEqual(expect.objectContaining({
      poolCount: 2,
      poolConcurrencyLimit: 2,
      concurrencyLimit: 4,
      running: 4,
      queued: 2,
    }));
    expect(queue.getPoolLoad('key-a').running).toBe(2);
    expect(queue.getPoolLoad('key-b').running).toBe(2);

    blockers.forEach(blocker => blocker.resolve());
    await Promise.all(jobs.map(job => job.completion));
  });
});
