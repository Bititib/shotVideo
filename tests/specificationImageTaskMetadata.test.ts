import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
vi.mock('../server/services/publicReferenceService.js', () => ({ publishReferenceUrl: () => 'https://app.invalid/reference.png' }));
vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const sqlite = new Database(':memory:'); return { sqlite, db: drizzle(sqlite) };
});
import { generateSpecificationImage } from '../server/services/specificationAdapters';
const target = { channel: { type: 'openai', name: 'Pidoi 图片渠道', baseUrl: 'https://provider.invalid', apiKey: 'fixture', timeout: 900000 },
  route: { executionModel: 'gpt-image-2', upstreamModel: 'gpt-image-2' } } as any;
const request = (edit: boolean) => ({ prompt: 'demo', input: { ratio: '16:9', resolution: '4K', quality: 'high' },
  images: edit ? ['data:image/png;base64,aA=='] : [], body: {}, publicBaseUrl: 'https://app.invalid' } as any);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const cases = [
  { name: 'header-only request ID', extra: {}, headers: { 'x-request-id': 'req-header' }, expected: 'req-header' },
  { name: 'top-level task ID', extra: { task_id: 'task-public', request_id: 'req-body' }, headers: { 'x-request-id': 'req-header' }, expected: 'task-public' },
  { name: 'nested task ID', extra: { data: [{ url: 'https://result.invalid/image.png', task_id: 'task-nested' }] }, headers: {}, expected: 'task-nested' },
  { name: 'body request ID', extra: { request_id: 'req-body' }, headers: {}, expected: 'req-body' },
  { name: 'nested request ID', extra: { data: [{ url: 'https://result.invalid/image.png', requestId: 'req-nested' }] }, headers: {}, expected: 'req-nested' },
  { name: 'no upstream identifier', extra: {}, headers: {}, expected: '' },
];
it.each(cases.flatMap(test => [false, true].map(edit => ({ ...test, edit }))))('preserves $name for managed images (edit=$edit)', async ({ extra, headers, expected, edit }) => {
  vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  const payload = { data: [{ url: 'https://result.invalid/image.png' }], ...extra };
  const fetchMock = vi.fn(async () => Response.json(payload, { headers })); vi.stubGlobal('fetch', fetchMock);
  const starting = vi.fn(), submitted = vi.fn();
  const result = await generateSpecificationImage(target, request(edit), starting, submitted);
  expect(result.imageUrl).toBe('https://result.invalid/image.png'); expect(result.taskId).toBe(expected);
  expect(result.raw).toEqual(payload); expect(starting).toHaveBeenCalledTimes(1);
  expect(submitted.mock.calls).toEqual(expected ? [[expected]] : []);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe('https://provider.invalid/v1/images/' + (edit ? 'edits' : 'generations'));
});
it('reports an available upstream ID before a missing image result is rejected', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [] }, { headers: { 'x-request-id': 'req-missing-image' } })));
  const submitted = vi.fn();
  await expect(generateSpecificationImage(target, request(false), vi.fn(), submitted)).rejects.toMatchObject({ uncertain: true });
  expect(submitted).toHaveBeenCalledWith('req-missing-image');
});

it.each([false, true])('captures header IDs when the response body fails (edit=%s)', async edit => {
  const response = new Response('{invalid', { headers: { 'x-request-id': 'req-interrupted' } });
  vi.stubGlobal('fetch', vi.fn(async () => response));
  vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  const submitted = vi.fn(), evidence = vi.fn();
  await expect(generateSpecificationImage(target, request(edit), vi.fn(), submitted, evidence)).rejects.toThrow('无法解析');
  expect(evidence).toHaveBeenLastCalledWith({ id: 'req-interrupted', state: 'captured', httpStatus: 200 });
  expect(submitted).not.toHaveBeenCalled();
});
it('captures error-body request IDs without pretending submission succeeded', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'invalid input', request_id: 'req-rejected' } }, { status: 400 })));
  const submitted = vi.fn(), evidence = vi.fn();
  await expect(generateSpecificationImage(target, request(false), vi.fn(), submitted, evidence)).rejects.toThrow('400');
  expect(evidence).toHaveBeenLastCalledWith({ id: 'req-rejected', state: 'captured', httpStatus: 400 });
  expect(submitted).not.toHaveBeenCalled();
});
it('records that a complete response did not provide an identifier', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ url: 'https://result.invalid/image.png' }] })));
  const evidence = vi.fn();
  await generateSpecificationImage(target, request(false), vi.fn(), vi.fn(), evidence);
  expect(evidence).toHaveBeenLastCalledWith({ id: '', state: 'response_without_id', httpStatus: 200 });
});
