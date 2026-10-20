import { describe, expect, it } from 'vitest';
import { extractVideoUpstreamTaskId, sanitizeUpstreamCreateResponse } from '../server/services/videoTaskMetadataService';

describe('video upstream task metadata', () => {
  it('recognizes task identifiers in common response envelopes', () => {
    expect(extractVideoUpstreamTaskId({ task_id: 'task_top' })).toBe('task_top');
    expect(extractVideoUpstreamTaskId({ data: { id: 'task_data' } })).toBe('task_data');
    expect(extractVideoUpstreamTaskId({ result: { taskId: 'task_result' } })).toBe('task_result');
    expect(extractVideoUpstreamTaskId({ output: { request_id: 'task_output' } })).toBe('task_output');
    expect(extractVideoUpstreamTaskId({ task: { id: 12345 } })).toBe('12345');
  });

  it('uses explicit task headers and task locations but never treats a trace id as a polling id', () => {
    expect(extractVideoUpstreamTaskId({}, new Headers({ 'x-task-id': 'task_header' }))).toBe('task_header');
    expect(extractVideoUpstreamTaskId({}, new Headers({ location: '/v1/videos/task_location' }))).toBe('task_location');
    expect(extractVideoUpstreamTaskId({}, new Headers({ 'x-request-id': 'trace-only' }))).toBe('');
  });

  it('redacts credentials while retaining reconciliation evidence', () => {
    expect(sanitizeUpstreamCreateResponse({ code: 200, data: { id: 'task_1' }, api_key: 'secret', token: 'secret' }))
      .toEqual({ code: 200, data: { id: 'task_1' }, api_key: '[redacted]', token: '[redacted]' });
  });
});
