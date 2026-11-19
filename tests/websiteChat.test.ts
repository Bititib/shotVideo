import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { db, sqlite } from '../server/db/index.js';
import { ensureFundLedger } from '../server/db/fundLedger.js';
import { users, models, modelPricing } from '../server/db/schema.js';
import { env } from '../server/config/env.js';
import { ChannelService } from '../server/services/channelService.js';
import { ensureBillingReservations } from '../server/services/billingReservation.js';
import websiteChat from '../server/routes/websiteChat.js';
import type { ChatEvent, ChatTurn } from '../shared/websiteChat.js';

vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());

const model = 'chat-test';
const key = 'image2pro-hidden-key-test';
const localFetch = globalThis.fetch;
const upstream = vi.fn<typeof fetch>();
const app = express();
app.use(express.json());
app.use('/api/chat', websiteChat);
app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error.status || 500).json({ error: error.message });
});
const server = app.listen(0, '127.0.0.1');
const ready = once(server, 'listening');
const auth = (userId: number) => 'Bearer ' + jwt.sign({ userId }, env.JWT_SECRET);

function request(path: string, options: RequestInit = {}, userId = 1) {
  return localFetch('http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api/chat' + path, {
    ...options, headers: { Authorization: auth(userId), 'Content-Type': 'application/json' },
  });
}

const conversation = (id: string) => '/conversations/' + id;
const submit = (id: string, requestId: string, question = '第一条消息', create = true, signal?: AbortSignal) =>
  request(conversation(id) + '/turns', { method: 'POST', body: JSON.stringify({ model, question, requestId, create }), signal });
const balance = () => (sqlite.prepare('SELECT balance FROM users WHERE id=1').get() as { balance: number }).balance;
const bills = () => sqlite.prepare('SELECT state,actual FROM billing_reservations ORDER BY rowid').all();
const sse = (value: unknown) => 'data: ' + (value === '[DONE]' ? value : JSON.stringify(value)) + '\n\n';
const delta = (content: string) => sse({ choices: [{ delta: { content } }] });
const usage = sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } });
const done = sse('[DONE]');
const reply = (text: string, terminator = done) => new Response(delta(text) + usage + terminator, { headers: { 'Content-Type': 'text/event-stream' } });

async function events(response: Response): Promise<ChatEvent[]> {
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  return (await response.text()).split('\n\n').filter(Boolean).map(line => JSON.parse(line.slice(6)));
}

beforeAll(async () => { await ready; ensureFundLedger(sqlite); ensureBillingReservations(); });
beforeEach(() => {
  sqlite.exec('SAVEPOINT website_chat_test');
  upstream.mockReset();
  vi.stubGlobal('fetch', upstream);
  db.insert(users).values([1, 2].map(id => ({ id, email: `chat${id}@example.test`, username: 'test', passwordHash: 'test', balance: 100 }))).run();
  db.insert(models).values([
    { modelId: model, displayName: 'Chat', provider: 'image2pro', capabilities: '["text"]' },
    { modelId: 'image-test', displayName: 'Image', provider: 'image2pro', capabilities: '["image"]' },
  ]).run();
  ChannelService.createChannel({ name: 'Private upstream name', type: 'image2pro', baseUrl: 'https://api.image2pro.top/v1',
    apiKey: key, supportedModels: [model, 'image-test'], modelMapping: { [model]: 'upstream-test' } });
  db.insert(modelPricing).values({ modelPattern: model, billingType: 'per_token', inputPrice: 1000, outputPrice: 2000 }).run();
});
afterEach(() => { vi.unstubAllGlobals(); sqlite.exec('ROLLBACK TO website_chat_test; RELEASE website_chat_test'); });
afterAll(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

it('streams and saves both turns, reuses context, and charges the website balance once per reply', async () => {
  const id = randomUUID();
  const requestId = randomUUID();
  upstream.mockResolvedValueOnce(reply('第一条回复')).mockResolvedValueOnce(reply('第二条回复'));
  expect(await (await request('/models')).json()).toEqual([{ id: model, name: model }]);
  const first = await events(await submit(id, requestId));
  expect(first).toEqual([{ delta: '第一条回复' }, { turn: expect.objectContaining({ id: requestId, answer: '第一条回复', status: 'complete' }) }]);

  const duplicate = await submit(id, requestId);
  expect(await duplicate.json()).toMatchObject({ id: requestId, status: 'complete' });
  await events(await submit(id, randomUUID(), '继续', false));
  expect(upstream).toHaveBeenCalledTimes(2);
  const [url, options] = upstream.mock.calls[1];
  expect(url).toBe('https://api.image2pro.top/v1/chat/completions');
  expect(JSON.parse(String(options?.body))).toMatchObject({ model: 'upstream-test', stream: true, messages: [
    { role: 'user', content: '第一条消息' }, { role: 'assistant', content: '第一条回复' }, { role: 'user', content: '继续' },
  ] });
  expect(await (await request('/conversations')).json()).toEqual([expect.objectContaining({ id, title: '第一条消息' })]);
  expect(await (await request(conversation(id))).json()).toHaveLength(2);
  expect(bills()).toEqual([{ state: 'settled', actual: 0.05 }, { state: 'settled', actual: 0.05 }]);
  expect(balance()).toBeCloseTo(99.9);
});

it('isolates history and refuses replay after deletion', async () => {
  const id = randomUUID(), requestId = randomUUID();
  upstream.mockResolvedValueOnce(reply('private'));
  await events(await submit(id, requestId));
  for (const method of ['GET', 'DELETE']) expect((await request(conversation(id), { method }, 2)).status).toBe(404);
  expect(await (await request('/conversations', {}, 2)).json()).toEqual([]);
  expect((await request(conversation(id), {}, 0)).status).toBe(401);
  expect((await request(conversation(id), { method: 'DELETE' })).ok).toBe(true);
  expect((await submit(id, requestId)).status).toBe(404);
  expect(upstream).toHaveBeenCalledOnce();
});

it('continues a saved reply on browser disconnect while blocking concurrent paid duplicates', async () => {
  const id = randomUUID(), requestId = randomUUID();
  const browser = new AbortController();
  let stream!: ReadableStreamDefaultController;
  const bytes = new TextEncoder();
  upstream.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { stream = controller; } })));
  const response = await submit(id, requestId, undefined, true, browser.signal);
  stream.enqueue(bytes.encode(delta('已保存的片段')));
  expect(new TextDecoder().decode((await response.body!.getReader().read()).value)).toContain('已保存的片段');
  browser.abort();

  expect((await (await submit(id, requestId)).json()).status).toBe('running');
  expect((await submit(id, randomUUID(), '另一条消息', false)).status).toBe(409);
  stream.enqueue(bytes.encode(delta('和尾部') + usage + done));
  stream.close();
  await vi.waitFor(async () => {
    const [turn] = await (await request(conversation(id))).json() as ChatTurn[];
    expect(turn).toMatchObject({ status: 'complete', answer: '已保存的片段和尾部' });
  });
  expect(upstream).toHaveBeenCalledOnce();
  expect(bills()).toEqual([{ state: 'settled', actual: 0.05 }]);
});

