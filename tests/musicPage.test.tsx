// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
const mock=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),delete:vi.fn()}));
vi.mock('../client/src/api/client',()=>({api:mock}));
vi.mock('../client/src/stores/authStore',()=>({useAuthStore:(select:any)=>select({user:{id:1}})}));
import MusicPage from '../client/src/pages/analysis/MusicPage';
const model={id:'suno-v6',name:'Suno V6',cost:2,prices:{generate:2,cover:2,voice_cover:3,upload:0}};
const legacy={id:'task',model:'old-song',status:'completed',result_url:'/uploads/music/task.mp3',cost:2,error:null,results:[]};
const readyAsset={id:'asset',asset_id:'asset',operation:'upload',title:'我的小样',status:'completed',cost:0};
const readyVoice={id:'voice',voice_id:'voice',operation:'voice',title:'本人的声音',status:'completed',cost:0};
beforeEach(()=>{localStorage.clear();mock.get.mockImplementation(async(url:string)=>{
  if(url==='/music/models')return [model];
  if(url==='/music/assets')return [readyAsset];
  if(url==='/music/voices')return [readyVoice];
  return [];
});mock.post.mockReset();});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('looks up the exact interrupted request before considering a repeat and keeps the legacy player',async()=>{
  mock.post.mockRejectedValueOnce(new Error('请求超时'));
  render(<MusicPage/>);await screen.findByText('Suno V6');
  fireEvent.change(screen.getByLabelText(/音乐描述/),{target:{value:'温暖民谣'}});
  fireEvent.click(screen.getByText('生成音乐 · ¥2'));await screen.findByText('核实原请求');
  const original=mock.post.mock.calls[0][1];
  expect(JSON.parse(localStorage.getItem('music-pending-1')!)).toMatchObject({options:original});
  cleanup();
  mock.get.mockImplementation(async(url:string)=>{
    if(url==='/music/models')return [model];
    if(url==='/music/by-request/'+original.client_request_id)return {id:'submitted'};
    return url==='/music'?[legacy]:[];
  });
  render(<MusicPage/>);fireEvent.click(screen.getByText('核实原请求'));
  await screen.findByText('下载 MP3');
  await waitFor(()=>expect(localStorage.getItem('music-pending-1')).toBeNull());
  expect(mock.post).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'试听'}));
  await waitFor(()=>expect(document.querySelector('audio')).toHaveAttribute('src','/uploads/music/task.mp3'));
});
it('submits the selected song and voice as different IDs and displays both results',async()=>{
  mock.post.mockImplementation(async(_url,body)=>{
    expect(body).toMatchObject({operation:'voice_cover',asset_id:'asset',voice_id:'voice',expected_cost:3});
    mock.get.mockImplementation(async(url:string)=>url==='/music'?[{...legacy,id:'new',result_url:null,
      operation:'voice_cover',results:[{id:'one',title:'版本一',status:'completed',result_url:'/api/music/new/results/one/file'},
        {id:'two',title:'版本二',status:'completed',result_url:'/api/music/new/results/two/file'}]}]:[]);
    return {id:'new'};
  });
  render(<MusicPage/>);await screen.findByText('Suno V6');
  fireEvent.click(screen.getByRole('button',{name:'音色翻唱',exact:true}));
  fireEvent.change(screen.getByRole('combobox',{name:'歌曲素材'}),{target:{value:'asset'}});
  fireEvent.change(screen.getByRole('combobox',{name:'我的音色'}),{target:{value:'voice'}});
  fireEvent.click(screen.getByText('用我的音色翻唱 · ¥3'));
  await screen.findByText(/版本二/);expect(screen.getAllByText('下载 MP3')).toHaveLength(2);
});

