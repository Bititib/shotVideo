// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { V6K_FULL_720_MODEL as FULL, v6kFull720Limits } from '../shared/v6kFullReferenceVideo';
import { V6K_STABLE_720_MODEL as WD, v6kStable720Limits } from '../shared/v6kStableVideo';
import { canvasVideoReferenceLimits } from '../shared/canvasVideoReferences';
import { videoInputError } from '../client/src/canvas/videoInputs';
import { newNode } from '../shared/canvasModel';

const mocks=vi.hoisted(()=>({list:vi.fn(),detail:vi.fn(),generate:vi.fn(),history:vi.fn(),content:vi.fn()}));
vi.mock('../client/src/api/video',()=>({getCachedVideoModels:()=>[],fetchVideoModels:mocks.list,generateVideo:mocks.generate}));
vi.mock('../client/src/api/admin',()=>({adminApi:{getContent:mocks.detail}}));
vi.mock('../client/src/api/content',()=>({contentApi:{getMyContents:mocks.history,getById:mocks.content}}));
vi.mock('../client/src/hooks/useAuthGuard',()=>({useAuthGuard:()=>()=>true}));
vi.mock('../client/src/components/FaceProcessingModal',()=>({default:()=>null}));
vi.mock('../client/src/components/ImageSlicerModal',()=>({default:()=>null}));
vi.mock('../client/src/utils/idb',()=>({getAssets:async()=>[],saveAsset:vi.fn(),deleteAsset:vi.fn()}));
vi.mock('../client/src/hooks/useVideoQuote',()=>({useVideoQuote:()=>({quote:{cost:5.8},loading:false,error:null,refresh:vi.fn()})}));
vi.mock('../client/src/utils/imageNormalization',async original=>({...await original<any>(),findUnreadableImageIndexes:async()=>[]}));
import VideoPage from '../client/src/pages/analysis/VideoPage';
import { useAuthStore } from '../client/src/stores/authStore';

beforeEach(()=>{
  vi.clearAllMocks();sessionStorage.clear();localStorage.clear();mocks.history.mockResolvedValue({items:[],total:0});mocks.content.mockResolvedValue({status:'processing'});
  mocks.generate.mockReturnValue(new AbortController());useAuthStore.setState({user:null,isAuthenticated:false});
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}unobserve(){}});
  mocks.list.mockResolvedValue([FULL,WD].map(id=>({id,name:id,description:'720P/5-30秒/按条计费',available:true,billingType:'per_call',allowedSeconds:Array.from({length:26},(_,i)=>i+5),rates:{'720p':id===FULL?5.8:6.5},routingLimits:id===FULL?v6kFull720Limits():v6kStable720Limits()})));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();useAuthStore.setState({user:null,isAuthenticated:false});});
it('shows the requested full-model name and price separately from WD and hides unsupported video/audio references',async()=>{
  render(<MemoryRouter><VideoPage/></MemoryRouter>);
  const toggle=await screen.findByRole('button',{name:/Seedance 系列/});if(toggle.getAttribute('aria-expanded')!=='true')fireEvent.click(toggle);
  const panel=document.getElementById(toggle.getAttribute('aria-controls')!)!,entry=within(panel).getByText(FULL).closest('button')!;
  expect(within(panel).getByText(WD)).toBeVisible();expect(entry).toHaveTextContent('5.80');fireEvent.click(entry);
  expect(screen.getByRole('button',{name:'上传参考图片，最多 30 张'})).toBeVisible();expect(screen.queryByRole('button',{name:/上传参考视频/})).toBeNull();expect(screen.queryByRole('button',{name:/上传参考音频/})).toBeNull();
  expect(canvasVideoReferenceLimits(FULL)).toEqual({images:30,videos:0,audios:0});
  const images=Array.from({length:30},()=>({...newNode('image',{x:0,y:0}),src:'https://media.example/ref.jpg'}));
  expect(videoInputError({kind:'video',videoMode:'reference',model:FULL,ratio:'16:9',seconds:30,resolution:'720p'},images,v6kFull720Limits())).toBe('');
  expect(mocks.generate).not.toHaveBeenCalled();
});
it('restores and sends all 30 reference images with the independent public ID and flat 5.8 quote',async()=>{
  const images=Array.from({length:30},(_,i)=>'https://media.example/image'+i+'.jpg');
  mocks.detail.mockResolvedValue({id:42,metadata:{model:FULL,prompt:'满血图片参考',seconds:30,resolution:'720p',aspect_ratio:'16:9',reference_images:images}});
  render(<MemoryRouter initialEntries={['/app/video?replicate=42']}><VideoPage/></MemoryRouter>);
  const submit=screen.getByRole('button',{name:'开始生成视频'});await waitFor(()=>expect(submit).toBeEnabled());fireEvent.click(submit);
  await waitFor(()=>expect(mocks.generate).toHaveBeenCalledTimes(1));expect(mocks.generate.mock.calls[0][0]).toMatchObject({model:FULL,video_length:30,resolution:'720p',expectedCost:5.8,reference_images:images});
  expect(mocks.generate.mock.calls[0][0].reference_videos).toBeUndefined();expect(mocks.generate.mock.calls[0][0].audio_urls).toBeUndefined();
});
