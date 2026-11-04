import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/services/videoLocalizationService.js', () => ({ downloadAndLocalizeVideo: vi.fn(async () => '/uploads/privacy-result.mp4') }));
import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../server/db/index.js';
import { channels, contents, apiTokens, apiLogs, models, modelPricing, users } from '../server/db/schema.js';
import { env } from '../server/config/env.js';
import v1Routes from '../server/routes/v1.js';
import adminRoutes from '../server/routes/admin.js';
import { ChannelService } from '../server/services/channelService.js';
import { createApiVideoRequestStore } from '../server/services/apiVideoRequestStore.js';
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService.js';
import * as videoCompatibility from '../server/services/videoCompatibilityService.js';

const nativeFetch = globalThis.fetch;
const userKey = 'sk-user-test-only', providerKey = 'sk-provider-test-only';
const diagnostic = '[上游诊断 funai 提交] HTTP 403 code=insufficient_user_quota：insufficient_user_quota: 用户额度不足';
let server: Server, base: string, channelId: number;
let upstream: ReturnType<typeof vi.fn>;
const balance = () => db.select().from(apiTokens).get()!.balance;
const lastContent = () => db.select().from(contents).all().at(-1)!;
const api = (path: string, body?: any, headers: Record<string, string> = {}) => nativeFetch(base + path, {
  method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + userKey, 'Content-Type': 'application/json', ...headers },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/v1', v1Routes); app.use('/api/admin', adminRoutes);
  server = await new Promise<Server>(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  base = 'http://127.0.0.1:' + (server.address() as any).port;
});
beforeEach(async () => {
  for (const { name } of sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) sqlite.exec(`DELETE FROM "${name}"`);
  db.insert(users).values({ id: 1, username: 'privacy-admin', email: 'privacy@example.test', passwordHash: 'unused', role: 'admin', balance: 100 }).run();
  db.insert(apiTokens).values({ id: 1, userId: 1, name: 'privacy-test', tokenKey: userKey, balance: 100 }).run();
  upstream = vi.fn(async () => Response.json({ data: [{ id: 'gemini-omni-flash' }, { id: 'gpt-image-2' }] }));
  vi.stubGlobal('fetch', upstream);
  channelId = ChannelService.createChannel({ name: 'Private Orion Channel', type: 'funai', baseUrl: 'https://private-provider.invalid', apiKey: providerKey });
  await ChannelService.syncModels(channelId);
  for (const model of db.select().from(models).all()) {
    db.update(models).set({ isActive: 1 }).where(eq(models.id, model.id)).run();
    db.insert(modelPricing).values({ modelPattern: model.modelId, billingType: 'per_call', inputPrice: 0.6, outputPrice: 0 }).run();
  }
  upstream.mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); sqlite.close(); });

async function pollUntilSettled(id: string) {
  let body: any;
  await vi.waitFor(async () => { body = await (await api('/v1/videos/' + id)).json(); expect(['failed', 'completed'].includes(body.status) || body.requires_review).toBe(true); });
  return body;
}
function assertPrivate(body: any) {
  expect(JSON.stringify(body)).not.toMatch(/funai|private-provider|Private Orion|上游诊断|sk-provider|upstream_task_id|routingAttempts/i);
}
const video = { model: 'gemini-omni-flash', prompt: 'cinematic camera movement', seconds: 10, ratio: '9:16' };
function enableChat() {
  db.update(channels).set({ supportedModels: '["chat-public"]', modelMapping: '{"chat-public":"private-chat"}' }).where(eq(channels.id, channelId)).run();
  db.insert(models).values({ modelId: 'chat-public', displayName: 'Chat', provider: 'funai', capabilities: '["chat"]', isActive: 1 }).run();
}