it('records a local WAV sample and forwards it only when the user creates a voice',async()=>{
  const old=Object.getOwnPropertyDescriptor(navigator,'mediaDevices');
  const stopTrack=vi.fn();
  const getUserMedia=vi.fn().mockResolvedValue({getTracks:()=>[{stop:stopTrack}]});
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia},configurable:true});
  class Recorder {
    state='inactive';
    mimeType='audio/webm';
    ondataavailable?:(event:{data:Blob})=>void;
    onstop?:()=>unknown;
    constructor(readonly stream:MediaStream){}
    start(){this.state='recording';}
    stop(){
      this.state='inactive';
      this.ondataavailable?.({data:new Blob(['recorded audio'])});
      void this.onstop?.();
    }
  }
  vi.stubGlobal('MediaRecorder',Recorder);
  vi.stubGlobal('OfflineAudioContext',class {
    async decodeAudioData(){return {duration:7,sampleRate:24000,getChannelData:()=>new Float32Array(168000)};}
  });
  Object.defineProperty(Blob.prototype,'arrayBuffer',{configurable:true,value:async()=>new ArrayBuffer(1)});
  try {
    mock.get.mockImplementation(async(url:string)=>url==='/music/models'?[{...model,prices:{voice:0}}]:[]);
    mock.post.mockResolvedValueOnce({id:'new-voice'});
    render(<MusicPage/>);await screen.findByText('Suno V6');
    fireEvent.click(screen.getByRole('button',{name:'本人音色',exact:true}));
    fireEvent.click(screen.getByText('录制本人声音'));
    const stop=await screen.findByRole('button',{name:'结束录音'});
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    await screen.findByText('已选择 本人录音.wav');
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(mock.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/这是本人的声音/));
    fireEvent.click(screen.getByText('创建本人音色 · 免费'));
    await waitFor(()=>expect(mock.post).toHaveBeenCalledTimes(1));
    const [url,form]=mock.post.mock.calls[0] as [string,FormData];
    expect(url).toBe('/music/voices');
    expect(JSON.parse(form.get('options') as string)).toMatchObject({operation:'voice',source_kind:'record',self_voice_confirmed:true,expected_cost:0});
    expect(form.get('file')).toMatchObject({type:'audio/wav',name:'本人录音.wav',size:336044});
  } finally {
    if(old)Object.defineProperty(navigator,'mediaDevices',old);else Reflect.deleteProperty(navigator,'mediaDevices');
    Reflect.deleteProperty(Blob.prototype,'arrayBuffer');
    vi.unstubAllGlobals();
  }
});

it('exposes separate upload shortcuts and carries a selected song and voice into the composer',async()=>{
  render(<MusicPage/>);
  await screen.findByText('Suno V6');
  fireEvent.click(screen.getByRole('button',{name:'普通上传'}));
  expect(screen.getByRole('heading',{name:'普通音频上传'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'强化上传',exact:true}));
  expect(screen.getByRole('heading',{name:'版权歌曲强化上传'})).toBeInTheDocument();
  const search=screen.getByRole('searchbox',{name:'搜索当前列表'});
  fireEvent.change(search,{target:{value:'查不到的素材'}});
  expect(screen.queryByRole('button',{name:'用作翻唱'})).not.toBeInTheDocument();
  fireEvent.change(search,{target:{value:'我的小样'}});
  fireEvent.click(screen.getByRole('button',{name:'用作翻唱'}));
  expect(screen.getByRole('combobox',{name:'歌曲素材'})).toHaveValue('asset');
  fireEvent.click(screen.getByRole('button',{name:'我的音色',exact:true}));
  fireEvent.click(screen.getByRole('button',{name:'使用音色'}));
  expect(screen.getByRole('combobox',{name:'歌曲素材'})).toHaveValue('asset');
  expect(screen.getByRole('combobox',{name:'我的音色'})).toHaveValue('voice');
  expect(screen.getByRole('button',{name:'用我的音色翻唱 · ¥3'})).toBeEnabled();
  expect(mock.post).not.toHaveBeenCalled();
});

it('uses one player for saved tracks, keeps it while changing panels, and releases fetched audio on close',async()=>{
  const saved={...legacy,id:'new',operation:'generate',result_url:null,
    results:[{id:'a',title:'作品 A',status:'completed',result_url:'/api/music/new/results/a/file'},
      {id:'b',title:'作品 B',status:'completed',result_url:'/api/music/new/results/b/file'}]};
  const load=vi.fn().mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second');
  const release=vi.fn();
  class TestUrl extends URL {}
  Object.assign(TestUrl,{createObjectURL:load,revokeObjectURL:release});
  vi.stubGlobal('URL',TestUrl);
  mock.get.mockImplementation(async(url:string)=>url==='/music/models'?[model]
    : url==='/music'?[saved]:url.endsWith('/file')?new Blob(['saved audio']):[]);
  try {
    render(<MusicPage/>);
    const play=await screen.findAllByRole('button',{name:'试听'});
    fireEvent.click(play[0]);
    const player=await screen.findByRole('region',{name:'音乐播放器'});
    await waitFor(()=>expect(player.querySelector('audio')).toHaveAttribute('src','blob:first'));
    fireEvent.click(play[1]);
    await waitFor(()=>expect(document.querySelector('audio')).toHaveAttribute('src','blob:second'));
    expect(document.querySelectorAll('audio')).toHaveLength(1);
    expect(release).toHaveBeenCalledWith('blob:first');
    fireEvent.click(screen.getByRole('button',{name:'作品与素材'}));
    expect(screen.getByRole('button',{name:'作品与素材'})).toHaveAttribute('aria-pressed','true');
    expect(document.querySelector('audio')).toHaveAttribute('src','blob:second');
    fireEvent.click(screen.getByRole('button',{name:'关闭播放器'}));
    expect(screen.queryByRole('region',{name:'音乐播放器'})).not.toBeInTheDocument();
    expect(release).toHaveBeenCalledWith('blob:second');
    expect(mock.get).toHaveBeenCalledWith('/music/new/results/a/file',expect.objectContaining({responseType:'blob'}));
  } finally {cleanup();vi.unstubAllGlobals();}
});
