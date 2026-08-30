import crypto from 'crypto';

export type HmStudioQueueSnapshot = {
  jobId: string;
  status: 'queued' | 'running';
  position: number;
  running: number;
  concurrencyLimit: number;
  userRunning: number;
  userConcurrencyLimit: number;
  queued: number;
  poolId: string;
  poolRunning: number;
  poolConcurrencyLimit: number;
};

export type HmStudioPoolConfig = {
  poolKey: string;
  concurrencyLimit: number;
};

type QueueJob<T = unknown> = {
  id: string;
  userKey: string;
  poolKey: string;
  createdAt: number;
  task: () => Promise<T>;
  onUpdate?: (snapshot: HmStudioQueueSnapshot) => void;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  completion: Promise<T>;
};

export class HmStudioQueueFullError extends Error {
  status = 429;

  constructor(message: string) {
    super(message);
    this.name = 'HmStudioQueueFullError';
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Process-wide fair queue with one independent concurrency pool per unique
 * HM Studio API key. Jobs are FIFO per user and users are round-robin.
 */
export class HmStudioQueueService {
  private readonly defaultPoolConcurrencyLimit = positiveInt(process.env.HM_STUDIO_CONCURRENCY, 10);
  // User jobs are not concurrency-capped; upstream pool capacity is the only
  // running limit. The per-user pending queue cap remains as overload safety.
  private readonly userConcurrencyLimit = -1;
  private readonly maxUserQueue = positiveInt(process.env.HM_STUDIO_MAX_USER_QUEUE, 10);
  private readonly maxQueue = positiveInt(process.env.HM_STUDIO_MAX_QUEUE, 200);
  private readonly pendingByUser = new Map<string, QueueJob[]>();
  private readonly active = new Map<string, QueueJob>();
  private readonly jobs = new Map<string, QueueJob>();
  private configuredPools = new Set<string>(['default']);
  private poolLimits = new Map<string, number>([['default', this.defaultPoolConcurrencyLimit]]);
  private userOrder: string[] = [];
  private draining = false;

  enqueue<T>(options: {
    id: string;
    userKey: string | number;
    poolKey?: string;
    task: () => Promise<T>;
    onUpdate?: (snapshot: HmStudioQueueSnapshot) => void;
  }): { snapshot: HmStudioQueueSnapshot; completion: Promise<T> } {
    const existing = this.jobs.get(options.id) as QueueJob<T> | undefined;
    if (existing) {
      return { snapshot: this.snapshot(options.id), completion: existing.completion };
    }

    const userKey = String(options.userKey);
    const userQueue = this.pendingByUser.get(userKey) || [];
    if (this.pendingCount() >= this.maxQueue) {
      throw new HmStudioQueueFullError(`HM Studio 排队已满（最多 ${this.maxQueue} 项），请稍后再试`);
    }
    if (userQueue.length >= this.maxUserQueue) {
      throw new HmStudioQueueFullError(`您已有 ${this.maxUserQueue} 项任务在排队，请等待已有任务完成`);
    }

    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const completion = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Detached HTTP jobs may intentionally outlive the request; prevent an
    // unhandled-rejection warning while preserving the original promise.
    completion.catch(() => undefined);

    const job: QueueJob<T> = {
      id: options.id,
      userKey,
      poolKey: options.poolKey || 'default',
      createdAt: Date.now(),
      task: options.task,
      onUpdate: options.onUpdate,
      resolve,
      reject,
      completion,
    };
    this.registerPool(job.poolKey);
    userQueue.push(job);
    this.pendingByUser.set(userKey, userQueue);
    if (!this.userOrder.includes(userKey)) this.userOrder.push(userKey);
    this.jobs.set(job.id, job);
    this.notifyAll();
    queueMicrotask(() => this.drain());
    return { snapshot: this.snapshot(job.id), completion };
  }

  assertCanEnqueue(userKeyValue: string | number, count = 1): void {
    const userKey = String(userKeyValue);
    const additional = Math.max(1, Math.floor(count));
    const userQueued = this.pendingByUser.get(userKey)?.length || 0;
    if (this.pendingCount() + additional > this.maxQueue) {
      throw new HmStudioQueueFullError(`HM Studio 排队空间不足（全局最多 ${this.maxQueue} 项），请稍后再试`);
    }
    if (userQueued + additional > this.maxUserQueue) {
      throw new HmStudioQueueFullError(`本次任务会超过您的排队上限 ${this.maxUserQueue} 项，请等待已有任务完成`);
    }
  }

  /** Register an upstream task that was already running before this process started. */
  adoptRunning<T>(options: {
    id: string;
    userKey: string | number;
    poolKey?: string;
    task: () => Promise<T>;
    onUpdate?: (snapshot: HmStudioQueueSnapshot) => void;
  }): { snapshot: HmStudioQueueSnapshot; completion: Promise<T> } {
    const existing = this.jobs.get(options.id) as QueueJob<T> | undefined;
    if (existing) return { snapshot: this.snapshot(options.id), completion: existing.completion };

    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const completion = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    completion.catch(() => undefined);
    const job: QueueJob<T> = {
      id: options.id,
      userKey: String(options.userKey),
      poolKey: options.poolKey || 'default',
      createdAt: Date.now(),
      task: options.task,
      onUpdate: options.onUpdate,
      resolve,
      reject,
      completion,
    };
    this.registerPool(job.poolKey);
    this.jobs.set(job.id, job);
    this.active.set(job.id, job);
    this.notifyAll();
    void this.run(job);
    return { snapshot: this.snapshot(job.id), completion };
  }

  snapshot(jobId: string): HmStudioQueueSnapshot {
    const job = this.jobs.get(jobId);
    const status = this.active.has(jobId) ? 'running' : 'queued';
    const orderedPending = Array.from(this.pendingByUser.values())
      .flat()
      .sort((a, b) => a.createdAt - b.createdAt);
    const index = orderedPending.findIndex(item => item.id === jobId);
    return {
      jobId,
      status,
      position: status === 'running' ? 0 : Math.max(1, index + 1),
      running: this.active.size,
      concurrencyLimit: this.totalConcurrencyLimit(),
      userRunning: job ? this.userActiveCount(job.userKey) : 0,
      userConcurrencyLimit: this.userConcurrencyLimit,
      queued: orderedPending.length,
      poolId: job?.poolKey || 'default',
      poolRunning: job ? this.poolActiveCount(job.poolKey) : 0,
      poolConcurrencyLimit: this.poolLimit(job?.poolKey || 'default'),
    };
  }

  syncPools(pools: Array<string | HmStudioPoolConfig>): void {
    const nextLimits = new Map<string, number>();
    for (const pool of pools) {
      const poolKey = typeof pool === 'string' ? pool : pool.poolKey;
      if (!poolKey) continue;
      const requestedLimit = typeof pool === 'string' ? this.defaultPoolConcurrencyLimit : pool.concurrencyLimit;
      const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
        ? requestedLimit
        : this.defaultPoolConcurrencyLimit;
      const existing = nextLimits.get(poolKey);
      nextLimits.set(poolKey, existing === undefined ? limit : Math.min(existing, limit));
    }
    for (const job of this.jobs.values()) {
      if (!nextLimits.has(job.poolKey)) {
        nextLimits.set(job.poolKey, this.poolLimit(job.poolKey));
      }
    }
    if (nextLimits.size === 0) nextLimits.set('default', this.defaultPoolConcurrencyLimit);
    this.poolLimits = nextLimits;
    const configured = new Set(nextLimits.keys());
    this.configuredPools = configured.size > 0 ? configured : new Set(['default']);
    this.notifyAll();
    this.drain();
  }

  getPoolLoad(poolKey: string): { running: number; queued: number; load: number; limit: number } {
    const running = this.poolActiveCount(poolKey);
    const queued = Array.from(this.pendingByUser.values()).flat().filter(job => job.poolKey === poolKey).length;
    return { running, queued, load: running + queued, limit: this.poolLimit(poolKey) };
  }

  getUserLoad(userKeyValue: string | number): { running: number; queued: number; load: number; limit: number } {
    const userKey = String(userKeyValue);
    const running = this.userActiveCount(userKey);
    const queued = this.pendingByUser.get(userKey)?.length || 0;
    return { running, queued, load: running + queued, limit: this.userConcurrencyLimit };
  }

  getPoolStats() {
    return Array.from(this.configuredPools).map(poolId => ({
      pool_id: poolId,
      running: this.poolActiveCount(poolId),
      queued: Array.from(this.pendingByUser.values()).flat().filter(job => job.poolKey === poolId).length,
      concurrency_limit: this.poolLimit(poolId),
    }));
  }

  getLimits() {
    const configuredLimits = Array.from(this.configuredPools).map(poolKey => this.poolLimit(poolKey));
    const uniqueConfiguredLimits = new Set(configuredLimits);
    return {
      concurrencyLimit: this.totalConcurrencyLimit(),
      poolConcurrencyLimit: uniqueConfiguredLimits.size === 1 ? configuredLimits[0] : null,
      poolCount: this.configuredPools.size,
      userConcurrencyLimit: this.userConcurrencyLimit,
      maxUserQueue: this.maxUserQueue,
      maxQueue: this.maxQueue,
      running: this.active.size,
      queued: this.pendingCount(),
    };
  }

  private pendingCount(): number {
    return Array.from(this.pendingByUser.values()).reduce((sum, queue) => sum + queue.length, 0);
  }

  private userActiveCount(userKey: string): number {
    return Array.from(this.active.values()).filter(job => job.userKey === userKey).length;
  }

  private poolActiveCount(poolKey: string): number {
    return Array.from(this.active.values()).filter(job => job.poolKey === poolKey).length;
  }

  private totalConcurrencyLimit(): number {
    return Array.from(this.configuredPools).reduce((sum, poolKey) => sum + this.poolLimit(poolKey), 0);
  }

  private poolLimit(poolKey: string): number {
    return this.poolLimits.get(poolKey) || this.defaultPoolConcurrencyLimit;
  }

  private registerPool(poolKey: string): void {
    if (poolKey !== 'default') this.configuredPools.delete('default');
    this.configuredPools.add(poolKey);
    if (!this.poolLimits.has(poolKey)) this.poolLimits.set(poolKey, this.defaultPoolConcurrencyLimit);
  }

  private notifyAll(): void {
    for (const job of this.jobs.values()) {
      try { job.onUpdate?.(this.snapshot(job.id)); } catch { /* observer errors must not stop scheduling */ }
    }
  }

  private nextRunnable(): QueueJob | null {
    const attempts = this.userOrder.length;
    for (let index = 0; index < attempts; index++) {
      const userKey = this.userOrder.shift();
      if (!userKey) break;
      const queue = this.pendingByUser.get(userKey) || [];
      if (queue.length === 0) {
        this.pendingByUser.delete(userKey);
        continue;
      }

      this.userOrder.push(userKey);
      const runnableIndex = queue.findIndex(job => this.poolActiveCount(job.poolKey) < this.poolLimit(job.poolKey));
      if (runnableIndex < 0) continue;
      const [job] = queue.splice(runnableIndex, 1);
      if (queue.length === 0) {
        this.pendingByUser.delete(userKey);
        this.userOrder = this.userOrder.filter(value => value !== userKey);
      }
      return job;
    }
    return null;
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.active.size < this.totalConcurrencyLimit()) {
        const job = this.nextRunnable();
        if (!job) break;
        this.active.set(job.id, job);
        this.notifyAll();
        void this.run(job);
      }
    } finally {
      this.draining = false;
    }
  }

  private async run(job: QueueJob): Promise<void> {
    try {
      job.resolve(await job.task());
    } catch (error) {
      job.reject(error);
    } finally {
      this.active.delete(job.id);
      this.jobs.delete(job.id);
      this.notifyAll();
      this.drain();
    }
  }
}

export const hmStudioQueue = new HmStudioQueueService();

export function hmStudioPoolKey(channel: { id?: number; apiKey?: string | null }): string {
  const apiKey = String(channel.apiKey || '').trim();
  if (!apiKey) return `channel-${channel.id || 'unknown'}`;
  return `key-${crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 12)}`;
}

export function hmStudioPoolConfig(channel: {
  id?: number;
  apiKey?: string | null;
  concurrencyLimit?: number | null;
}): HmStudioPoolConfig {
  const requestedLimit = Number(channel.concurrencyLimit);
  return {
    poolKey: hmStudioPoolKey(channel),
    concurrencyLimit: Number.isInteger(requestedLimit) && requestedLimit > 0
      ? requestedLimit
      : positiveInt(process.env.HM_STUDIO_CONCURRENCY, 10),
  };
}
