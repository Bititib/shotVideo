import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { VideoBatchStore, canRetryBatchFailure, isBatchQueryUncertain, guardBatchSubmissionResponse } from '../server/services/videoBatchStore';
import type { VideoBatchInput } from '../shared/videoBatch';

const input: VideoBatchInput = { name: '原始创意', model: 'test-video', resolution: '720p', aspect_ratio: '9:16', video_length: 6,
  autoRetry: true, maxRetries: 2, creatives: [{ prompt: '  我的原始提示词，不改写。  ', count: 3, reference_images: ['https://example.com/product.png'] }] };
let sql: Database.Database;
let store: VideoBatchStore;
const balance = (id = 1) => (sql.prepare('SELECT balance FROM wallets WHERE id=?').get(id) as any).balance;
let useOrg = false;
const ledger = {
  deduct: (userId: number, amount: number) => {
    const wallet = useOrg ? 2 : userId;
    const result = sql.prepare('UPDATE wallets SET balance=balance-? WHERE id=? AND balance>=?').run(amount, wallet, amount);
    return result.changes ? { source: useOrg ? 'org' as const : 'user' as const, orgId: useOrg ? 2 : undefined } : null;
  },
  refund: (userId: number, amount: number, receipt: any) => { sql.prepare('UPDATE wallets SET balance=balance+? WHERE id=?').run(amount, receipt.source === 'org' ? receipt.orgId : userId); },
};
function create(options: Partial<VideoBatchInput> = {}) { return store.create(1, 'unique-key', { ...input, ...options }, 1.5, 'https://site.example'); }
function first(id: number) { return store.detail(id, 1).items[0]; }
function start(itemId: number, contentId = 10) {
  sql.prepare('UPDATE video_batch_items SET next_run=0 WHERE id=?').run(itemId);
  const item = store.claim(itemId);
  expect(item).toBeTruthy();
  store.attach(itemId, item.attempts, 1, () => contentId);
  return item;
}
beforeEach(() => {
  useOrg = false;
  sql = new Database(':memory:');
  sql.exec('CREATE TABLE wallets(id INTEGER PRIMARY KEY,balance REAL); INSERT INTO wallets VALUES(1,100),(2,100)');
  store = new VideoBatchStore(sql, ledger);
});
afterEach(() => { sql.close(); });

