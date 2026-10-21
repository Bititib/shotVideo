import { expect, it } from 'vitest';
import { isSnumomNoChannelRejection } from '../server/services/snumomSubmissionRejection';

const channel = { type: 'snumom' };
const message = 'No available channel for model grok-imagine-video-1.5（按次） under group default (distributor) (request id: trace_123)';
const error = { error: { message, type: 'new_api_error', code: 'model_not_found' }, request_id: 'trace_123' };

it.each([200, 400, 404, 500, 503])('recognizes complete snumom routing rejection at HTTP %s', status => {
  expect(isSnumomNoChannelRejection(status, JSON.stringify(error), channel)).toBe(true);
  expect(isSnumomNoChannelRejection(status, JSON.stringify({ error: message }), channel)).toBe(true);
});

it.each([408, 502, 504, 524])('never converts timeout/gateway HTTP %s into a confirmed rejection', status => {
  expect(isSnumomNoChannelRejection(status, JSON.stringify(error), channel)).toBe(false);
});

it.each([
  { ...error, task_id: 'task_known' }, { ...error, data: { id: 'task_known' } },
  { ...error, output: [{ video_url: 'https://example.com/video.mp4' }] },
  { ...error, status: 'queued' }, { ...error, status: 'completed' },
])('task/result evidence prevents rejection classification: %j', body => {
  expect(isSnumomNoChannelRejection(500, JSON.stringify(body), channel)).toBe(false);
});

it.each(['x-task-id', 'task-id', 'location'])('preserves task header %s', name => {
  expect(isSnumomNoChannelRejection(503, JSON.stringify(error), channel, new Headers({ [name]: 'task_known' }))).toBe(false);
});

it('does not match generic errors, HTML, truncated JSON, echoed prompts or other providers', () => {
  for (const text of ['service unavailable', '<html>' + message + '</html>', JSON.stringify(error).slice(0, -1),
    JSON.stringify({ error: { message: 'upstream timeout: ' + message } }),
    JSON.stringify({ prompt: message, error: { message: 'service unavailable' } })]) {
    expect(isSnumomNoChannelRejection(503, text, channel)).toBe(false);
  }
  expect(isSnumomNoChannelRejection(500, JSON.stringify(error), { type: 'other' })).toBe(false);
});
