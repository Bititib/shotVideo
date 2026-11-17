// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';
const content=vi.hoisted(()=>({getMyApiHistory:vi.fn(),getMyApiHistoryById:vi.fn(),getOrgContents:vi.fn()}));
vi.mock('../client/src/api/content',()=>({contentApi:content}));
vi.mock('../client/src/stores/authStore',()=>({useAuthStore:(select:any)=>select({user:{id:1}})}));
import OrgContentsPage from '../client/src/pages/org/OrgContentsPage';
import HistoryPage from '../client/src/pages/analysis/HistoryPage';
const item={id:16050,type:'music',title:'我的完成歌曲',inputText:'歌词',resultUrl:'/api/music/job/results/song/file',
  resultText:null,modelId:'suno-v6',cost:3,metadata:'{}',status:'completed',createdAt:'2026-11-17T00:00:00Z'};
let fetchMock:ReturnType<typeof vi.fn>;
beforeEach(()=>{
  localStorage.clear();localStorage.setItem('token','test-session');
  content.getMyApiHistory.mockResolvedValue({items:[item],total:1});content.getMyApiHistoryById.mockResolvedValue(item);
  content.getOrgContents.mockResolvedValue({items:[item],total:1});
  fetchMock=vi.fn(async(url:string)=>url.endsWith('/results')?Response.json({results:[
    {id:'first',title:'歌曲一',status:'completed',available:true},{id:'second',title:'歌曲二',status:'completed',available:true}
  ]}):new Response('ID3 music',{headers:{'Content-Type':'audio/mpeg'}}));vi.stubGlobal('fetch',fetchMock);
  vi.stubGlobal('URL',class extends URL {static createObjectURL=vi.fn(()=> 'blob:music-download');static revokeObjectURL=vi.fn();});
  vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});vi.spyOn(window,'open').mockImplementation(()=>null);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();localStorage.clear();});
it('downloads from the actual history list with the logged-in JWT instead of opening an unauthenticated file URL',async()=>{
  render(<MemoryRouter><HistoryPage/></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button',{name:'下载',exact:true}));
  await waitFor(()=>expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce());
  expect(fetchMock).toHaveBeenCalledWith('/api/music/history/16050/file',expect.objectContaining({method:'GET',headers:expect.objectContaining({Authorization:'Bearer test-session'})}));
  const anchor=vi.mocked(HTMLAnchorElement.prototype.click).mock.instances[0] as HTMLAnchorElement;
  expect(anchor.href).toBe('blob:music-download');expect(anchor.download).toBe('generated-music-16050.mp3');
  expect(window.open).not.toHaveBeenCalled();
});
it('uses authenticated audio in the history detail and releases it when closed',async()=>{
  render(<MemoryRouter><HistoryPage/></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button',{name:'详情',exact:true}));
  await waitFor(()=>expect(document.querySelectorAll('audio')).toHaveLength(2));
  expect(await screen.findByRole('link',{name:'下载 第 2 首 · 歌曲二'})).toHaveAttribute('download','music-16050-second.mp3');
  expect(fetchMock).toHaveBeenCalledWith('/api/music/history/16050/file?result_id=second',expect.objectContaining({headers:expect.objectContaining({Authorization:'Bearer test-session'})}));
  expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-session');
  fireEvent.click(screen.getByRole('button',{name:'关闭详情'}));
  await waitFor(()=>expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:music-download'));
});
it('shows download errors without navigating to a JSON error page',async()=>{
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({error:'音乐记录不存在或无权访问'}),{status:404}));
  render(<MemoryRouter><HistoryPage/></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button',{name:'下载',exact:true}));
  expect(await screen.findByRole('alert')).toHaveTextContent('音乐记录不存在或无权访问');
  expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();expect(window.open).not.toHaveBeenCalled();
});

it('opens two authenticated team songs instead of navigating to the protected result URL',async()=>{
  render(<OrgContentsPage/>);
  fireEvent.click(await screen.findByRole('button',{name:'查看歌曲 我的完成歌曲'}));
  await waitFor(()=>expect(document.querySelectorAll('audio')).toHaveLength(2));
  expect(fetchMock).toHaveBeenCalledWith('/api/music/org/16050/results',expect.objectContaining({headers:expect.objectContaining({Authorization:'Bearer test-session'})}));
  expect(fetchMock).toHaveBeenCalledWith('/api/music/org/16050/file?result_id=second',expect.objectContaining({headers:expect.objectContaining({Authorization:'Bearer test-session'})}));
  expect(await screen.findByRole('link',{name:'下载 第 2 首 · 歌曲二'})).toHaveAttribute('href','blob:music-download');
  expect(document.querySelector('a[href="'+item.resultUrl+'"]')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'关闭歌曲'}));
  await waitFor(()=>expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2));
});