describe('batch reservation ledger (isolated SQLite)', () => {
  it('pre-deducts whole batch exactly once on repeated create', () => {
    const id = create(); expect(balance()).toBe(95.5);
    expect(create()).toBe(id); expect(balance()).toBe(95.5);
    expect(store.detail(id, 1).reserved).toBe(4.5);
    expect(store.detail(id, 1).items).toHaveLength(3);
  });
  it('does not create any records when balance is insufficient', () => {
    sql.prepare('UPDATE wallets SET balance=1 WHERE id=1').run();
    expect(() => create()).toThrow('余额不足');
    expect(balance()).toBe(1);
    expect(sql.prepare('SELECT count(*) n FROM video_batches').get()).toEqual({ n: 0 });
  });
  it('rolls back deduction when persistence fails', () => {
    sql.exec("CREATE TRIGGER reject_item BEFORE INSERT ON video_batch_items BEGIN SELECT RAISE(ABORT,'test persistence failure'); END");
    expect(() => create()).toThrow('test persistence'); expect(balance()).toBe(100);
    expect(sql.prepare('SELECT count(*) n FROM video_batches').get()).toEqual({ n: 0 });
  });
  it('claims/attaches once and preserves prompt and materials verbatim', () => {
    const item = first(create()); const claimed = store.claim(item.id);
    expect(store.claim(item.id)).toBeNull();
    const context = store.context(item.id, claimed.attempts, 1);
    expect(context.body.prompt).toBe(input.creatives[0].prompt);
    expect(context.body.reference_images).toEqual(input.creatives[0].reference_images);
    store.attach(item.id, claimed.attempts, 1, () => 42);
    const duplicate = vi.fn(() => 43);
    expect(() => store.attach(item.id, claimed.attempts, 1, duplicate)).toThrow(); expect(duplicate).not.toHaveBeenCalled();
  });
  it('retries twice without additional deductions then refunds only that item', () => {
    const id = create(); const item = first(id);
    for (let n = 0; n < 3; n++) {
      start(item.id, 10 + n); store.fail(item.id, '渲染引擎失败', true);
      expect(balance()).toBe(n < 2 ? 95.5 : 97);
      expect(store.item(item.id).status).toBe(n < 2 ? 'retry_wait' : 'failed');
    }
    store.fail(item.id, '重复失败通知', true); expect(balance()).toBe(97);
    expect(store.detail(id, 1).refunded).toBe(1.5);
  });
  it('settles a retry success exactly once and rejects late failure', () => {
    const item = first(create()); start(item.id); store.fail(item.id, '引擎繁忙', true);
    start(item.id, 11); const update = vi.fn();
    store.complete(item.id, 11, '/uploads/video.mp4', update);
    store.complete(item.id, 11, '/uploads/video.mp4', update);
    store.fail(item.id, 'late failure', true);
    expect(update).toHaveBeenCalledTimes(1); expect(balance()).toBe(95.5);
    expect(store.item(item.id)).toMatchObject({ status: 'completed', charged: 1.5, billing_state: 'charged' });
  });
  it('does not settle success without a video URL or for an obsolete attempt', () => {
    const item = first(create()); start(item.id);
    const update = vi.fn(); store.complete(item.id, 10, '', update); store.complete(item.id, 99, 'url', update);
    expect(update).not.toHaveBeenCalled(); expect(store.item(item.id).billing_state).toBe('reserved');
  });
  it('rolls back success state if content update fails', () => {
    const item = first(create()); start(item.id);
    expect(() => store.complete(item.id, 10, 'url', () => { throw new Error('write failure'); })).toThrow();
    expect(store.item(item.id).status).toBe('running'); expect(balance()).toBe(95.5);
  });
  it.each(['提示词超过5000字', '素材格式不支持', 'content moderation rejected', 'invalid argument'])('never auto retries invalid input: %s', message => {
    const item = first(create()); start(item.id); store.fail(item.id, message, true);
    expect(store.item(item.id).status).toBe('failed'); expect(balance()).toBe(97);
  });
  it('refunds a confirmed failure immediately with auto retry off', () => {
    const item = first(create({ autoRetry: false })); start(item.id); store.fail(item.id, '渲染失败', true);
    expect(store.item(item.id).status).toBe('failed'); expect(balance()).toBe(97);
  });
  it('holds unknown submissions for review, without duplicate generation/refund', () => {
    const id = create(); const item = first(id); start(item.id);
    store.fail(item.id, '502 / POST timeout'); store.fail(item.id, 'still unknown');
    expect(store.item(item.id).status).toBe('review'); expect(store.claim(item.id)).toBeNull();
    store.cancelPending(id, 1); expect(balance()).toBe(98.5);
    expect(store.item(item.id).billing_state).toBe('reserved');
    store.complete(item.id, 10, '/uploads/recovered.mp4', () => {}); expect(balance()).toBe(98.5);
  });
  it('cancels only queued tasks and refunds to the ORIGINAL balance source', () => {
    useOrg = true; const id = create(); const item = first(id); start(item.id);
    useOrg = false; store.cancelPending(id, 1); store.cancelPending(id, 1);
    expect(balance(2)).toBe(98.5); expect(balance()).toBe(100);
    expect(store.item(item.id).status).toBe('running');
  });
  it('disabling retries releases waiting retries but leaves ordinary queued tasks', () => {
    const id = create(); const item = first(id); start(item.id); store.fail(item.id, '渲染失败', true);
    store.stopRetries(id, 1); store.stopRetries(id, 1);
    expect(store.item(item.id).status).toBe('failed'); expect(balance()).toBe(97);
    expect(store.detail(id, 1).items.filter(i => i.status === 'queued')).toHaveLength(2);
  });
  it('manual retry re-reserves once and is idempotent even after a subsequent failure', () => {
    const id = create({ autoRetry: false }); const item = first(id); start(item.id); store.fail(item.id, 'failed', true);
    expect(store.retryFailed(id, 1, 'retry-one')).toBe(1.5); expect(balance()).toBe(95.5);
    start(item.id, 11); store.fail(item.id, 'failed again', true); expect(balance()).toBe(97);
    store.retryFailed(id, 1, 'retry-one'); expect(balance()).toBe(97); expect(store.item(item.id).status).toBe('failed');
    store.retryFailed(id, 1, 'retry-two'); expect(balance()).toBe(95.5);
  });
  it('late internal submit cannot attach a record after interruption/refund', () => {
    const item = first(create()); const claim = store.claim(item.id);
    store.fail(item.id, 'internal connection lost before record', false, true);
    expect(() => store.attach(item.id, claim.attempts, 1, () => 10)).toThrow();
    expect(balance()).toBe(97);
  });
  it('channel capacity deferral holds reservation without using an automatic retry', () => {
    const item = first(create()); store.claim(item.id); store.defer(item.id);
    expect(store.item(item.id)).toMatchObject({ status: 'queued', retry_count: 0, billing_state: 'reserved' });
    expect(balance()).toBe(95.5); expect(store.claim(item.id)).toBeNull();
  });
  it('survives re-instantiation without re-deducting or losing state', () => {
    const id = create(); const item = first(id); start(item.id);
    store = new VideoBatchStore(sql, ledger);
    expect(store.detail(id, 1).items[0].content_id).toBe(10); expect(create()).toBe(id); expect(balance()).toBe(95.5);
  });
  it('blocks other users from viewing, cancelling, retrying, or attaching tasks', () => {
    const id = create(); const item = first(id); store.claim(item.id);
    expect(() => store.detail(id, 9)).toThrow(); expect(() => store.cancelPending(id, 9)).toThrow();
    expect(() => store.retryFailed(id, 9, 'key')).toThrow(); expect(() => store.context(item.id, 1, 9)).toThrow();
    expect(balance()).toBe(95.5);
  });
  it('requires explicit confirmation before automatic retry', () => {
    expect(canRetryBatchFailure('network timeout', false)).toBe(false);
    expect(canRetryBatchFailure('渲染引擎异常', true)).toBe(true);
  });
  it('does not treat an HTTP 200 error envelope as a confirmed generation failure', () => {
    expect(isBatchQueryUncertain({ status: 'error', code: 502 }, 'error')).toBe(true);
    expect(isBatchQueryUncertain({ data: { success: false } }, '')).toBe(true);
    expect(isBatchQueryUncertain({ data: { status: 'failed', fail_reason: 'render failed' } }, 'failed')).toBe(false);
  });
  it('prevents failover on ambiguous submit responses but preserves ordinary-video behavior', () => {
    expect(() => guardBatchSubmissionResponse(true, { status: 502 })).toThrow('不确定');
    expect(() => guardBatchSubmissionResponse(true, { status: 408 })).toThrow();
    expect(() => guardBatchSubmissionResponse(true, { status: 429 })).not.toThrow();
    expect(() => guardBatchSubmissionResponse(false, { status: 502 })).not.toThrow();
  });
});
