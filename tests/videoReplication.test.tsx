// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({ detail: vi.fn(), generate: vi.fn() }));
vi.mock('../client/src/api/admin', () => ({ adminApi: { getContent: mocks.detail } }));
vi.mock('../client/src/api/video', () => ({
  getCachedVideoModels: () => [{ id: 'seedance_v2.5', name: '默认模型', available: true }],
  fetchVideoModels: async () => [{ id: 'seedance_v2.5-101010', name: '多模态模型', available: true, rates: {'720p':1}, allowedSeconds:[6,10] }],
  generateVideo: mocks.generate,
}));
vi.mock('../client/src/api/content', () => ({ contentApi: { getMyContents: async () => ({items:[],total:0}) } }));
vi.mock('../client/src/hooks/useAuthGuard', () => ({ useAuthGuard: () => () => true }));
vi.mock('../client/src/components/FaceProcessingModal', () => ({default:()=>null}));
vi.mock('../client/src/components/ImageSlicerModal', () => ({default:()=>null}));
vi.mock('../client/src/utils/idb', () => ({getAssets:async()=>[],saveAsset:vi.fn(),deleteAsset:vi.fn()}));
import VideoPage from '../client/src/pages/analysis/VideoPage';

const metadata = {
  model:'seedance_v2.5-101010',prompt:'[ref_0.jpg] [ref_video_1] [ref_audio_1] 一起跳舞',
  resolution:'720p',seconds:10,aspect_ratio:'9:16',
  reference_images:['/uploads/history-assets/a.jpg','/uploads/history-assets/b.jpg'],
  reference_videos:['/uploads/history-assets/a.mp4','/uploads/history-assets/b.mp4'],
  audio_urls:['/uploads/history-assets/a.mp3','/uploads/history-assets/b.wav'],
  first_frame:'/uploads/history-assets/first.jpg',last_frame:'/uploads/history-assets/last.jpg',
};
beforeEach(()=>{vi.clearAllMocks();mocks.generate.mockReturnValue(new AbortController());sessionStorage.clear();
  vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){} unobserve(){}});
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const mount=()=>render(<MemoryRouter initialEntries={['/app/video?replicate=11983']}><VideoPage/></MemoryRouter>);
describe('complete admin video replication',()=>{
  it('fetches full detail without session storage and submits every image, video, audio and frame in order',async()=>{
    mocks.detail.mockResolvedValue({id:11983,metadata:JSON.stringify(metadata)});
    mount();
    const submit=screen.getByRole('button',{name:'开始生成视频'});
    await waitFor(()=>expect(submit).toBeEnabled());
    expect(mocks.detail).toHaveBeenCalledWith(11983);
    fireEvent.click(submit);
    await waitFor(()=>expect(mocks.generate).toHaveBeenCalledOnce());
    expect(mocks.generate.mock.calls[0][0]).toMatchObject({
      model:metadata.model,video_length:10,resolution:'720p',aspect_ratio:'9:16',
      reference_images:metadata.reference_images,reference_videos:metadata.reference_videos,
      audio_urls:metadata.audio_urls,first_frame:metadata.first_frame,last_frame:metadata.last_frame,
    });
  });
  it('does not allow a partial replication to be submitted when detail assets are missing',async()=>{
    mocks.detail.mockResolvedValue({id:11983,metadata:{...metadata,reference_videos:[],referenceAssetCounts:{videos:2}}});
    mount();
    await screen.findByText(/参考素材不完整/);
    expect(screen.getByRole('button',{name:'开始生成视频'})).toBeDisabled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
