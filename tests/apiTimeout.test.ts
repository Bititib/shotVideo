// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../client/src/api/client';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function stalledFetch() {
  vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  })));
}
describe('request cancellation and timeout feedback', () => {
  it('times out reads without leaving a pending request', async () => {
    vi.useFakeTimers(); stalledFetch();
    const result = expect(api.get('/test', { timeoutMs: 50 })).rejects.toThrow('加载超时');
    await vi.advanceTimersByTimeAsync(50); await result;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('warns against blindly repeating a write after timeout', async () => {
    vi.useFakeTimers(); stalledFetch();
    const result = expect(api.put('/test', {}, { timeoutMs: 50 })).rejects.toThrow('核实操作结果');
    await vi.advanceTimersByTimeAsync(50); await result;
  });
  it('preserves explicit cancellation instead of calling it a timeout', async () => {
    stalledFetch(); const controller = new AbortController();
    const result = expect(api.get('/test', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await result;
  });
});