describe('real user API routes keep channel diagnostics administrator-only', () => {
  it('handles the screenshot quota rejection, replay and polling with one refund and complete admin diagnostics', async () => {
    upstream.mockImplementation(async () => Response.json({ error: { code: 'insufficient_user_quota', message: '用户额度不足，剩余额度 ¥0.000000' } }, { status: 403 }));
    const first = await (await api('/v1/videos', video)).json() as any;
    assertPrivate(first); expect(first.id).toMatch(/^task_req_/);
    const result = await pollUntilSettled(first.id);
    assertPrivate(result);
    expect(result).toMatchObject({ status: 'failed', billing_status: 'refunded', refund_amount: 0.6 });
    for (const field of ['error', 'error_message', 'progress_text']) expect(result[field]).toContain('insufficient_user_quota');
    expect(balance()).toBe(100);
    const replay = await (await api('/v1/videos', video)).json(); assertPrivate(replay);
    await api('/v1/videos/' + first.id);
    expect(upstream).toHaveBeenCalledOnce(); expect(balance()).toBe(100);
    const record = lastContent(), meta = JSON.parse(record.metadata);
    expect(meta.error).toContain('[上游诊断 funai 提交]');
    expect(meta.routingAttempts[0].reason).toContain('HTTP 403'); expect(meta.channelId).toBe(channelId);
    expect(db.select().from(apiLogs).get()!.errorMessage).toBe(meta.error);
    const adminToken = jwt.sign({ userId: 1, role: 'admin' }, env.JWT_SECRET);
    const admin = await (await nativeFetch(base + '/api/admin/contents/' + record.id, { headers: { Authorization: 'Bearer ' + adminToken } })).json() as any;
    expect(JSON.parse(admin.metadata)).toMatchObject({ error: meta.error, channelName: 'Private Orion Channel' });
  });

  it('keeps an uncertain submission pending without a new POST or refund while hiding the internal provider', async () => {
    upstream.mockImplementation(async () => { throw new Error('socket disconnected'); });
    const first = await (await api('/v1/videos', video)).json() as any;
    const result = await pollUntilSettled(first.id); assertPrivate(result);
    expect(result).toMatchObject({ requires_review: true, billing_status: 'review' });
    expect(result.status).not.toBe('failed'); expect(balance()).toBe(99.4);
    await api('/v1/videos', video); await api('/v1/videos/' + first.id);
    expect(upstream).toHaveBeenCalledOnce(); expect(balance()).toBe(99.4);
    expect(JSON.parse(lastContent().metadata).error).toContain('funai');
  });

  it('also covers immediate image submission errors and structured chat errors without changing business codes', async () => {
    upstream.mockImplementation(async () => Response.json({ error: { code: 'invalid_image', type: 'invalid_request_error', message: 'reference image 2 invalid (Private Orion Channel) at private-provider.invalid' } }, { status: 400 }));
    const response = await api('/v1/images/generations', { model: 'gpt-image-2-2k', prompt: 'product photo', resolution: '2K' });
    const body = await response.json() as any; assertPrivate(body);
    expect(JSON.stringify(body), JSON.stringify(body)).toContain('invalid_image'); expect(JSON.stringify(body)).toContain('reference image 2 invalid');
    expect(balance()).toBe(100);
    expect(JSON.parse(lastContent().metadata).error).toContain('Private Orion Channel');
    enableChat();
    const chat = await (await api('/v1/chat/completions', { model: 'chat-public', messages: [{ role: 'user', content: 'hello' }] })).json() as any;
    assertPrivate(chat); expect(chat.error).toMatchObject({ code: 'invalid_image', type: 'invalid_request_error' });
    expect(chat.error.message).toContain('reference image 2 invalid');
  });

  it.each([false, true])('handles split SSE frames with an error=%s, preserving normal output and administrator diagnostics', async failure => {
    enableChat();
    const normal = { choices: [{ delta: { content: 'FunAI is mentioned in the generated text：你好' } }] };
    const event = failure ? { error: { code: 'invalid_image', message: diagnostic, provider: 'funai' } } : normal;
    const bytes = new TextEncoder().encode('data:' + JSON.stringify(event) + '\n\ndata: ' + JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n');
    upstream.mockImplementation(async () => new Response(new ReadableStream({ start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 13) controller.enqueue(bytes.slice(offset, offset + 13));
      controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const result = await api('/v1/chat/completions', { model: 'chat-public', messages: [{ role: 'user', content: 'hello' }], stream: true });
    expect(result.headers.get('content-type')).toContain('text/event-stream');
    const text = await result.text();
    const events = text.split('\n').filter(line => line.startsWith('data:') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(5)));
    if (failure) {
      assertPrivate(events); expect(events[0].error.code).toBe('invalid_image');
      expect(events[0].error.message).toContain('用户额度不足');
      await vi.waitFor(() => expect(db.select().from(apiLogs).get()?.errorMessage).toContain('funai'));
    } else expect(events[0]).toEqual(normal);
    expect(events[1].usage).toEqual({ prompt_tokens: 1, completion_tokens: 1 });
    expect(text).toContain('data: [DONE]');
  });

  it('projects historical task failures and usage logs without modifying their saved diagnostics', async () => {
    const record = db.insert(contents).values({ userId: 1, type: 'video', modelId: 'funai-gemini-omni-flash', status: 'failed', cost: 0,
      metadata: JSON.stringify({ tokenId: 1, error: diagnostic, progressText: diagnostic, channelId, actualChannel: 'funai', billingStatus: 'refunded', refundAmount: 0.6 }) }).returning().get();
    db.insert(apiLogs).values({ tokenId: 1, channelId, model: 'gemini-omni-flash', upstreamModel: 'private-variant', status: 'error', errorMessage: diagnostic }).run();
    const result = await (await api('/v1/videos/task_' + record.id)).json(); assertPrivate(result);
    const usage = await (await api('/v1/billing/usage')).json() as any; assertPrivate(usage);
    expect(usage.items[0].error_message).toContain('insufficient_user_quota');
    expect(db.select().from(apiLogs).get()!.errorMessage).toBe(diagnostic);
    expect(lastContent().metadata).toBe(record.metadata);
  });

  it('filters previously cached rejection responses on replay without changing their stored evidence', async () => {
    const store = createApiVideoRequestStore(sqlite);
    const request = store.claim(1, 1, 'legacy-key-hash', 'legacy-fingerprint').record;
    const raw = JSON.stringify({ error: { message: diagnostic, code: 'insufficient_user_quota' }, channel_name: 'Private Orion Channel' });
    store.finishWithoutContent(request.id, 403, raw);
    const response = await api('/v1/videos/' + request.id);
    expect(response.status).toBe(403);
    const body = await response.json() as any; assertPrivate(body);
    expect(body.error.code).toBe('insufficient_user_quota');
    expect(store.get(request.id)?.responseBody).toBe(raw); expect(upstream).not.toHaveBeenCalled(); expect(balance()).toBe(100);
  });

  it.each(['content', 'files'])('hides diagnostics from the %s download error without changing the completed task or balance', async endpoint => {
    const record = db.insert(contents).values({ userId: 1, type: 'video', modelId: 'funai-gemini-omni-flash', status: 'completed', cost: 0.6,
      resultUrl: 'https://private-provider.invalid/result.mp4', metadata: JSON.stringify({ tokenId: 1, channelId }) }).returning().get();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    if (endpoint === 'content') vi.mocked(downloadAndLocalizeVideo).mockRejectedValueOnce(new Error(diagnostic));
    else {
      db.update(channels).set({ supportedModels: '["video"]' }).where(eq(channels.id, channelId)).run();
      vi.spyOn(videoCompatibility, 'cacheVideoForDelivery').mockRejectedValueOnce(new Error(diagnostic));
    }
    const response = await api(endpoint === 'content' ? '/v1/videos/task_' + record.id + '/content' : '/v1/files/video?id=opaque-original');
    expect(response.status).toBe(502);
    const body = await response.json() as any; assertPrivate(body); expect(body.error).toContain('insufficient_user_quota');
    expect(warning.mock.calls.flat().join(' ')).toContain('funai');
    expect(lastContent()).toMatchObject({ status: 'completed', cost: 0.6 }); expect(balance()).toBe(100);
  });
});
