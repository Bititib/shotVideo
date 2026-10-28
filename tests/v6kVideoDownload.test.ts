import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

vi.mock('../server/services/channelService.js', () => ({ ChannelService: {
  getChannelRaw: () => ({ type: 'zongheng-v6k', baseUrl: 'https://www.v6k.top', apiKey: 'private-key' }),
  findChannelForModel: () => null,
} }));
vi.mock('../server/services/videoCompatibilityService.js', () => ({ prepareVideoForDelivery: async (file: string) => file }));
vi.mock('../server/services/mediaPreviewService.js', () => ({ createMediaPreview: async () => {} }));
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService';
import { V6kVideoContentError } from '../server/services/v6kVideoContent';

const files: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const file of files.splice(0)) fs.rmSync(file, { force: true }); });
describe('V6K authenticated result download', () => {
  it('saves the original result from a refreshed URL after content returned 410', async () => {
    const id=randomUUID(), content='https://www.v6k.top/v1/videos/'+id+'/content';
    const fetcher=vi.fn(async (url:any,init:any)=>{
      expect(init.method).not.toBe('POST');
      if(url===content) return Response.json({error:{code:'task_not_found',message:'旧地址不可用'}},{status:410});
      if(url===content.slice(0,-8)) return Response.json({id,status:'completed',url:'https://cdn.example/original.mp4'});
      expect(init.headers).toBeUndefined(); return new Response(Buffer.from('0000ftypisom-recovered'),{headers:{'Content-Type':'video/mp4'}});
    }); vi.stubGlobal('fetch',fetcher);
    const result=await downloadAndLocalizeVideo(content,id,'V6K-test',7),file=path.resolve('data',result.slice(1));files.push(file);
    expect(fs.readFileSync(file).toString()).toBe('0000ftypisom-recovered'); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('does not apply V6K 410 semantics to an arbitrary CDN response', async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('gone',{status:410})));
    const error=await downloadAndLocalizeVideo('https://cdn.example/old.mp4',randomUUID(),'V6K-test',7).catch(e=>e);
    expect(error).not.toBeInstanceOf(V6kVideoContentError); expect(error.message).toContain('410');
  });
  it('sends the original key only to the exact content endpoint and saves durable video bytes', async () => {
    const id = randomUUID();
    const fetcher = vi.fn(async () => new Response(Buffer.from('0000ftypisom-video'), { headers: { 'Content-Type': 'video/mp4' } }));
    vi.stubGlobal('fetch', fetcher);
    const result = await downloadAndLocalizeVideo('https://www.v6k.top/v1/videos/' + id + '/content', id, 'V6K-test', 7);
    expect(result).toMatch(/^\/uploads\/videos\/video_/);
    const file = path.resolve('data', result.slice(1)); files.push(file);
    expect(fs.readFileSync(file).toString()).toBe('0000ftypisom-video');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer private-key' }, redirect: 'error' });
  });
  it('never forwards the key to a CDN or a different path on the same site', async () => {
    for (const url of ['https://cdn.example/video.mp4', 'https://www.v6k.top/not-the-content-endpoint']) {
      const fetcher = vi.fn(async () => new Response('not found', { status: 404 })); vi.stubGlobal('fetch', fetcher);
      await expect(downloadAndLocalizeVideo(url, randomUUID(), 'V6K-test', 7)).rejects.toThrow('404');
      expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
    }
  });
  it('does not accept an HTML success response as a video', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } })));
    const id = randomUUID();
    await expect(downloadAndLocalizeVideo('https://www.v6k.top/v1/videos/' + id + '/content', id, 'V6K-test', 7)).rejects.toThrow('not a video');
  });
});
