// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { generateImage } from '../client/src/api/imageGen';
afterEach(() => vi.unstubAllGlobals());
function response(parts: string[], failure = false) {
  let index = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (index < parts.length) controller.enqueue(new TextEncoder().encode(parts[index++]));
    else if (failure) controller.error(new Error('connection reset'));
    else controller.close();
  } }));
}
it('drains an unterminated final frame across split network chunks', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(['data: {"type":"content_id","contentId":12}\n\n', 'data: {"type":"com', 'plete","imageUrls":["/image.png"]}'])));
  const event = vi.fn(); generateImage({ prompt: 'test' }, event);
  await vi.waitFor(() => expect(event).toHaveBeenCalledTimes(2));
  expect(event.mock.calls[1][0]).toMatchObject({ type: 'complete', contentId: 12, imageUrls: ['/image.png'] });
});
it.each([false, true])('signals lost completion without claiming failure (network error=%s)', async failure => {
  vi.stubGlobal('fetch', vi.fn(async () => response(['data:{"type":"status","contentId":12}\n\n'], failure)));
  const event = vi.fn(); generateImage({ prompt: 'test' }, event);
  await vi.waitFor(() => expect(event).toHaveBeenCalledTimes(2));
  expect(event.mock.calls[1][0]).toMatchObject({ type: 'disconnected', contentId: 12 });
  expect(event.mock.calls.some(([value]) => value.type === 'error')).toBe(false);
});
it('keeps explicit backend failure final', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(['data: {"type":"error","message":"失败"}\n\n'])));
  const event = vi.fn(); generateImage({ prompt: 'test' }, event);
  await vi.waitFor(() => expect(event).toHaveBeenCalledTimes(1));
  expect(event.mock.calls[0][0]).toMatchObject({
    type: 'error',
    message: '生成未完成，请在生成记录查看任务状态，或联系管理员处理。',
  });
});
it('silences stream events after intentional cancellation', async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  const event = vi.fn(); const controller = generateImage({ prompt: 'test' }, event);
  controller.abort(); resolve(response(['data: {"type":"complete"}\n\n']));
  await new Promise(done => setTimeout(done, 10));
  expect(event).not.toHaveBeenCalled();
});
