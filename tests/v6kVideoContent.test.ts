import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchV6kVideoContent, V6kVideoContentError } from '../server/services/v6kVideoContent';
const channel = { baseUrl: 'https://www.v6k.top', apiKey: 'private-key' };
const task = 'task_original', endpoint = channel.baseUrl + '/v1/videos/' + task;
const gone = () => Response.json({ error: { code: 'task_not_found', message: '任务或文件不存在或已失效 private-key https://secret.example/file?signature=secret' } }, { status: 410 });
afterEach(() => vi.unstubAllGlobals());
describe('V6K original result retrieval', () => {
  it('retains the concrete 410 cause after ONE original receipt check and never generates again', async () => {
    const fetcher = vi.fn(async (url: any, init: any) => {
      expect(init.method).not.toBe('POST'); expect(init.headers.Authorization).toBe('Bearer private-key');
      return url === endpoint + '/content' ? gone() : Response.json({ id: task, status: 'completed', url: endpoint + '/content' });
    }); vi.stubGlobal('fetch', fetcher);
    await expect(fetchV6kVideoContent(channel,task)).rejects.toMatchObject({ status: 410, taskId: task, upstreamCode: 'task_not_found', message: expect.stringContaining('任务或文件不存在或已失效') });
    expect(fetcher).toHaveBeenCalledTimes(2);
    try { await fetchV6kVideoContent(channel,task); } catch (e: any) { expect(e.message).not.toContain('private-key'); expect(e.message).not.toContain('signature=secret'); }
  });
  it('retrieves a freshly returned public URL and strips authorization across all redirects', async () => {
    const fetcher = vi.fn(async (url: any, init: any) => {
      expect(init.method).not.toBe('POST');
      if (url === endpoint + '/content') return gone();
      if (url === endpoint) return Response.json({ id: task, status: 'completed', url: 'https://cdn.example/fresh' });
      expect(init.headers).toBeUndefined(); expect(init.redirect).toBe('manual');
      return url === 'https://cdn.example/fresh' ? new Response(null,{status:302,headers:{Location:'https://media.example/video.mp4'}})
        : new Response('video-bytes',{headers:{'content-type':'video/mp4'}});
    }); vi.stubGlobal('fetch', fetcher);
    const response = await fetchV6kVideoContent(channel,task);
    expect(await response.text()).toBe('video-bytes'); expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it.each(['http://cdn.example/file','https://127.0.0.1/file','https://localhost/file','https://name:password@cdn.example/file'])('refuses an unsafe alternate %s while retaining the original 410', async url => {
    const fetcher = vi.fn().mockResolvedValueOnce(gone()).mockResolvedValueOnce(Response.json({ id: task, status:'completed',url }));
    vi.stubGlobal('fetch', fetcher);
    await expect(fetchV6kVideoContent(channel,task)).rejects.toBeInstanceOf(V6kVideoContentError); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not retrieve an alternate belonging to a different task', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(gone()).mockResolvedValueOnce(Response.json({ id: 'other',status:'completed',url:'https://cdn.example/file' }));
    vi.stubGlobal('fetch', fetcher);
    await expect(fetchV6kVideoContent(channel,task)).rejects.toMatchObject({ status:410,taskId:task }); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps 410 when the alternate is also unavailable, without retrying either download', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(gone()).mockResolvedValueOnce(Response.json({ id: task,status:'completed',url:'https://cdn.example/file' })).mockResolvedValueOnce(gone());
    vi.stubGlobal('fetch', fetcher);
    await expect(fetchV6kVideoContent(channel,task)).rejects.toMatchObject({ status:410,taskId:task }); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('preserves a non-410 error without treating it as an unavailable result or refreshing a task', async () => {
    const fetcher=vi.fn(async()=>Response.json({error:{code:'busy',message:'稍后查询'}},{status:503})); vi.stubGlobal('fetch',fetcher);
    await expect(fetchV6kVideoContent(channel,task)).rejects.toMatchObject({status:503,upstreamCode:'busy'}); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
