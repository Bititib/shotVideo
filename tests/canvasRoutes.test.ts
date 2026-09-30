import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { newDocument } from '../client/src/canvas/model';

vi.mock('../server/db/index', async () => {
  const { default: Database } = await import('better-sqlite3');
  return { sqlite: new Database(':memory:') };
});
vi.mock('../server/middleware/auth', () => ({ authMiddleware: (req: any, res: any, next: any) => {
  const id = Number(req.headers['x-test-owner']);
  if (!id) return res.status(401).json({ error: '请先登录' });
  req.userId = id; next();
} }));
import canvasRouter from '../server/routes/canvas';
import { canvasRequestMiddleware, recordCanvasEvent } from '../server/middleware/canvasRequest';
import { authMiddleware } from '../server/middleware/auth';
import { sqlite } from '../server/db/index';

let server: Server, base: string, submissions = 0;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/api/canvas', canvasRouter);
  app.post('/generate', authMiddleware, canvasRequestMiddleware, (req, res) => {
    submissions++; recordCanvasEvent(req, { type: 'content_id', contentId: 73 });
    res.type('text/event-stream').send('data: {"type":"content_id","contentId":73}\n\n');
  });
  server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); sqlite.close(); });
const headers = { 'Content-Type': 'application/json', 'x-test-owner': '1' };
describe('canvas HTTP integration without paid providers', () => {
  it('requires authentication and rejects stale cloud revisions', async () => {
    expect((await fetch(`${base}/api/canvas/workspace`)).status).toBe(401);
    const project = newDocument(), body = JSON.stringify({ revision: 0, workspace: { version: 2, activeId: project.id, projects: [project] } });
    expect((await fetch(`${base}/api/canvas/workspace`, { method: 'PUT', headers, body })).status).toBe(200);
    expect((await fetch(`${base}/api/canvas/workspace`, { method: 'PUT', headers, body })).status).toBe(409);
    const other = await fetch(`${base}/api/canvas/workspace`, { headers: { 'x-test-owner': '2' } }).then(r => r.json());
    expect(other.workspace.projects).toHaveLength(0);
  });
  it('does not submit the same request twice and recovers the content ID through HTTP', async () => {
    const body = JSON.stringify({ canvasRequestId: 'canvas-request-123456', prompt: '测试' });
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${base}/generate`, { method: 'POST', headers, body });
      expect(response.status).toBe(200); expect(await response.text()).toContain('73');
    }
    expect(submissions).toBe(1);
    const record = await fetch(`${base}/api/canvas/requests/canvas-request-123456`, { headers }).then(r => r.json());
    expect(record.contentId).toBe(73);
    expect((await fetch(`${base}/api/canvas/requests/canvas-request-123456`, { headers: { 'x-test-owner': '2' } })).status).toBe(404);
    expect((await fetch(`${base}/generate`, { method: 'POST', headers, body: JSON.stringify({ canvasRequestId: 'canvas-request-123456', prompt: '不同参数' }) })).status).toBe(409);
    expect(submissions).toBe(1);
  });
});
