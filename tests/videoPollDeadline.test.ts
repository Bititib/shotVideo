import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchVideoTaskResponse } from '../server/services/videoPollDeadline';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('video task query hard deadline', () => {
  it.each(['headers','body'])('bounds stalled %s even if transport ignores cancellation', async stage => {
    vi.useFakeTimers();
    let signal: AbortSignal;
    vi.stubGlobal('fetch', vi.fn((_url, init) => {
      signal = init.signal;
      return stage === 'headers' ? new Promise(() => {}) : Promise.resolve({ text: () => new Promise(() => {}) });
    }));
    const query = fetchVideoTaskResponse('https://example.invalid/task', {}, 100);
    const rejected = expect(query).rejects.toMatchObject({name:'VideoPollTimeout'});
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps status and JSON intact and clears the timer on success', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch',vi.fn(async () => Response.json({status:'succeeded',video_url:'https://example.invalid/video'}, {status:200})));
    const response = await fetchVideoTaskResponse('https://example.invalid/task',{});
    expect(await response.json()).toMatchObject({status:'succeeded'});
    expect(vi.getTimerCount()).toBe(0);
  });
});
