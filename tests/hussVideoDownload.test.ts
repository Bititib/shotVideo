import { Writable } from 'node:stream';
import fs from 'node:fs';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('../server/services/channelService.js', () => ({ ChannelService: { getChannelRaw: () => ({ id: 1, type: 'huss', baseUrl: 'https://www.huss.top', apiKey: 'huss-secret' }) } }));
vi.mock('../server/services/videoCompatibilityService.js', () => ({ prepareVideoForDelivery: async (file: string) => file }));
vi.mock('../server/services/mediaPreviewService.js', () => ({ createMediaPreview: async () => {} }));
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService.js';
beforeEach(() => {
  vi.spyOn(fs, 'existsSync').mockReturnValue(false); vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'createWriteStream').mockImplementation(() => new Writable({ write(_chunk, _enc, cb) { cb(); } }) as any); vi.spyOn(fs, 'rmSync').mockReturnValue(undefined); vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined); vi.spyOn(fs, 'renameSync').mockReturnValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each(['https://www.huss.top/files/clip.mp4?signature=keep%2Bthis&expires=99','https://cdn.example/clip.mp4?token=signed'])('refreshes the original content instead of reusing signed URL: %s', async url => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('0000ftypmp420000'), { headers: { 'Content-Type': 'video/mp4' } })));
  expect(await downloadAndLocalizeVideo(url, 'task_original', 'bb-2.5-301010', 1)).toContain('/uploads/videos/');
  expect(fetch).toHaveBeenCalledWith('https://www.huss.top/v1/videos/task_original/content', expect.objectContaining({ headers: {Authorization:'Bearer huss-secret'} }));
  expect(fs.renameSync).toHaveBeenCalledOnce();
});
it('preserves the upstream download reason without exposing the key', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'signature_expired', message: '签名已过期 huss-secret' } }, { status: 403 })));
  await expect(downloadAndLocalizeVideo('https://cdn.example/clip.mp4?signature=expired', 'task_original', 'bb-2.5-301010', 1))
    .rejects.toThrow('signature_expired');
  expect(fs.renameSync).not.toHaveBeenCalled();
});
it('preserves the observed HUSS TOS expiry error including timing and request ID', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ Code: 'AccessDenied', Message: 'Request has expired', RequestId: 'tos-request-1', ExpiresSeconds: 60, Expires: '2026-10-25T07:03:58Z', ServerTime: '2026-10-25T07:04:03Z' }, { status: 403 })));
  const error = await downloadAndLocalizeVideo('https://www.huss.top/media/example?signature=private', 'task_original', 'bb-2.5-301010', 1).catch(error => error);
  expect(error.message).toContain('HTTP 403'); expect(error.message).toContain('AccessDenied');
  expect(error.message).toContain('Request has expired'); expect(error.message).toContain('ExpiresSeconds=60');
  expect(error.message).toContain('2026-10-25T07:04:03Z'); expect(error.message).toContain('tos-request-1');
  expect(error.message).not.toContain('signature=private'); expect(error.message).not.toContain('huss-secret');
  expect(fs.renameSync).not.toHaveBeenCalled();
});
it('refreshes original /content, strips credentials on every redirect, and saves once', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 307, headers: { Location: 'https://www.huss.top/media/fresh?signature=keep%2Bexact' } }))
    .mockResolvedValueOnce(new Response(null, { status: 307, headers: { Location: 'https://storage.example/final?signature=new' } }))
    .mockResolvedValueOnce(new Response(Buffer.from('0000ftypmp420000'), { headers: { 'Content-Type': 'video/mp4' } })));
  expect(await downloadAndLocalizeVideo('https://www.huss.top/media/old?signature=old', 'task_original', 'bb-2.5-301010', 1)).toContain('/uploads/videos/');
  const calls = vi.mocked(fetch).mock.calls;
  expect(calls[0]).toEqual(['https://www.huss.top/v1/videos/task_original/content', expect.objectContaining({ method: 'GET', redirect: 'manual', headers: { Authorization: 'Bearer huss-secret' } })]);
  expect(calls[1]).toEqual(['https://www.huss.top/media/fresh?signature=keep%2Bexact', expect.objectContaining({ headers: {} })]);
  expect(calls[2][1]?.headers).toEqual({}); expect(calls).toHaveLength(3); expect(fs.renameSync).toHaveBeenCalledOnce();
});
it('retains detailed failure when official fallback also fails, without unbounded retries', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ Code: 'AccessDenied', Message: 'Request has expired' }, { status: 403 })));
  await expect(downloadAndLocalizeVideo('https://www.huss.top/media/old', 'task_original', 'bb-2.5-301010', 1)).rejects.toThrow('/content');
  expect(fetch).toHaveBeenCalledTimes(1); expect(fs.renameSync).not.toHaveBeenCalled();
});
it('does not treat content storage-pending as a finished video', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ status: 'storage_pending', message: 'storage pending' }, { status: 202 })));
  await expect(downloadAndLocalizeVideo('https://www.huss.top/media/old', 'task_original', 'bb-2.5-301010', 1)).rejects.toThrow('继续查询原任务');
  expect(fs.renameSync).not.toHaveBeenCalled();
});
it('does not use fallback to extend an expired file retention period', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'file expired' }, { status: 410 })));
  await expect(downloadAndLocalizeVideo('https://www.huss.top/media/old', 'task_original', 'bb-2.5-301010', 1)).rejects.toThrow('410');
  expect(fetch).toHaveBeenCalledOnce();
});

