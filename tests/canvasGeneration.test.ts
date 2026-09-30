import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyGenerationEvent, streamGeneration } from '../client/src/canvas/generation';
import { newNode } from '../client/src/canvas/model';
afterEach(() => vi.unstubAllGlobals());
describe('canvas generation lifecycle', () => {
  it('retains all batch results, deduplicates terminal URLs and keeps previous runs', () => {
    let node = { ...newNode('image', { x: 0, y: 0 }), job: { status: 'running' as const, requestId: 'batch', expectedCount: 4, message: '' } } as import('../client/src/canvas/model').CanvasNode;
    node = applyGenerationEvent(node, { type: 'image_ready', imageUrl: '/a.png' });
    expect(node.job?.status).toBe('running');
    node = applyGenerationEvent(node, { type: 'image_ready', imageUrl: '/b.png' });
    node = applyGenerationEvent(node, { type: 'complete', imageUrls: ['/a.png', '/b.png', '/c.png', '/d.png'], contentId: 21 });
    expect(node.versions?.map(v => v.src)).toEqual(['/a.png', '/b.png', '/c.png', '/d.png']);
    expect(node.src).toBe('/a.png'); expect(node.job?.status).toBe('done');
    node = applyGenerationEvent({ ...node, src: undefined, job: { status: 'running', requestId: 'next', message: '' } }, { type: 'image_ready', imageUrl: '/next.png' });
    expect(node.versions).toHaveLength(5); expect(node.src).toBe('/next.png');
  });
  it('parses split streaming lines and the final event without a newline', async () => {
    vi.stubGlobal('localStorage', { getItem: () => 'test-token' });
    const encoder = new TextEncoder();
    const body = new ReadableStream({ start(controller) {
      for (const chunk of ['data: {"type":"status","content', 'Id":7}\n\ndata: {"type":"image_ready","imageUrl":"/uploads/a.png"}\n', 'data: {"type":"complete","contentId":7}']) controller.enqueue(encoder.encode(chunk));
      controller.close();
    } });
    const fetch = vi.fn().mockResolvedValue(new Response(body)); vi.stubGlobal('fetch', fetch);
    const events: any[] = [];
    await streamGeneration('image', { prompt: 'test' }, new AbortController().signal, e => events.push(e));
    expect(events).toHaveLength(3); expect(events[0].contentId).toBe(7); expect(events[2].type).toBe('complete');
    expect(fetch.mock.calls[0][0]).toBe('/api/image-gen/generate');
  });
  it('never discards a ready image because a later stream event has no result', () => {
    const node = { ...newNode('image', { x: 0, y: 0 }), job: { status: 'running' as const, message: '' } };
    const done = applyGenerationEvent(node, { type: 'image_ready', imageUrl: '/uploads/test.png' });
    expect(applyGenerationEvent(done, { type: 'complete' })).toBe(done);
    expect(applyGenerationEvent(done, { type: 'error', message: 'stream disconnected' })).toBe(done);
  });
  it('retains the content ID after errors for traceability', () => {
    const node = { ...newNode('video', { x: 0, y: 0 }), job: { status: 'running' as const, contentId: 12, message: '' } };
    expect(applyGenerationEvent(node, { type: 'error', message: 'failed' }).job).toMatchObject({ contentId: 12, status: 'error' });
  });
  it('surfaces authorization failures without creating a fake result', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: '请先登录' }), { status: 401 })));
    const onEvent = vi.fn();
    await expect(streamGeneration('video', {}, new AbortController().signal, onEvent)).rejects.toThrow('请先登录');
    expect(onEvent).not.toHaveBeenCalled();
  });
});
