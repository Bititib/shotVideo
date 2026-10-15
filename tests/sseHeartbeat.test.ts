import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { startSseHeartbeat } from '../server/services/sseHeartbeat';
afterEach(() => vi.useRealTimers());
it.each(['close', 'finish'])('keeps an idle stream alive and stops on %s', async event => {
  vi.useFakeTimers();
  const res = Object.assign(new EventEmitter(), { write: vi.fn(), writableEnded: false, destroyed: false });
  const stop = startSseHeartbeat(res as any);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(res.write.mock.calls).toEqual([[': keep-alive\n\n'], [': keep-alive\n\n']]);
  res.emit(event); await vi.advanceTimersByTimeAsync(30_000);
  expect(res.write).toHaveBeenCalledTimes(2); expect(res.listenerCount('close')).toBe(0);
  stop();
});
