import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));
vi.mock('node:http', () => ({ request: mocks.request }));
import { downloadPublicReferenceImage, isPublicImageAddress } from '../server/services/publicImageDownload';

function reply(status: number, body = Buffer.from('image'), headers: Record<string, string> = {}, complete = true) {
  return (_url: URL, _options: any, callback: any) => {
    const request = new EventEmitter() as any;
    request.end = () => queueMicrotask(() => {
      const response = Object.assign(new PassThrough(), { statusCode: status, headers, complete });
      callback(response); if (!response.destroyed) response.end(body);
    });
    return request;
  };
}
const read = (url = 'https://images.example/photo.png?signature=secret', max?: number) => downloadPublicReferenceImage(url, AbortSignal.timeout(1000), max);
beforeEach(() => {
  mocks.lookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  mocks.request.mockReset().mockImplementation(reply(200));
});
describe('public image transport (no real network)', () => {
  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '100.64.0.1', '198.18.0.1', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', '2001:db8::1', '2002:7f00:1::'])('blocks nonpublic address %s', address => {
    expect(isPublicImageAddress(address)).toBe(false);
  });
  it('pins checked DNS to the actual connection and sends no authentication', async () => {
    expect(await read()).toEqual(Buffer.from('image'));
    const [, options] = mocks.request.mock.calls[0];
    const done = vi.fn(); options.lookup('images.example', { all: true }, done);
    expect(done).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
    expect(mocks.lookup).toHaveBeenCalledOnce();
    expect(options.headers).not.toHaveProperty('Authorization');
    expect(options.headers).not.toHaveProperty('Cookie');
    expect(options.agent).toBe(false);
  });
  it.each([404, 403, 503, 206])('reports HTTP %s without exposing URL/query/body', async status => {
    mocks.request.mockImplementation(reply(status, Buffer.from('private upstream detail')));
    await expect(read()).rejects.toThrow(`HTTP ${status}`);
    await expect(read()).rejects.not.toThrow('secret');
  });
  it('rejects mixed public/private DNS before opening a socket', async () => {
    mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]);
    await expect(read()).rejects.toThrow('非公网'); expect(mocks.request).not.toHaveBeenCalled();
  });
  it('rejects private redirect targets', async () => {
    mocks.request.mockImplementation(reply(302, undefined, { location: 'http://169.254.169.254/latest/meta-data/' }));
    await expect(read()).rejects.toThrow('非公网'); expect(mocks.request).toHaveBeenCalledOnce();
  });
  it('follows a public redirect with a new address check', async () => {
    mocks.request.mockImplementationOnce(reply(302, undefined, { location: 'https://cdn.example/photo' })).mockImplementation(reply(200));
    await expect(read()).resolves.toEqual(Buffer.from('image')); expect(mocks.lookup).toHaveBeenCalledTimes(2);
  });
  it('bounds redirects', async () => {
    mocks.request.mockImplementation(reply(302, undefined, { location: '/again' }));
    await expect(read()).rejects.toThrow('超过 3 次'); expect(mocks.request).toHaveBeenCalledTimes(4);
  });
  it.each(['file:///etc/passwd', 'https://user:secret@images.example/file', 'http://images.example:3000/file', 'http://127.1/a', 'http://2130706433/a'])('rejects unsafe URL %s', async url => {
    await expect(read(url)).rejects.toThrow(); expect(mocks.request).not.toHaveBeenCalled();
  });
  it('caps both declared and streamed size', async () => {
    mocks.request.mockImplementation(reply(200, Buffer.from('12345')));
    await expect(read(undefined, 4)).rejects.toThrow('20 MB');
    mocks.request.mockImplementation(reply(200, Buffer.from('1'), { 'content-length': '5' }));
    await expect(read(undefined, 4)).rejects.toThrow('20 MB');
  });
  it('rejects incomplete responses', async () => {
    mocks.request.mockImplementation(reply(200, Buffer.from('partial'), {}, false));
    await expect(read()).rejects.toThrow('不完整');
  });
  it('bounds DNS time with the same abort signal', async () => {
    mocks.lookup.mockImplementation(() => new Promise(() => {}));
    await expect(downloadPublicReferenceImage('https://images.example/a', AbortSignal.timeout(20))).rejects.toThrow('超时');
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
