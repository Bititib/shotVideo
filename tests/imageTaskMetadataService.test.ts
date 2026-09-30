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
});
