// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { V6K_STABLE_720_MODEL as WD, v6kStable720Limits } from '../shared/v6kStableVideo';
import { canvasVideoReferenceLimits } from '../shared/canvasVideoReferences';

const mocks=vi.hoisted(()=>({list:vi.fn(),detail:vi.fn(),generate:vi.fn(),history:vi.fn(),content:vi.fn()}));
vi.mock('../client/src/api/video',()=>({getCachedVideoModels:()=>[],fetchVideoModels:mocks.list,generateVideo:mocks.generate}));
vi.mock('../client/src/api/admin',()=>({adminApi:{getContent:mocks.detail}}));
vi.mock('../client/src/api/content',()=>({contentApi:{getMyContents:mocks.history,getById:mocks.content}}));
vi.mock('../client/src/hooks/useAuthGuard',()=>({useAuthGuard:()=>()=>true}));
vi.mock('../client/src/components/FaceProcessingModal',()=>({default:()=>null}));
vi.mock('../client/src/components/ImageSlicerModal',()=>({default:()=>null}));
vi.mock('../client/src/utils/idb',()=>({getAssets:async()=>[],saveAsset:vi.fn(),deleteAsset:vi.fn()}));
vi.mock('../client/src/hooks/useVideoQuote',()=>({useVideoQuote:()=>({quote:{cost:6.5},loading:false,error:null,refresh:vi.fn()})}));
vi.mock('../client/src/utils/imageNormalization',async original=>({...await original<any>(),findUnreadableImageIndexes:async()=>[]}));
import VideoPage from '../client/src/pages/analysis/VideoPage';
import { useAuthStore } from '../client/src/stores/authStore';

beforeEach(()=>{
  vi.clearAllMocks();sessionStorage.clear();localStorage.clear();
  mocks.history.mockResolvedValue({items:[],total:0});mocks.content.mockResolvedValue({status:'processing'});
  mocks.generate.mockReturnValue(new AbortController());useAuthStore.setState({user:null,isAuthenticated:false});
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}unobserve(){}});
  mocks.list.mockResolvedValue([WD,'kkseadanco2.5'].map(id=>({id,name:id,description:'30图10音10视/720P/5-30秒',available:true,billingType:'per_call',allowedSeconds:Array.from({length:26},(_,i)=>i+5),rates:{'720p':6.5},routingLimits:v6kStable720Limits()})));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();useAuthStore.setState({user:null,isAuthenticated:false});});
it('shows WD as its own front-end choice alongside KK with the correct material limits and price',async()=>{
  render(<MemoryRouter><VideoPage/></MemoryRouter>);
  const toggle=await screen.findByRole('button',{name:/Seedance 系列/});
  if(toggle.getAttribute('aria-expanded')!=='true')fireEvent.click(toggle);
  const panel=document.getElementById(toggle.getAttribute('aria-controls')!)!;
  const entry=within(panel).getByText(WD).closest('button')!;
  expect(within(panel).getByText('kkseadanco2.5')).toBeVisible();expect(entry).toHaveTextContent('6.50');
  fireEvent.click(entry);expect(entry).toHaveAttribute('aria-pressed','true');
  expect(screen.getByRole('button',{name:'上传参考图片，最多 30 张'})).toBeVisible();
  expect(screen.getByRole('button',{name:'上传参考视频，最多 10 个'})).toBeVisible();
  expect(screen.getByRole('button',{name:'上传参考音频，最多 10 段'})).toBeVisible();
  expect(canvasVideoReferenceLimits(WD)).toEqual({images:30,videos:10,audios:10});expect(mocks.generate).not.toHaveBeenCalled();
});
it('submits the independent public ID, selected seconds and preserved references rather than the KK entry',async()=>{
  const images=['https://media.example/image.jpg'],videos=['https://media.example/video.mp4'],audios=['https://media.example/audio.wav'];
  mocks.detail.mockResolvedValue({id:42,metadata:{model:WD,prompt:'稳定入口测试',seconds:30,resolution:'720p',aspect_ratio:'16:9',reference_images:images,reference_videos:videos,audio_urls:audios}});
  render(<MemoryRouter initialEntries={['/app/video?replicate=42']}><VideoPage/></MemoryRouter>);
  const submit=screen.getByRole('button',{name:'开始生成视频'});await waitFor(()=>expect(submit).toBeEnabled());
  fireEvent.click(submit);await waitFor(()=>expect(mocks.generate).toHaveBeenCalledTimes(1));
  expect(mocks.generate.mock.calls[0][0]).toMatchObject({model:WD,video_length:30,resolution:'720p',expectedCost:6.5,reference_images:images,reference_videos:videos,audio_urls:audios});
});
