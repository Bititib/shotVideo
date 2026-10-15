import { describe, expect, it } from 'vitest';
import { extractImageUpstreamTaskId } from '../server/services/imageTaskMetadataService';

describe('image upstream task metadata', () => {
  it('prefers public task identifiers returned in the response body', () => {
    expect(extractImageUpstreamTaskId({ task_id: 'task_public', id: 'internal-id' }, new Headers({ 'x-request-id': 'request-id' })))
      .toBe('task_public');
    expect(extractImageUpstreamTaskId({ id: 'internal-id', data: [{ task_id: 'nested-public-task' }] }))
      .toBe('nested-public-task');
    expect(extractImageUpstreamTaskId({ data: [{ taskId: 'nested-task' }] })).toBe('nested-task');
  });

  it('falls back to an upstream request identifier for synchronous image APIs', () => {
    expect(extractImageUpstreamTaskId({ data: [{ url: 'https://example.com/image.png' }] }, new Headers({ 'x-request-id': 'req-image-1' })))
      .toBe('req-image-1');
  });

  it.each([
    { request_id: 'req-body' }, { requestId: 'req-body' },
    { data: { request_id: 'req-body' } }, { data: [{ requestId: 'req-body' }] },
  ])('reads synchronous request identifiers from the response body (%j)', payload => {
    expect(extractImageUpstreamTaskId(payload)).toBe('req-body');
  });

  it('keeps task identifiers ahead of request identifiers and skips invalid fields', () => {
    expect(extractImageUpstreamTaskId({ task_id: ' ', taskId: {}, data: [{ task_id: 'task-public' }], request_id: 'req-body' })).toBe('task-public');
    expect(extractImageUpstreamTaskId({ request_id: 'req-body', id: 'internal' })).toBe('req-body');
    expect(extractImageUpstreamTaskId({ id: 0 })).toBe('0');
    expect(extractImageUpstreamTaskId({ task_id: {}, request_id: [] }, new Headers({ 'x-request-id': 'req-header' }))).toBe('req-header');
    expect(extractImageUpstreamTaskId({ data: [{ url: 'https://example.com/image.png' }] })).toBe('');
  });
});

it('recognizes nested error identifiers and case-insensitive plain headers', () => {
  expect(extractImageUpstreamTaskId({ error: { request_id: 'req-error' } })).toBe('req-error');
  expect(extractImageUpstreamTaskId({}, { 'X-Request-ID': 'req-header' })).toBe('req-header');
  expect(extractImageUpstreamTaskId({ result: { task_id: 'task-result' } })).toBe('task-result');
});
