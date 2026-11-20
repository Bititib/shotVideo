import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('fs', () => ({ default: { existsSync: vi.fn(() => false), mkdirSync: vi.fn(), writeFileSync: vi.fn(), renameSync: vi.fn() } }));
vi.mock('../server/services/channelService.js', () => ({ ChannelService: { getChannelRaw: vi.fn(() => ({
  id: 28, type: 'apipath', baseUrl: 'https://online.apipath.top', apiKey: 'private-video-key',
})), findChannelForModel: vi.fn() } }));
vi.mock('../server/services/videoCompatibilityService.js', () => ({ prepareVideoForDelivery: vi.fn(async (p: string) => p) }));
vi.mock('../server/services/mediaPreviewService.js', () => ({ createMediaPreview: vi.fn(async () => undefined) }));
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService.js';
import { ChannelService } from '../server/services/channelService.js';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)]);
describe('Apipath actual video downloader', () => {
  it('downloads the completed media URL without sending the API key to object storage', async () => {
    const fetcher = vi.fn(async (_url: any, init: any) => {
      if (init.headers.Authorization) return new Response('unsupported authorization', { status: 403 });
      return new Response(mp4, { headers: { 'Content-Type': 'video/mp4' } });
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await downloadAndLocalizeVideo('https://cdn.example/result.mp4', 'original', 'dola2.5', 28, 11)).toContain('/uploads/videos/');
    expect(ChannelService.getChannelRaw).toHaveBeenCalledWith(28, 11);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1].headers).toEqual({});
  });
  it('retains HTTP and specific download errors without exposing the key or generating a new video', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { code: 'AccessDenied', message: 'download denied private-video-key' } }, { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    const error = await downloadAndLocalizeVideo('https://cdn.example/result.mp4', 'original', 'dola2.5', 28, 11).catch(e => e);
    expect(error.message).toContain('HTTP 403');
    expect(error.message).toContain('AccessDenied');
    expect(error.message).toContain('download denied');
    expect(error.message).not.toContain('private-video-key');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.every((call:any[])=>!call[1]?.method || call[1].method==='GET')).toBe(true);
  });
  it('refreshes an expired completed link with the original video Key and original task ID', async () => {
    const fetcher=vi.fn(async(url:any,init:any)=>{
      if(String(url).includes('/v1/video/generations/')){
        expect(init.headers.Authorization).toBe('Bearer private-video-key');
        return Response.json({task_no:'original',status:'completed',url:'https://cdn.example/fresh.mp4'});
      }
      expect(init.headers).toEqual({});
      return String(url).includes('expired')?new Response('expired',{status:400}):new Response(mp4,{headers:{'Content-Type':'video/mp4'}});
    });
    vi.stubGlobal('fetch',fetcher);
    expect(await downloadAndLocalizeVideo('https://cdn.example/expired.mp4','original','dola2.5',28,11)).toContain('/uploads/videos/');
    expect(fetcher.mock.calls.map(c=>c[0])).toEqual(['https://cdn.example/expired.mp4','https://online.apipath.top/v1/video/generations/original','https://cdn.example/fresh.mp4']);
    expect(fetcher.mock.calls.every(c=>!c[1].method||c[1].method==='GET')).toBe(true);
  });
  it('uses the content fallback and drops credentials on its storage redirect', async () => {
    const fetcher=vi.fn(async(url:any,init:any)=>{
      if(String(url).endsWith('/content')){
        expect(init.headers.Authorization).toBe('Bearer private-video-key');expect(init.redirect).toBe('manual');
        return new Response(null,{status:302,headers:{Location:'https://storage.example/file.mp4'}});
      }
      if(String(url).includes('/v1/video/generations/'))return Response.json({task_no:'original',status:'completed',url:'https://cdn.example/expired.mp4'});
      expect(init.headers).toEqual({});
      return String(url).includes('expired')?new Response('expired',{status:403}):new Response(mp4,{headers:{'Content-Type':'video/mp4'}});
    });
    vi.stubGlobal('fetch',fetcher);
    expect(await downloadAndLocalizeVideo('https://cdn.example/expired.mp4','original','dola2.5',28,11)).toContain('/uploads/videos/');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('retains storage XML Code and Message without exposing its private resource path',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('<Error><Code>InvalidArgument</Code><Message>Signature expired</Message><Resource>/works/private-user/original.mp4</Resource></Error>',{status:500})));
    const error=await downloadAndLocalizeVideo('https://cdn.example/expired.mp4','original','dola2.5',28,11).catch(e=>e);
    expect(error.message).toContain('HTTP 500');expect(error.message).toContain('InvalidArgument');expect(error.message).toContain('Signature expired');
    expect(error.message).not.toContain('private-user');expect(error.message).not.toContain('original.mp4');
  });
});
