import { beforeEach, afterEach, afterAll, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/services/videoLocalizationService.js', () => ({ downloadAndLocalizeVideo: vi.fn(async () => '/uploads/huss-original.mp4') }));
import { db, sqlite } from '../server/db/index.js';
import { users, contents, channels } from '../server/db/schema.js';
import { eq } from 'drizzle-orm';
import { reserveUserCharge, linkReservationContent } from '../server/services/billingReservation.js';
import { VideoRecoveryService } from '../server/services/videoRecoveryService.js';
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService.js';
let id: number, reservationId: string;
const saved = () => db.select().from(contents).where(eq(contents.id, id)).get()!;
const balance = () => db.select().from(users).where(eq(users.id, 1)).get()!.balance;
const change = (values: any) => db.update(contents).set({ metadata: JSON.stringify({ ...JSON.parse(saved().metadata), ...values }) }).where(eq(contents.id, id)).run();
beforeEach(() => {
  vi.clearAllMocks();
  db.delete(contents).run(); db.delete(channels).run(); db.delete(users).run();
  db.insert(users).values({ id: 1, email: 'recovery@test.invalid', username: 'test', passwordHash: 'test', balance: 100 }).run();
  db.insert(channels).values({ id: 1, name: 'HUSS', type: 'huss', baseUrl: 'https://www.huss.top', apiKey: 'private-key', status: 1 }).run();
  id = Number(db.insert(contents).values({ userId: 1, type: 'video', modelId: 'bb-2.5-301010', title: 'original', status: 'review', cost: 6, metadata: '{}' }).run().lastInsertRowid);
  const charge = reserveUserCharge(1, 6, 'specification_generate', { contentId: id }); reservationId = charge.id;
  linkReservationContent(charge.id, id);
  change({ managedSpecification: true, channelId: 1, videoId: 'task_original', actualModel: 'bb-2.5-301010', requestedModel: 'bb-2.5-301010',
    billingReservationId: charge.id, reservedCost: 6, count: 1, requiresReview: true, reviewKind: 'query' });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
afterAll(() => sqlite.close());
it('routes the existing admin recover entry through HUSS and its original reservation', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    expect(url).toBe('https://www.huss.top/v1/videos/task_original'); expect(init?.method).toBe('GET');
    return Response.json({ id: 'task_original', status: 'completed', url: 'https://cdn.example/result.mp4?signature=original' });
  }));
  expect(await VideoRecoveryService.recover(id)).toMatchObject({ status: 'processing', chargedAmount: 0 });
  await vi.waitFor(() => expect(saved().status).toBe('completed'));
  expect(balance()).toBe(94); expect(saved().cost).toBe(6);
  expect(sqlite.prepare('SELECT state,actual FROM billing_reservations WHERE id=?').get(reservationId)).toMatchObject({ state: 'settled', actual: 6 });
  expect(await VideoRecoveryService.recover(id)).toMatchObject({ status: 'completed', chargedAmount: 0 });
  expect(fetch).toHaveBeenCalledOnce(); expect(downloadAndLocalizeVideo).toHaveBeenCalledOnce();
});
it('uses the specification refund path once for a confirmed HUSS failed task', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'task_original', status: 'failed', error: { code: 'unsupported_material', message: '素材被拒绝' } })));
  await Promise.all([VideoRecoveryService.recover(id), VideoRecoveryService.recover(id)]);
  await vi.waitFor(() => expect(saved().status).toBe('failed'));
  expect(balance()).toBe(100); expect(saved().cost).toBe(0);
  expect(JSON.parse(saved().metadata).error).toContain('unsupported_material');
  await expect(VideoRecoveryService.recover(id)).rejects.toMatchObject({ status: 409 });
  expect(fetch).toHaveBeenCalledOnce(); expect(balance()).toBe(100);
});
it('continues polling storage pending, without submitting or charging again', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ status: 'completed', storage_status: 'pending' }))
    .mockResolvedValueOnce(Response.json({ status: 'completed', url: 'https://cdn.example/final.mp4' })));
  await VideoRecoveryService.recover(id); await vi.advanceTimersByTimeAsync(100);
  expect(saved().status).toBe('processing'); expect(JSON.parse(saved().metadata).progressText).toContain('正在保存成品');
  expect(downloadAndLocalizeVideo).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(8100);
  expect(saved().status).toBe('completed'); expect(balance()).toBe(94);
  expect(vi.mocked(fetch).mock.calls.every(call => call[1]?.method === 'GET')).toBe(true);
});
it.each(['ownership','amount','refunded','missing_id'])('rejects unsafe recovery %s before network or billing', async scenario => {
  if (scenario === 'ownership') sqlite.prepare('UPDATE billing_reservations SET context=? WHERE id=?').run(JSON.stringify({ contentId: id + 1, userId: 1 }), reservationId);
  if (scenario === 'amount') change({ reservedCost: 100 });
  if (scenario === 'refunded') sqlite.prepare("UPDATE billing_reservations SET state='refunded' WHERE id=?").run(reservationId);
  if (scenario === 'missing_id') change({ videoId: '' });
  vi.stubGlobal('fetch', vi.fn());
  await expect(VideoRecoveryService.recover(id)).rejects.toMatchObject({ status: 409 });
  expect(fetch).not.toHaveBeenCalled(); expect(balance()).toBe(94);
});
it('clears a previous download error only after original task save and settlement succeed', async () => {
  change({ resultSaveError: 'HUSS/TOS HTTP 403 AccessDenied: Request has expired' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'task_original', status: 'completed', url: 'https://cdn.example/result.mp4' })));
  await VideoRecoveryService.recover(id);
  await vi.waitFor(() => expect(saved().status).toBe('completed'));
  expect(JSON.parse(saved().metadata).resultSaveError).toBeNull();
  expect(balance()).toBe(94); expect(saved().cost).toBe(6);
});
