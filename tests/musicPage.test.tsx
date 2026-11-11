// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
const mock=vi.hoisted(()=>({get:vi.fn(),post:vi.fn()}));
vi.mock('../client/src/api/client',()=>({api:mock}));
vi.mock('../client/src/stores/authStore',()=>({useAuthStore:(select:any)=>select({user:{id:1}})}));
import MusicPage from '../client/src/pages/analysis/MusicPage';
beforeEach(()=>{localStorage.clear();mock.get.mockImplementation(async(url:string)=>url==='/music/models'?[{id:'my-song',name:'歌曲模型',cost:2}]:[]);mock.post.mockReset();});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('recovers a timed-out submission using exactly the original body and displays playable output',async()=>{
  mock.post.mockRejectedValueOnce(new Error('请求超时')).mockResolvedValueOnce({id:'task'});
  render(<MusicPage/>);await screen.findByText('歌曲模型 · ¥2/次');
  fireEvent.change(screen.getByLabelText(/音乐描述/),{target:{value:'温暖民谣'}});
  fireEvent.click(screen.getByText('生成音乐 · ¥2'));await screen.findByText('核实原请求');
  const original=mock.post.mock.calls[0][1];expect(JSON.parse(localStorage.getItem('music-pending-1')!)).toEqual(JSON.parse(JSON.stringify(original)));
  cleanup();
  mock.get.mockImplementation(async(url:string)=>url==='/music/models'?[{id:'my-song',name:'歌曲模型',cost:2}]:[{id:'task',model:'my-song',prompt:'温暖民谣',status:'completed',progress:100,result_url:'/uploads/music/task.mp3',cost:2,error:null}]);
  render(<MusicPage/>);fireEvent.click(screen.getByText('核实原请求'));
  await waitFor(()=>expect(mock.post).toHaveBeenCalledTimes(2));expect(mock.post.mock.calls[1][1]).toEqual(JSON.parse(JSON.stringify(original)));
  await screen.findByText('下载 MP3');expect(document.querySelector('audio')).toHaveAttribute('src','/uploads/music/task.mp3');expect(localStorage.getItem('music-pending-1')).toBeNull();
});
