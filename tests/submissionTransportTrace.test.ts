import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { submitZonghengVideo, ZonghengSubmissionError } from '../server/services/zonghengAdapter';

const servers: Server[] = [];
async function serve(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  vi.restoreAllMocks();
});
const input = { model: '公开模型', prompt: 'private-prompt-never-log', seconds: 5, ratio: '16:9', resolution: '720p', images: ['https://private.invalid/file?signature=secret'], videos: [], audios: [] };
const order = '0c006576-1234-4321-8765-123456789abc';

describe('actual HTTP submission observations (loopback only)', () => {
  it('records socket/body/response events, saves once, and never logs credentials or media', async () => {
    let posts = 0;
    const base = await serve((req, res) => {
      posts++; req.resume(); req.on('end', () => {
        res.setHeader('x-request-id', 'private-api-key');
        res.end(JSON.stringify({ id: 'task_original', status: 'queued' }));
      });
    });
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const accepted = vi.fn();
    await submitZonghengVideo(base, 'private-api-key', input, order, () => {}, 2000, 'v6k', accepted);
    expect(posts).toBe(1); expect(accepted).toHaveBeenCalledExactlyOnceWith('task_original');
    const evidence = JSON.parse(log.mock.calls[0][1]);
    expect(evidence).toMatchObject({ requestObserved: true, peerIp: '127.0.0.1', httpStatus: 200,
      socketWriteStartedMs: expect.any(Number), requestBodySentMs: expect.any(Number), responseHeadersMs: expect.any(Number), responseBodyCompleteMs: expect.any(Number) });
    const printed = JSON.stringify(log.mock.calls);
    for (const value of ['private-api-key', input.prompt, 'signature=secret', 'Authorization']) expect(printed).not.toContain(value);
  });
  it('distinguishes a sent body with no response from a partial response, without retrying', async () => {
    let posts = 0;
    const base = await serve((req, res) => {
      posts++; req.resume(); req.on('end', () => {
        if (posts === 2) { res.writeHead(200, { 'x-request-id': 'trace_partial' }); res.write('{'); }
      });
    });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const accepted = vi.fn();
    for (let i = 0; i < 2; i++) {
      const error = await submitZonghengVideo(base, 'key', input, order, () => {}, 400, 'v6k', accepted).catch(e => e);
      expect(error).toBeInstanceOf(ZonghengSubmissionError); expect(error.uncertain).toBe(true);
      const t = error.diagnostics.transport;
      expect(t).toMatchObject({ requestObserved: true, requestBodySentMs: expect.any(Number) });
      expect(t.responseBodyCompleteMs).toBeUndefined();
      if (i === 0) expect(t.responseHeadersMs).toBeUndefined();
      else expect(t).toMatchObject({ httpStatus: 200, requestId: 'trace_partial', responseHeadersMs: expect.any(Number) });
    }
    expect(posts).toBe(2); expect(accepted).not.toHaveBeenCalled();
  });
  it('does not mix a concurrent successful request into a stalled request', async () => {
    let posts = 0;
    const base = await serve((req, res) => {
      posts++; const n = posts; req.resume(); req.on('end', () => { if (n === 2) res.end(JSON.stringify({ id: 'task_second', status: 'queued' })); });
    });
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const stalled = submitZonghengVideo(base, 'key', input, order, () => {}, 600).catch(e => e);
    await vi.waitFor(() => expect(posts).toBe(1));
    await submitZonghengVideo(base, 'key', input, '1c006576-1234-4321-8765-123456789abc', () => {}, 2000);
    const error = await stalled;
    expect(error.diagnostics.transport.responseHeadersMs).toBeUndefined();
    expect(error.diagnostics.transport.requestBodySentMs).toEqual(expect.any(Number));
    expect(log.mock.calls).toHaveLength(2); expect(posts).toBe(2);
  });
  it('retains a connection-refused code without claiming a body was sent', async () => {
    const base = await serve((_req, res) => res.end());
    const server = servers.pop()!; await new Promise<void>(resolve => server.close(() => resolve()));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = await submitZonghengVideo(base, 'key', input, order, () => {}, 1000).catch(e => e);
    expect(error.uncertain).toBe(false);
    expect(error.diagnostics.transport).toMatchObject({ requestObserved: true, transportCode: 'ECONNREFUSED' });
    expect(error.diagnostics.transport.requestBodySentMs).toBeUndefined();
  });
});
