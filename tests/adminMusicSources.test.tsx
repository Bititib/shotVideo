// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';
const mock=vi.hoisted(()=>({get:vi.fn(),getContents:vi.fn()}));
vi.mock('../client/src/api/client',()=>({api:mock}));
vi.mock('../client/src/api/admin',()=>({adminApi:mock}));
import AdminMusicSources, { useAdminMusicSources } from '../client/src/components/AdminMusicSources';
import ContentsPage from '../client/src/pages/admin/ContentsPage';
const source={id:'source',label:'原始上传音频',name:'original.wav',mime:'audio/wav',bytes:256,available:true,url:'/admin/music/job/sources/source/file'};
function Preview({id}:{id:string}) {const state=useAdminMusicSources(id);return <><span>{state.loading?'加载中':state.error?'读取失败':`参考素材 ${state.items.length}`}</span><AdminMusicSources {...state}/></>;}
beforeEach(()=>{
  mock.get.mockReset();
  vi.stubGlobal('URL',class extends URL {
    static createObjectURL=vi.fn(()=> 'blob:private-audio');
    static revokeObjectURL=vi.fn();
  });
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('shows a private original input with authenticated playback and download, and releases its blob',async()=>{
  mock.get.mockImplementation(async(url:string)=>url.endsWith('/file')?new Blob(['audio']):[source]);
  const rendered=render(<Preview id="job"/>);
  await screen.findByText('参考素材 1');await screen.findByText('下载原音频');
  expect(screen.getByLabelText('original.wav')).toHaveAttribute('src','blob:private-audio');
  expect(screen.getByText('下载原音频')).toHaveAttribute('download','original.wav');
  expect(mock.get).toHaveBeenCalledWith(source.url,expect.objectContaining({responseType:'blob',signal:expect.any(AbortSignal)}));
  rendered.unmount();expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:private-audio');
});
it('reports missing files and list errors instead of showing no references or an empty player',async()=>{
  mock.get.mockResolvedValueOnce([{...source,available:false,url:null,issue:'原音频文件不存在或无法读取'}]);
  const rendered=render(<Preview id="missing"/>);
  await screen.findByText('参考素材 1');await screen.findByText('原音频文件不存在或无法读取');
  expect(document.querySelector('audio')).toBeNull();expect(mock.get).toHaveBeenCalledTimes(1);
  mock.get.mockRejectedValueOnce(new Error('无权限读取素材'));
  rendered.rerender(<Preview id="forbidden"/>);
  await screen.findByText('读取失败');await screen.findByRole('alert');
  expect(screen.queryByText('参考素材 0')).toBeNull();
});
it('discards a previous order response after switching orders',async()=>{
  let complete!:(data:unknown)=>void;
  mock.get.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;})).mockResolvedValueOnce([]);
  const rendered=render(<Preview id="first"/>);
  rendered.rerender(<Preview id="second"/>);
  await screen.findByText('参考素材 0');complete([source]);
  await waitFor(()=>expect(mock.get).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('参考素材 1')).toBeNull();
  expect(document.querySelector('audio')).toBeNull();
});
it('shows uploaded input in the actual admin reference tab for a review order with no result URL',async()=>{
  const item={id:16028,userId:1,type:'music',title:'待核实的上传',inputText:'',resultUrl:null,resultText:null,
    modelId:'suno-v6',cost:0,status:'review',createdAt:'2026-11-17T00:00:00Z',userName:'API 用户',userEmail:'api@test.invalid',
    metadata:JSON.stringify({musicTaskId:'job',musicOperation:'upload',billingStatus:'free'})};
  mock.getContents.mockResolvedValue({items:[item],total:1});
  mock.get.mockImplementation(async(url:string)=>url.endsWith('/file')?new Blob(['audio']):url.endsWith('/sources')?[source]:
    {id:'job',operation:'upload',state:'review',submissionId:'job',results:[]});
  render(<MemoryRouter><ContentsPage/></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button',{name:'查看本地记录 16028 详情'}));
  const tab=await screen.findByRole('button',{name:'参考素材 (1)'});fireEvent.click(tab);
  await screen.findByText('下载原音频');
  expect(screen.getByLabelText('original.wav')).toHaveAttribute('src','blob:private-audio');
  expect(screen.queryByText('该任务没有参考素材')).toBeNull();
});
it('loads both saved songs through admin authentication in the actual detail page instead of a raw user file URL',async()=>{
  const item={id:16045,userId:1,type:'music',title:'已完成的音乐',inputText:'',resultUrl:'/api/music/job/results/first/file',resultText:null,
    modelId:'suno-v6',cost:3,status:'completed',createdAt:'2026-11-17T00:00:00Z',userName:'API 用户',userEmail:'api@test.invalid',
    metadata:JSON.stringify({musicTaskId:'job',musicOperation:'sing',billingStatus:'settled'})};
  mock.getContents.mockResolvedValue({items:[item],total:1});
  mock.get.mockImplementation(async(url:string)=>url.endsWith('/file')?new Blob(['audio']):url.endsWith('/sources')?[]:
    {id:'job',operation:'sing',state:'completed',submissionId:'job',results:[
      {id:'first',upstreamId:'up-first',status:'completed',saved:true},
      {id:'second',upstreamId:'up-second',status:'completed',saved:true},
    ]});
  render(<MemoryRouter><ContentsPage/></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button',{name:'查看本地记录 16045 详情'}));
  await screen.findByText('下载歌曲 2');
  expect(document.querySelectorAll('audio')).toHaveLength(2);
  for(const audio of document.querySelectorAll('audio')) {
    expect(audio).toHaveAttribute('src','blob:private-audio');expect(audio).toHaveAttribute('preload','metadata');
  }
  expect(mock.get).toHaveBeenCalledWith('/admin/music/job/results/first/file',expect.objectContaining({responseType:'blob'}));
  expect(mock.get).toHaveBeenCalledWith('/admin/music/job/results/second/file',expect.objectContaining({responseType:'blob'}));
  fireEvent.click(screen.getByRole('button',{name:'关闭详情'}));
  await waitFor(()=>expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2));
});