it('refunds an explicit rejection and preserves its public reason and code', async () => {
  const id = randomUUID(), requestId = randomUUID();
  upstream.mockResolvedValueOnce(Response.json({ error: { code: 'model_busy', message: '具体拒绝原因 ' + key } }, { status: 429 }));
  const result = await events(await submit(id, requestId));
  expect(JSON.stringify(result)).toContain('model_busy');
  expect(JSON.stringify(result)).toContain('具体拒绝原因');
  expect(JSON.stringify(result)).not.toContain(key);
  expect(result).toEqual([{ turn: expect.objectContaining({ status: 'failed' }) }]);
  await submit(id, requestId);
  expect(upstream).toHaveBeenCalledOnce();
  expect(bills()).toEqual([{ state: 'refunded', actual: 0 }]);
  expect(balance()).toBeCloseTo(100);
});

it('keeps a partial stream and its single reservation under review', async () => {
  const id = randomUUID(), requestId = randomUUID();
  upstream.mockResolvedValueOnce(reply('部分内容', ''));
  const result = await events(await submit(id, requestId));
  expect(result.at(-1)).toEqual({ turn: expect.objectContaining({ status: 'review', answer: '部分内容' }) });
  expect(await (await submit(id, requestId)).json()).toMatchObject({ status: 'review' });
  expect(upstream).toHaveBeenCalledOnce();
  expect(bills()).toEqual([{ state: 'review', actual: null }]);
  expect(balance()).toBeLessThan(100);
});

it('recovers an expired in-flight request after an interruption without replay or refund', async () => {
  const id = randomUUID(), requestId = randomUUID();
  let stream!: ReadableStreamDefaultController;
  upstream.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { stream = controller; } })));
  const response = await submit(id, requestId);
  await vi.waitFor(() => expect(bills()).toEqual([{ state: 'reserved', actual: null }]));
  const afterReservation = balance();
  sqlite.prepare('UPDATE website_chat_turns SET deadline = 0 WHERE conversation_id = ?').run(id);
  expect(await (await request(conversation(id))).json()).toEqual([expect.objectContaining({ id: requestId, status: 'review' })]);
  expect(await (await submit(id, requestId)).json()).toMatchObject({ status: 'review' });
  stream.close();
  await response.text();
  expect(upstream).toHaveBeenCalledOnce();
  expect(bills()).toEqual([{ state: 'review', actual: null }]);
  expect(balance()).toBe(afterReservation);
});
