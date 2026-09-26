import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT,org_id INTEGER,is_active INTEGER,balance REAL);
    CREATE TABLE contents(id INTEGER PRIMARY KEY,user_id INTEGER,type TEXT DEFAULT 'video',status TEXT,cost REAL DEFAULT 0,result_url TEXT,metadata TEXT);`);
  return { sqlite };
});
vi.mock('../server/config/env.js', () => ({ env: { PORT: 9876, JWT_SECRET: 'isolated-test-secret' } }));
vi.mock('../server/services/balanceService.js', async () => {
  const { sqlite } = await import('../server/db/index.js');
  return { BalanceService: {
    deductWithSource: (id: number, amount: number) => {
      const result = sqlite.prepare('UPDATE users SET balance=balance-? WHERE id=? AND balance>=?').run(amount, id, amount);
      return result.changes ? { source: 'user', balance: 100 - amount } : null;
    },
    refundToSource: (id: number, amount: number) => { sqlite.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(amount, id); },
  } };
});

import { sqlite } from '../server/db/index.js';
import { batchStore, batchContextForRequest, tickVideoBatches, recordBatchFailure, markBatchSubmitting, settleRecoveredBatch, startVideoBatchWorker, isBatchChannelAtCapacity } from '../server/services/videoBatchService';
import type { VideoBatchInput } from '../shared/videoBatch';

const input: VideoBatchInput = { name: 'test', model: 'test-video', resolution: '720p', aspect_ratio: '9:16', video_length: 6,
  autoRetry: true, maxRetries: 2, creatives: [{ prompt: 'original user prompt', count: 1, reference_images: [] }] };
const balance = () => (sqlite.prepare('SELECT balance FROM users WHERE id=1').get() as any).balance;
function create() {
  const batchId = batchStore.create(1, crypto.randomUUID(), input, 1.5, 'https://public.example');
  return batchStore.detail(batchId, 1).items[0];
}
function running() {
  const i = create(); const c = batchStore.claim(i.id);
  batchStore.attach(i.id, c.attempts, 1, () => Number(sqlite.prepare('INSERT INTO contents(user_id,status,metadata) VALUES (1,?,?)')
    .run('processing', JSON.stringify({ batchItemId: i.id, batchId: 1 })).lastInsertRowid));
  return batchStore.item(i.id);
}
beforeEach(() => {
  sqlite.exec('DELETE FROM video_batch_commands; DELETE FROM video_batch_attempts; DELETE FROM video_batch_items; DELETE FROM video_batches; DELETE FROM contents; DELETE FROM users; INSERT INTO users VALUES(1,\'user\',NULL,1,100)');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected outbound request'); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('batch worker and prepaid bridge (no real database/upstream)', () => {
  it('ignores public prepaid body flags and rejects a forged internal credential', () => {
    expect(batchContextForRequest({ headers: {}, userId: 1, body: { prepaid: true, batchItemId: 1 } } as any)).toBeNull();
    expect(() => batchContextForRequest({ headers: { 'x-video-batch-key': 'forged' }, userId: 1 } as any)).toThrow('凭证');
  });
  it('dispatches persisted input through an authenticated bridge, with one reservation', async () => {
    const i = create();
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: any) => {
      expect(url).toBe('http://127.0.0.1:9876/api/video/generate');
      const headers = Object.fromEntries(Object.entries(options.headers).map(([k, v]) => [k.toLowerCase(), v]));
      const context = batchContextForRequest({ headers, userId: 1, body: { prompt: 'tampered' } } as any);
      expect(context.body.prompt).toBe('original user prompt');
      expect(options.headers.Host).toBe('public.example');
      batchStore.attach(i.id, context.item.attempts, 1, () => Number(sqlite.prepare('INSERT INTO contents(user_id,status,metadata) VALUES(1,?,?)')
        .run('processing', JSON.stringify({ batchItemId: i.id })).lastInsertRowid));
      return new Response(`data: ${JSON.stringify({ type: 'content_id', contentId: batchStore.item(i.id).content_id })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    }));
    tickVideoBatches();
    await vi.waitFor(() => expect(batchStore.item(i.id).status).toBe('running'));
    await new Promise(resolve => setTimeout(resolve, 0));
    tickVideoBatches(); expect(fetch).toHaveBeenCalledTimes(1); expect(balance()).toBe(98.5);
  });
  it('records success and cost atomically without another deduction', () => {
    const i = running();
    sqlite.prepare("UPDATE contents SET status='completed',result_url='/uploads/ok.mp4' WHERE id=?").run(i.content_id);
    tickVideoBatches(); tickVideoBatches();
    expect(batchStore.item(i.id).status).toBe('completed'); expect(balance()).toBe(98.5);
    expect(sqlite.prepare('SELECT cost FROM contents WHERE id=?').get(i.content_id)).toEqual({ cost: 1.5 });
  });
  it('does not charge/settle a completed response without a video URL', () => {
    const i = running(); sqlite.prepare("UPDATE contents SET status='completed' WHERE id=?").run(i.content_id);
    tickVideoBatches(); expect(batchStore.item(i.id).billing_state).toBe('reserved');
    expect(balance()).toBe(98.5); expect(fetch).not.toHaveBeenCalled();
  });
  it('retains prepayment and pauses automatic re-generation on unknown POST 502', () => {
    const i = running(); recordBatchFailure(i.content_id, 'HM Studio 提交失败 (502): Bad Gateway');
    tickVideoBatches(); tickVideoBatches();
    expect(batchStore.item(i.id)).toMatchObject({ status: 'review', billing_state: 'reserved' });
    expect(balance()).toBe(98.5); expect(fetch).not.toHaveBeenCalled();
  });
  it('refunds rejected invalid input instead of retrying it', () => {
    const i = running(); recordBatchFailure(i.content_id, 'HM Studio 提交失败 (400): 提示词超过5000字');
    tickVideoBatches(); tickVideoBatches();
    expect(batchStore.item(i.id)).toMatchObject({ status: 'failed', billing_state: 'refunded' });
    expect(balance()).toBe(100);
  });
  it('schedules only an explicitly confirmed generation failure', () => {
    const i = running(); recordBatchFailure(i.content_id, '渲染引擎繁忙', true); tickVideoBatches();
    expect(batchStore.item(i.id)).toMatchObject({ status: 'retry_wait', retry_count: 1 });
    expect(balance()).toBe(98.5); expect(fetch).not.toHaveBeenCalled();
  });
  it('uses a durable, one-shot submission marker', () => {
    const i = running(); expect(markBatchSubmitting(i.content_id)).toBe(true);
    expect(markBatchSubmitting(i.content_id)).toBe(false);
  });
  it('settles recovered current result from original reservation, rejects obsolete attempts', () => {
    const i = running(); recordBatchFailure(i.content_id, 'result uncertain'); tickVideoBatches();
    expect(settleRecoveredBatch(i.content_id, '/uploads/recovered.mp4')).toBe(true);
    expect(balance()).toBe(98.5); expect(batchStore.item(i.id).billing_state).toBe('charged');
    expect(() => settleRecoveredBatch(i.content_id, '/uploads/recovered.mp4')).toThrow('已结算');
    recordBatchFailure(i.content_id, 'late failure', true); tickVideoBatches(); expect(balance()).toBe(98.5);
  });
  it('counts existing ordinary-video load against non-HM capacity', () => {
    sqlite.prepare('INSERT INTO contents(user_id,status,metadata) VALUES(1,?,?)').run('processing', JSON.stringify({ channelId: 77 }));
    expect(isBatchChannelAtCapacity({ id: 77, concurrencyLimit: 1 })).toBe(true);
    expect(isBatchChannelAtCapacity({ id: 77, concurrencyLimit: 2 })).toBe(false);
    expect(isBatchChannelAtCapacity({ id: 77, type: 'hmstudio', concurrencyLimit: 1 })).toBe(false);
  });
  it('restart marks interrupted submission for review, never dispatches a replacement', () => {
    vi.useFakeTimers(); const i = running(); markBatchSubmitting(i.content_id);
    startVideoBatchWorker();
    expect(batchStore.item(i.id).status).toBe('review'); expect(fetch).not.toHaveBeenCalled(); expect(balance()).toBe(98.5);
    vi.clearAllTimers();
  });
});