it('HSS prefers fresh original content delivery, bypassing stale signed URLs and never forwarding credentials', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 307, headers: { Location: 'https://storage.example/fresh?signature=exact' } }))
    .mockResolvedValueOnce(new Response(Buffer.from('0000ftypmp420000'), { headers: { 'Content-Type': 'video/mp4' } })));
  await downloadAndLocalizeVideo('https://cdn.example/expired', 'video_original', 'hss-2.5-301010', 1);
  expect(fetch).toHaveBeenNthCalledWith(1, 'https://www.huss.top/v1/videos/video_original/content', expect.objectContaining({ cache: 'no-store', headers: { Authorization: 'Bearer huss-secret' } }));
  expect(fetch).toHaveBeenNthCalledWith(2, 'https://storage.example/fresh?signature=exact', expect.objectContaining({ headers: {} }));
  expect(fetch).toHaveBeenCalledTimes(2); expect(fs.renameSync).toHaveBeenCalledOnce();
});
it('HSS content errors preserve HTTP status and Retry-After for the save worker', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'video_not_ready', message: 'still saving' } }, { status: 409, headers: { 'Retry-After': '90' } })));
  await expect(downloadAndLocalizeVideo('https://cdn.example/old', 'video_original', 'hss-2.5-301010', 1)).rejects.toMatchObject({ status: 409, retryAfterMs: 90000, message: expect.stringContaining('video_not_ready') });
  expect(fetch).toHaveBeenCalledOnce(); expect(fs.renameSync).not.toHaveBeenCalled();
});


it.each(['hss-2.5-301010','bb-2.5-301010'])('downloads %s using original ID and strips credentials on redirects', async model => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(null,{status:307,headers:{location:'https://storage.example/b.mp4'}}))
    .mockResolvedValueOnce(new Response(new Uint8Array([0,0,0,24,102,116,121,112]),{headers:{'content-type':'video/mp4'}})));
  await downloadAndLocalizeVideo('https://cdn.example/expired','task_unified_b',model,1);
  expect(fetch).toHaveBeenNthCalledWith(1,'https://www.huss.top/v1/videos/task_unified_b/content',expect.objectContaining({headers:{Authorization:'Bearer huss-secret'}}));
  expect(fetch).toHaveBeenNthCalledWith(2,'https://storage.example/b.mp4',expect.objectContaining({headers:{}}));
  expect(fs.renameSync).toHaveBeenCalledOnce();
});

it('saves a continuously flowing HUSS video after the old five minute cutoff', async () => {
  vi.useFakeTimers();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let signal: AbortSignal;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    signal = init.signal;
    return new Response(stream, { headers: { 'content-type': 'video/mp4' } });
  }));
  const result = downloadAndLocalizeVideo('https://cdn.example/old', 'task_slow', 'bb-2.5-301010', 1);
  const assertion = expect(result).resolves.toContain('/uploads/videos/');
  for (let i = 0; i < 7; i++) {
    await vi.advanceTimersByTimeAsync(60_000);
    controller!.enqueue(Buffer.from('0000ftypmp420000'));
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(signal!.aborted).toBe(false);
  controller!.close();
  await assertion;
  expect(fetch).toHaveBeenCalledOnce();
  expect(fs.renameSync).toHaveBeenCalledOnce();
});

it('stops a stalled transfer without publishing a partial result and retries only original GET', async () => {
  vi.useFakeTimers();
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from('0000ftypmp420000')); } });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'video/mp4' } }))
    .mockResolvedValueOnce(new Response(Buffer.from('0000ftypmp420000'), { headers: { 'content-type': 'video/mp4' } })));
  const result = downloadAndLocalizeVideo('https://cdn.example/old', 'task_stalled', 'bb-2.5-301010', 1);
  const assertion = expect(result).rejects.toThrow('连续 90 秒无数据');
  await vi.advanceTimersByTimeAsync(91_000);
  await assertion;
  expect(fs.renameSync).not.toHaveBeenCalled();
  await expect(downloadAndLocalizeVideo('https://cdn.example/old', 'task_stalled', 'bb-2.5-301010', 1)).resolves.toContain('/uploads/videos/');
  expect(vi.mocked(fetch).mock.calls.every(([url, init]) => String(url).endsWith('/task_stalled/content') && init?.method === 'GET')).toBe(true);
});

it('rejects truncated content even when HTTP status and MIME type indicate success', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('0000ftypmp420000'), { headers: { 'content-type': 'video/mp4', 'content-length': '100' } })));
  await expect(downloadAndLocalizeVideo('https://cdn.example/old', 'task_short', 'bb-2.5-301010', 1)).rejects.toThrow('下载不完整');
  expect(fs.renameSync).not.toHaveBeenCalled();
});
