import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('../server/services/channelService.js', () => ({ ChannelService: { getChannelRaw: () => ({ id: 1, type: 'huss', baseUrl: 'https://www.huss.top', apiKey: 'huss-secret' }) } }));
vi.mock('../server/services/videoCompatibilityService.js', () => ({ prepareVideoForDelivery: vi.fn(async (file: string) => file) }));
vi.mock('../server/services/mediaPreviewService.js', () => ({ createMediaPreview: async () => {} }));
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService.js';
let root: string;
const realRename = fs.renameSync.bind(fs);
const published = () => vi.mocked(fs.renameSync).mock.calls.filter(([, destination]) => String(destination).includes('uploads') && /\.(mp4|webm)$/.test(String(destination)));
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'huss-download-'));
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.spyOn(fs, 'renameSync');
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); fs.rmSync(root, { recursive: true, force: true }); });
it.each(['https://www.huss.top/files/clip.mp4?signature=keep%2Bthis&expires=99','https://cdn.example/clip.mp4?token=signed'])('refreshes the original content instead of reusing signed URL: %s', async url => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('0000ftypmp420000'), { headers: { 'Content-Type': 'video/mp4' } })));
  expect(await downloadAndLocalizeVideo(url, 'task_original', 'bb-2.5-301010', 1)).toContain('/uploads/videos/');
  expect(fetch).toHaveBeenCalledWith('https://www.huss.top/v1/videos/task_original/content', expect.objectContaining({ headers: {Authorization:'Bearer huss-secret'} }));
  expect(published()).toHaveLength(1);
});
it('preserves the upstream download reason without exposing the key', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'signature_expired', message: '签名已过期 huss-secret' } }, { status: 403 })));
  await expect(downloadAndLocalizeVideo('https://cdn.example/clip.mp4?signature=expired', 'task_original', 'bb-2.5-301010', 1))
    .rejects.toThrow('signature_expired');
  expect(published()).toHaveLength(0);
});
it('preserves the observed HUSS TOS expiry error including timing and request ID', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ Code: 'AccessDenied', Message: 'Request has expired', RequestId: 'tos-request-1', ExpiresSeconds: 60, Expires: '2026-10-25T07:03:58Z', ServerTime: '2026-10-25T07:04:03Z' }, { status: 403 })));
  const error = await downloadAndLocalizeVideo('https://www.huss.top/media/example?signature=private', 'task_original', 'bb-2.5-301010', 1).catch(error => error);
  expect(error.message).toContain('HTTP 403'); expect(error.message).toContain('AccessDenied');
  expect(error.message).toContain('Request has expired'); expect(error.message).toContain('ExpiresSeconds=60');
  expect(error.message).toContain('2026-10-25T07:04:03Z'); expect(error.message).toContain('tos-request-1');
  expect(error.message).not.toContain('signature=private'); expect(error.message).not.toContain('huss-secret');
  expect(published()).toHaveLength(0);
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
  expect(calls[2][1]?.headers).toEqual({}); expect(calls).toHaveLength(3); expect(published()).toHaveLength(1);
});
it('retains detailed failure when official fallback also fails, without unbounded retries', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ Code: 'AccessDenied', Message: 'Request has expired' }, { status: 403 })));
  await expect(downloadAndLocalizeVideo('https://www.huss.top/media/old', 'task_original', 'bb-2.5-301010', 1)).rejects.toThrow('/content');
  expect(fetch).toHaveBeenCalledTimes(1); expect(published()).toHaveLength(0);
});
it('does not treat content storage-pending as a finished video', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ status: 'storage_pending', message: 'storage pending' }, { status: 202 })));
  await expect(downloadAndLocalizeVideo('https://www.huss.top/media/old', 'task_original', 'bb-2.5-301010', 1)).rejects.toThrow('继续查询原任务');
  expect(published()).toHaveLength(0);
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
  expect(fetch).toHaveBeenCalledTimes(2); expect(published()).toHaveLength(1);
});
it('HSS content errors preserve HTTP status and Retry-After for the save worker', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'video_not_ready', message: 'still saving' } }, { status: 409, headers: { 'Retry-After': '90' } })));
  await expect(downloadAndLocalizeVideo('https://cdn.example/old', 'video_original', 'hss-2.5-301010', 1)).rejects.toMatchObject({ status: 409, retryAfterMs: 90000, message: expect.stringContaining('video_not_ready') });
  expect(fetch).toHaveBeenCalledOnce(); expect(published()).toHaveLength(0);
});


