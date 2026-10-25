// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import GeneratorPanel from '../client/src/canvas/GeneratorPanel';
import { useAuthStore } from '../client/src/stores/authStore';
import { fetchVideoModels } from '../client/src/api/video';
import { MODEL_LIST_TIMEOUT_MS } from '../client/src/api/modelListRequest';
vi.mock('../client/src/hooks/useVideoQuote', () => ({ useVideoQuote: () => ({ quote: null, loading: false, error: '', refresh: vi.fn() }) }));
const video = { id: 'test-video', name: '可用视频', description: '', available: true, rates: { '720p': 1 }, allowedSeconds: [5] };
const image = { id: 'test-image', name: '可用图片', description: '', available: true };
let identity = 0;
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); identity++;
  localStorage.setItem('token', `canvas-account-${identity}`);
  useAuthStore.setState({ user: { id: identity } as any, isAuthenticated: true, isLoading: false });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function mount(kind: 'image' | 'video' | 'audio' = 'video') {
  const view = render(<MemoryRouter><GeneratorPanel draft={{kind,prompt:'test',model:'',ratio:'16:9',resolution:'720p',seconds:5,count:1,videoMode:'reference'}} references={[]} busy={false} onClose={()=>{}} onGenerate={()=>{}} onConnect={()=>{}} /></MemoryRouter>);
  await act(async () => {});
  return view;
}
const trigger = () => screen.getByRole('button', { name: '生成模型' });
async function switchTo(kind: string) { await act(async () => { fireEvent.change(screen.getByLabelText('创作类型'), { target: { value: kind } }); }); }
describe('canvas catalog recovery through the real model API clients', () => {
  it('selects video while the previous image request hangs, and ignores its later failure', async () => {
    let finish!: (res: Response) => void;
    const fetcher = vi.fn((url: string) => url.includes('image-gen') ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(Response.json([video])));
    vi.stubGlobal('fetch', fetcher);
    await mount('image'); expect(trigger().textContent).toContain('加载模型');
    await switchTo('video'); expect(trigger().textContent).toContain('可用视频'); expect(trigger().hasAttribute('disabled')).toBe(false);
    await act(async () => finish(new Response('', { status: 502 })));
    expect(screen.queryByRole('alert')).toBeNull(); expect(trigger().textContent).toContain('可用视频');
  });
  it('an image failure does not prevent selecting video or audio', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('image-gen') ? new Response('', {status:503}) : Response.json(url.includes('tts-models') ? [{modelId:'tts',displayName:'可用音频',voices:['Zephyr']}] : [video])));
    await mount('image'); expect(screen.getByRole('alert').textContent).toContain('HTTP 503');
    await switchTo('video'); expect(trigger().textContent).toContain('可用视频'); expect(screen.queryByRole('alert')).toBeNull();
    await switchTo('audio'); expect(trigger().textContent).toContain('可用音频'); expect(screen.getByLabelText('音色')).toBeTruthy();
  });
  it.each(['image','video','audio'] as const)('times out %s, aborts it, and retries with a new request', async kind => {
    let signal!: AbortSignal;
    const data = kind === 'audio' ? [{modelId:'tts',displayName:'恢复音频',voices:['Zephyr']}] : kind === 'video' ? [video] : [image];
    const fetcher = vi.fn().mockImplementationOnce((_url, options) => { signal=options.signal; return new Promise(()=>{}); }).mockResolvedValue(Response.json(data));
    vi.stubGlobal('fetch', fetcher);
    await mount(kind);
    await act(async () => { await vi.advanceTimersByTimeAsync(MODEL_LIST_TIMEOUT_MS); });
    expect(signal.aborted).toBe(true); expect(screen.getByRole('alert').textContent).toContain('加载超时');
    expect(trigger().textContent).not.toContain('加载模型');
    // An image refresh timer must not immediately erase the timeout and start looping.
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', {name:'重试'})); });
    expect(fetcher).toHaveBeenCalledTimes(2); expect(trigger().hasAttribute('disabled')).toBe(false); expect(screen.queryByRole('alert')).toBeNull();
  });
  it('keeps a same-account cached list selectable during refresh and replaces it when new config arrives', async () => {
    localStorage.setItem('video-models-cache-v1', JSON.stringify({identity:localStorage.getItem('token'),savedAt:Date.now(),data:[video]}));
    let finish!: (res: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => {finish=resolve;})));
    await mount(); expect(trigger().textContent).toContain('可用视频'); expect(trigger().hasAttribute('disabled')).toBe(false);
    await act(async () => finish(Response.json([{...video,id:'new-model',name:'新视频'}])));
    expect(trigger().textContent).toContain('新视频');
  });
  it('hides cached prices on account changes and ignores the earlier account response', async () => {
    localStorage.setItem('video-models-cache-v1', JSON.stringify({identity:localStorage.getItem('token'),savedAt:Date.now(),data:[video]}));
    let oldResponse!: (res: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => {oldResponse=resolve;})).mockResolvedValue(Response.json([{...video,id:'second',name:'第二账号模型'}]));
    vi.stubGlobal('fetch', fetcher);
    await mount(); expect(trigger().textContent).toContain('可用视频');
    await act(async () => { localStorage.setItem('token','new-account'); useAuthStore.setState({user:{id:10000} as any}); });
    expect(trigger().textContent).toContain('第二账号模型');
    await act(async () => oldResponse(Response.json([video])));
    expect(trigger().textContent).toContain('第二账号模型');
    expect(JSON.parse(localStorage.getItem('video-models-cache-v1')!).identity).toBe('new-account');
  });
  it('bounds a hanging JSON body and releases the shared request for retry', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ok:true,status:200,json:()=>new Promise(()=>{})}).mockResolvedValue(Response.json([video]));
    vi.stubGlobal('fetch', fetcher);
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(MODEL_LIST_TIMEOUT_MS); });
    expect(screen.getByRole('alert').textContent).toContain('加载超时');
    await act(async () => { fireEvent.click(screen.getByRole('button', {name:'重试'})); });
    expect(trigger().textContent).toContain('可用视频'); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('reports invalid JSON and an invalid catalog without caching them', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('<html>bad gateway</html>',{status:200}))
      .mockResolvedValueOnce(Response.json({data:[video]})).mockResolvedValue(Response.json([video]));
    vi.stubGlobal('fetch', fetcher);
    await mount(); expect(screen.getByRole('alert').textContent).toContain('不是有效 JSON');
    await act(async () => { fireEvent.click(screen.getByRole('button', {name:'重试'})); });
    expect(screen.getByRole('alert').textContent).toContain('返回格式异常');
    await act(async () => { fireEvent.click(screen.getByRole('button', {name:'重试'})); });
    expect(trigger().textContent).toContain('可用视频');
  });
  it('shows a successful empty list without inventing a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
    await mount(); expect(trigger().textContent).toContain('暂无可用模型'); expect(screen.queryByRole('alert')).toBeNull();
  });
  it.each([401,403,429,502])('keeps HTTP %s visible and recovers when the network comes back', async status => {
    const fetcher=vi.fn().mockResolvedValueOnce(new Response('',{status})).mockResolvedValue(Response.json([video]));
    vi.stubGlobal('fetch',fetcher);
    await mount(); expect(screen.getByRole('alert').textContent).toContain(`HTTP ${status}`);
    await act(async()=>{ window.dispatchEvent(new Event('online')); });
    expect(trigger().textContent).toContain('可用视频'); expect(screen.queryByRole('alert')).toBeNull();
  });
  it('keeps the cached model selectable after a network error', async () => {
    localStorage.setItem('video-models-cache-v1', JSON.stringify({identity:localStorage.getItem('token'),savedAt:Date.now(),data:[video]}));
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await mount(); expect(trigger().textContent).toContain('可用视频'); expect(trigger().hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('alert').textContent).toContain('网络连接失败');
  });
  it('does not let a response arriving after timeout replace the retried catalog', async () => {
    let oldResponse!: (response: Response) => void;
    const fetcher=vi.fn().mockImplementationOnce(()=>new Promise<Response>(resolve=>{oldResponse=resolve;})).mockResolvedValue(Response.json([{...video,name:'重试结果'}]));
    vi.stubGlobal('fetch',fetcher);
    await mount(); await act(async()=>{ await vi.advanceTimersByTimeAsync(MODEL_LIST_TIMEOUT_MS); });
    await act(async()=>{ fireEvent.click(screen.getByRole('button',{name:'重试'})); });
    expect(trigger().textContent).toContain('重试结果');
    await act(async()=>oldResponse(Response.json([video])));
    expect((await fetchVideoModels())[0].name).toBe('重试结果'); expect(trigger().textContent).toContain('重试结果');
  });
  it('deduplicates simultaneous catalog reads and allows a forced refresh after success', async () => {
    let finish!: (res: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve=>{finish=resolve;})).mockResolvedValue(Response.json([video]));
    vi.stubGlobal('fetch',fetcher);
    const first=fetchVideoModels(); const second=fetchVideoModels();
    expect(fetcher).toHaveBeenCalledTimes(1); finish(Response.json([video])); await Promise.all([first,second]);
    await fetchVideoModels(); expect(fetcher).toHaveBeenCalledTimes(1);
    await fetchVideoModels(true); expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
