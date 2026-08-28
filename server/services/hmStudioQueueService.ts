export type HmStudioQueueSnapshot = {
  jobId: string;
  status: 'queued' | 'running';
  position: number;
  running: number;
  concurrencyLimit: number;
  userRunning: number;
  userConcurrencyLimit: number;
  queued: number;
};

type QueueJob<T = unknown> = {
  id: string;
  userKey: string;
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
 * Process-wide fair queue for the single HM Studio account.
 * Jobs are FIFO per user and users are scheduled round-robin.
 */
export class HmStudioQueueService {
  private readonly concurrencyLimit = positiveInt(process.env.HM_STUDIO_CONCURRENCY, 10);
  private readonly userConcurrencyLimit = positiveInt(process.env.HM_STUDIO_USER_CONCURRENCY, 2);
  private readonly maxUserQueue = positiveInt(process.env.HM_STUDIO_MAX_USER_QUEUE, 10);
  private readonly maxQueue = positiveInt(process.env.HM_STUDIO_MAX_QUEUE, 200);
  private readonly pendingByUser = new Map<string, QueueJob[]>();
  private readonly active = new Map<string, QueueJob>();
  private readonly jobs = new Map<string, QueueJob>();
  private userOrder: string[] = [];
  private draining = false;

  enqueue<T>(options: {
    id: string;
    userKey: string | number;
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
      createdAt: Date.now(),
      task: options.task,
      onUpdate: options.onUpdate,
      resolve,
      reject,
      completion,
    };
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
      createdAt: Date.now(),
      task: options.task,
      onUpdate: options.onUpdate,
      resolve,
      reject,
      completion,
    };
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
      concurrencyLimit: this.concurrencyLimit,
      userRunning: job ? this.userActiveCount(job.userKey) : 0,
      userConcurrencyLimit: this.userConcurrencyLimit,
      queued: orderedPending.length,
    };
  }

  getLimits() {
    return {
      concurrencyLimit: this.concurrencyLimit,
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
      if (this.userActiveCount(userKey) >= this.userConcurrencyLimit) continue;

      const job = queue.shift()!;
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
      while (this.active.size < this.concurrencyLimit) {
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
