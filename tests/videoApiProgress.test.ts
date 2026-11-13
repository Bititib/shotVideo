import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/routes/video.js', async importOriginal => ({
  ...await importOriginal<typeof import('../server/routes/video.js')>(),
  resumePollForTask: vi.fn(async () => {}),
}));
import express from 'express';
import type { Server } from 'node:http';
import { db, sqlite } from '../server/db/index.js';
import { apiTokens, contents, users } from '../server/db/schema.js';
import routes from '../server/routes/v1.js';

let server: Server, base: string;
beforeAll(async () => {
  db.insert(users).values({ id: 1, username: 'progress', email: 'progress@example.test', passwordHash: 'unused', balance: 100 }).run();
  db.insert(apiTokens).values({ id: 1, userId: 1, tokenKey: 'sk-progress-test', balance: 100 }).run();
  const app = express(); app.use('/v1', routes);
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = 'http://127.0.0.1:' + (server.address() as any).port;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); sqlite.close(); });

async function query(status: string, metadata: Record<string, any>) {
  const record = db.insert(contents).values({ userId: 1, type: 'video', modelId: 'test-video', status,
    metadata: JSON.stringify({ tokenId: 1, ...metadata }) }).returning().get();
  const response = await fetch(base + '/v1/videos/task_' + record.id, { headers: { Authorization: 'Bearer sk-progress-test' } });
  expect(response.status).toBe(200);
  return await response.json() as any;
}

describe('video progress through authenticated public GET and privacy middleware', () => {
  it('distinguishes website queue from upstream queue and does not reuse local queue position', async () => {
    const local = await query('queued', { actualChannel: 'hmstudio', queuePosition: 3, queueLimit: 10, progress: 0 });
    expect(local).toMatchObject({ status: 'queued', phase: 'website_queue', queue_scope: 'website', queue_position: 3, progress_known: false });
    const upstream = await query('processing', { actualChannel: 'hmstudio', queuePosition: 3, upstreamStatus: 'queued', progressText: '等待生成资源' });
    expect(upstream).toMatchObject({ status: 'queued', phase: 'upstream_queue', queue_scope: 'upstream', progress_text: '等待生成资源', progress_known: false });
    expect(upstream).not.toHaveProperty('queue_position');
    const unknownPosition = await query('queued', { actualChannel: 'hmstudio' });
    expect(unknownPosition).not.toHaveProperty('queue_position');
    expect(unknownPosition).not.toHaveProperty('queue_limit');
  });
  it('does not invent a queue or a percentage when the provider only acknowledged the task', async () => {
    const body = await query('processing', { videoId: 'private-id', upstreamStatus: 'submitted', progress: 0, progressKnown: false, progressText: '已受理，正在查询任务状态' });
    expect(body).toMatchObject({ status: 'processing', phase: 'accepted', progress_known: false, queue_scope: null });
    expect(body).not.toHaveProperty('upstream_task_id');
    expect(body).not.toHaveProperty('upstream_status');
    expect(await query('processing', { progress: 0 })).toMatchObject({ status: 'processing', phase: 'waiting', progress_known: false });
  });
  it('preserves detailed generation text and distinguishes a real zero from unknown progress', async () => {
    for (const progressKnown of [true, false]) {
      const body = await query('processing', { upstreamStatus: 'processing', progress: 0, progressKnown, progressText: '正在处理参考图片' });
      expect(body).toMatchObject({ status: 'processing', phase: 'generating', progress_known: progressKnown, progress: 0, progress_text: '正在处理参考图片' });
    }
    expect(await query('processing', { upstreamStatus: 'running', progress: 48, progressKnown: true, progressText: '渲染中' }))
      .toMatchObject({ phase: 'generating', progress: 48, progress_pct: 48, progress_known: true, progress_text: '渲染中' });
  });
  it('hides stale or invalid percentages and keeps review and saving distinct', async () => {
    for (const progress of [-4, 200, '50', null]) {
      expect(await query('processing', { upstreamStatus: 'running', progress, progressKnown: true })).toMatchObject({ phase: 'generating', progress_known: false, progress: 0 });
    }
    expect(await query('processing', { upstreamStatus: 'running', progress: 50, progressKnown: false })).toMatchObject({ progress_known: false, progress: 0 });
    expect(await query('processing', { upstreamStatus: 'completed', progress: 100, progressKnown: true })).toMatchObject({ phase: 'saving', progress_known: false });
    expect(await query('review', { requiresReview: true, reviewKind: 'query', progress: 50 })).toMatchObject({ phase: 'review', progress_known: false, requires_review: true });
  });
  it('preserves terminal states over stale upstream state and leaves the ledger unchanged', async () => {
    expect(await query('completed', { upstreamStatus: 'queued', progress: 0 })).toMatchObject({ status: 'completed', phase: 'completed', progress: 100, progress_known: true });
    expect(await query('failed', { upstreamStatus: 'running', progress: 80, error: '参考图不符合要求' })).toMatchObject({ status: 'failed', phase: 'failed', progress_known: false, error_message: '参考图不符合要求' });
    expect(db.select().from(apiTokens).get()!.balance).toBe(100);
  });
});