it.each(['hss-2.5-301010','bb-2.5-301010'])('downloads %s using original ID and strips credentials on redirects', async model => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(null,{status:307,headers:{location:'https://storage.example/b.mp4'}}))
    .mockResolvedValueOnce(new Response(new Uint8Array([0,0,0,24,102,116,121,112]),{headers:{'content-type':'video/mp4'}})));
  await downloadAndLocalizeVideo('https://cdn.example/expired','task_unified_b',model,1);
  expect(fetch).toHaveBeenNthCalledWith(1,'https://www.huss.top/v1/videos/task_unified_b/content',expect.objectContaining({headers:{Authorization:'Bearer huss-secret'}}));
  expect(fetch).toHaveBeenNthCalledWith(2,'https://storage.example/b.mp4',expect.objectContaining({headers:{}}));
  expect(published()).toHaveLength(1);
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
  expect(published()).toHaveLength(1);
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
  expect(published()).toHaveLength(0);
  await expect(downloadAndLocalizeVideo('https://cdn.example/old', 'task_stalled', 'bb-2.5-301010', 1)).resolves.toContain('/uploads/videos/');
  expect(vi.mocked(fetch).mock.calls.every(([url, init]) => String(url).endsWith('/task_stalled/content') && init?.method === 'GET')).toBe(true);
});

it('rejects truncated content even when HTTP status and MIME type indicate success', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('0000ftypmp420000'), { headers: { 'content-type': 'video/mp4', 'content-length': '100' } })));
  await expect(downloadAndLocalizeVideo('https://cdn.example/old', 'task_short', 'bb-2.5-301010', 1)).rejects.toThrow('下载不完整');
  expect(published()).toHaveLength(0);
});

const firstHalf = Buffer.from('0000ftypmp420000');
const secondHalf = Buffer.from('remaining-video-bytes');
const entire = Buffer.concat([firstHalf, secondHalf]);
const initialPartial = (etag = '"same-file"') => new Response(firstHalf, { headers: {
  'content-type': 'video/mp4', 'content-length': String(entire.length), etag,
} });
const remainder = (start = firstHalf.length, etag = '"same-file"') => new Response(secondHalf, { status: 206, headers: {
  'content-type': 'video/mp4', 'content-length': String(secondHalf.length), etag,
  'content-range': `bytes ${start}-${entire.length - 1}/${entire.length}`,
} });
const runOriginal = () => downloadAndLocalizeVideo('https://cdn.example/expired', 'task_resume', 'bb-2.5-301010', 1);
const partFiles = () => fs.readdirSync(path.join(root, 'data/video-downloads')).filter(n => n.endsWith('.part')).map(n => path.join(root, 'data/video-downloads', n));

it('persists bytes across module restart and resumes with verified 206 and strong ETag', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(initialPartial()).mockResolvedValueOnce(remainder()));
  await expect(runOriginal()).rejects.toThrow('下载不完整');
  expect(fs.readFileSync(partFiles()[0])).toEqual(firstHalf);
  vi.resetModules();
  const restarted = await import('../server/services/videoLocalizationService.js');
  const result = await restarted.downloadAndLocalizeVideo('https://cdn.example/expired', 'task_resume', 'bb-2.5-301010', 1);
  expect(fs.readFileSync(path.join(root, 'data', result))).toEqual(entire);
  expect(fetch).toHaveBeenNthCalledWith(2, 'https://www.huss.top/v1/videos/task_resume/content', expect.objectContaining({
    method: 'GET', headers: { Authorization: 'Bearer huss-secret', Range: `bytes=${firstHalf.length}-`, 'If-Range': '"same-file"' },
  }));
  expect(partFiles()).toHaveLength(0);
});

