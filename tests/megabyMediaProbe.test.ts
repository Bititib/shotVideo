import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { probe, lookup, open, write, close } = vi.hoisted(() => ({ probe: vi.fn(), lookup: vi.fn(), open: vi.fn(), write: vi.fn(), close: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: probe }));
vi.mock('node:dns/promises', () => ({ lookup }));
vi.mock('node:fs/promises', () => ({ default: { open, writeFile: vi.fn(async () => {}), rm: vi.fn(async () => {}) } }));
import { probeVideoDurationSeconds, probeAudioDurationSeconds } from '../server/services/videoDurationProbe.js';
beforeEach(() => {
  vi.clearAllMocks();
  probe.mockImplementation((_cmd, _args, _options, callback) => callback(null, { stdout: '{"streams":[{"duration":"5"}],"format":{"duration":"5"}}' }));
  lookup.mockResolvedValue([{ address: '93.184.216.34' }]);
  open.mockResolvedValue({ write, close });
  write.mockResolvedValue(undefined); close.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());
describe('Megaby reference probe options', () => {
  it('allows public HTTP only when explicitly requested and never reuses that cache for HTTPS-only callers', async () => {
    const upstream = vi.fn(async () => new Response('video-bytes')); vi.stubGlobal('fetch', upstream);
    const url = 'http://media.example/explicit-http.mp4';
    await expect(probeVideoDurationSeconds(url, { allowHttp: true, maxBytes: 200 * 1024 * 1024 })).resolves.toBe(5);
    expect(upstream).toHaveBeenCalledOnce(); expect(write).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    expect(probe.mock.calls[0][1]).toContain('v:0');
    await expect(probeVideoDurationSeconds(url)).rejects.toThrow('公网 HTTPS');
    expect(upstream).toHaveBeenCalledOnce();
  });
  it('enforces the selected media size rather than using the default audio limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('audio-bytes', { headers: { 'Content-Length': String(51 * 1024 * 1024) } })));
    await expect(probeAudioDurationSeconds('https://media.example/large-audio.wav', { allowHttp: true, maxBytes: 50 * 1024 * 1024 })).rejects.toThrow('50MB');
    expect(open).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  });
  it('does not share a successful cache entry across different size limits', async () => {
    const upstream = vi.fn(async () => new Response('audio-bytes', { headers: { 'Content-Length': String(20 * 1024 * 1024) } })); vi.stubGlobal('fetch', upstream);
    const url = 'https://media.example/cache-size.wav';
    await expect(probeAudioDurationSeconds(url, { allowHttp: true, maxBytes: 50 * 1024 * 1024 })).resolves.toBe(5);
    await expect(probeAudioDurationSeconds(url, { allowHttp: true, maxBytes: 15 * 1024 * 1024 })).rejects.toThrow('15MB');
    expect(upstream).toHaveBeenCalledTimes(2);
  });
  it('continues blocking private addresses even with HTTP enabled', async () => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    lookup.mockResolvedValue([{ address: '127.0.0.1' }]);
    await expect(probeVideoDurationSeconds('http://media.example/private.mp4', { allowHttp: true })).rejects.toThrow('内网');
    expect(upstream).not.toHaveBeenCalled();
  });
  it('validates a redirect target before fetching private network media', async () => {
    const upstream = vi.fn(async () => new Response('', { status: 302, headers: { Location: 'http://127.0.0.1/secret.mp4' } })); vi.stubGlobal('fetch', upstream);
    await expect(probeVideoDurationSeconds('http://media.example/redirect.mp4', { allowHttp: true })).rejects.toThrow('内网');
    expect(upstream).toHaveBeenCalledOnce(); expect(probe).not.toHaveBeenCalled();
  });
});