it('retains bytes when the remote socket closes, then completes original task', async () => {
  let sent = false;
  const broken = new ReadableStream<Uint8Array>({ async pull(c) {
    if (!sent) { sent = true; c.enqueue(firstHalf); return; }
    await new Promise(resolve => setTimeout(resolve, 20));
    c.error(new Error('UND_ERR_SOCKET: other side closed'));
  } });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(broken, { headers: {
    etag: '"same-file"', 'content-length': String(entire.length), 'content-type': 'video/mp4',
  } })).mockResolvedValueOnce(remainder()));
  await expect(runOriginal()).rejects.toThrow('other side closed');
  expect(fs.readFileSync(partFiles()[0])).toEqual(firstHalf);
  await expect(runOriginal()).resolves.toContain('/uploads/');
  expect(published()).toHaveLength(1);
});

it('replaces partial bytes instead of appending when server returns 200', async () => {
  const replacement = Buffer.from('0000ftypmp42NEWVIDEO');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(initialPartial()).mockResolvedValueOnce(new Response(replacement, { headers: {
    'content-length': String(replacement.length), etag: '"new-file"', 'content-type': 'video/mp4',
  } })));
  await expect(runOriginal()).rejects.toThrow('下载不完整');
  const result = await runOriginal();
  expect(fs.readFileSync(path.join(root, 'data', result))).toEqual(replacement);
});

it.each(['wrong-offset', 'changed-etag'])('refuses unsafe 206: %s', async mode => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(initialPartial()).mockResolvedValueOnce(
    remainder(mode === 'wrong-offset' ? 1 : firstHalf.length, mode === 'changed-etag' ? '"changed"' : '"same-file"')));
  await expect(runOriginal()).rejects.toThrow('下载不完整');
  await expect(runOriginal()).rejects.toThrow('已停止拼接');
  expect(fs.readFileSync(partFiles()[0])).toEqual(firstHalf);
  expect(published()).toHaveLength(0);
});

it('does not resume using a weak ETag', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(initialPartial('W/"weak"')).mockResolvedValueOnce(new Response(entire, { headers: { 'content-type': 'video/mp4' } })));
  await expect(runOriginal()).rejects.toThrow('下载不完整');
  await runOriginal();
  expect(vi.mocked(fetch).mock.calls[1][1]?.headers).toEqual({ Authorization: 'Bearer huss-secret' });
});

it('handles 416 with one fresh full GET rather than declaring success or failure of generation', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(initialPartial()).mockResolvedValueOnce(new Response(null, { status: 416 }))
    .mockResolvedValueOnce(new Response(entire, { headers: { 'content-type': 'video/mp4' } })));
  await expect(runOriginal()).rejects.toThrow('下载不完整');
  const result = await runOriginal();
  expect(fs.readFileSync(path.join(root, 'data', result))).toEqual(entire);
  expect(vi.mocked(fetch).mock.calls[2][1]?.headers).toEqual({ Authorization: 'Bearer huss-secret' });
});

it('allows only one writer for concurrent requests for the same original task', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(entire, { headers: { 'content-type': 'video/mp4' } })));
  const [one, two] = await Promise.all([runOriginal(), runOriginal()]);
  expect(one).toBe(two); expect(fetch).toHaveBeenCalledOnce(); expect(published()).toHaveLength(1);
});

it('preserves Range across signed redirects but never sends the API key to storage', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(initialPartial())
    .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: 'https://storage.example/renewed' } }))
    .mockResolvedValueOnce(remainder()));
  await expect(runOriginal()).rejects.toThrow('下载不完整');
  await runOriginal();
  expect(fetch).toHaveBeenNthCalledWith(3, 'https://storage.example/renewed', expect.objectContaining({ headers: {
    Range: `bytes=${firstHalf.length}-`, 'If-Range': '"same-file"',
  } }));
});

it('recovers a completely downloaded file after local publication failure without downloading again', async () => {
  let fail = true;
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    if (fail && String(to).includes('uploads')) { fail = false; throw new Error('disk temporarily unavailable'); }
    realRename(from, to);
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(entire, { headers: { 'content-type': 'video/mp4' } })));
  await expect(runOriginal()).rejects.toThrow('disk temporarily unavailable');
  expect(fs.readFileSync(partFiles()[0])).toEqual(entire);
  const result = await runOriginal();
  expect(fs.readFileSync(path.join(root, 'data', result))).toEqual(entire);
  expect(fetch).toHaveBeenCalledOnce();
});
