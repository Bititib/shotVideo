// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn(), generate: vi.fn() }));
vi.mock('../client/src/api/video', () => ({
  getCachedVideoModels: () => [],
  fetchVideoModels: mocks.list,
  generateVideo: mocks.generate,
}));
vi.mock('../client/src/api/admin', () => ({ adminApi: { getContent: mocks.detail } }));
vi.mock('../client/src/api/content', () => ({ contentApi: { getMyContents: async () => ({items:[],total:0}) } }));
vi.mock('../client/src/hooks/useAuthGuard', () => ({ useAuthGuard: () => () => true }));
vi.mock('../client/src/components/FaceProcessingModal', () => ({default:()=>null}));
vi.mock('../client/src/components/ImageSlicerModal', () => ({default:()=>null}));
vi.mock('../client/src/utils/idb', () => ({getAssets:async()=>[],saveAsset:vi.fn(),deleteAsset:vi.fn()}));
vi.mock('../client/src/hooks/useVideoQuote', () => ({ useVideoQuote: () => ({quote:{cost:1},loading:false,error:null,refresh:vi.fn()}) }));
vi.mock('../client/src/utils/imageNormalization', async importOriginal => ({
  ...await importOriginal<any>(), findUnreadableImageIndexes: async () => [],
}));
import VideoPage from '../client/src/pages/analysis/VideoPage';

const entries = [
  { id:'ZH-Cseadanco2.5K', group:'Seedance 系列', resolution:'720p' },
  { id:'ZH-A-SD2.0', group:'Seedance 系列', resolution:'720p' },
  { id:'ZH-kksedanco2.5', group:'Seedance 系列', resolution:'720p' },
  { id:'ZH-LLseadanco2.51', group:'Seedance 系列', resolution:'720p' },
  { id:'ZH-TTsedanco2.5-480', group:'Seedance 系列', resolution:'480p' },
  { id:'ZH-TTseadanco2.5-720', group:'Seedance 系列', resolution:'720p' },
  { id:'ZH-MMseadanco2.5-PRO', group:'Seedance 系列', resolution:'720p' },
  { id:'ZH-Xminimex-h3', group:'MiniMax 系列', resolution:'2k' },
  { id:'ZH-wan-1080', group:'Wan 系列', resolution:'1080p' },
  { id:'seedance_v2.5', group:'HM 系列', resolution:'720p' },
  { id:'seedance-2.5-pro', group:'Seedance 系列', resolution:'720p' },
];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.generate.mockReturnValue(new AbortController());
  vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){} unobserve(){}});
  mocks.list.mockResolvedValue(entries.map(({id,resolution})=>({
    id,name:id,description:'测试模型',available:true,allowedSeconds:[10],rates:{[resolution]:1},
  })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('legacy video sidebar family grouping', () => {

  it('shows the confirmed reference upload limits for every ZH Seedance 2.5 entry', async () => {
    render(<MemoryRouter><VideoPage/></MemoryRouter>);
    const toggle=await screen.findByRole('button',{name:/Seedance 系列/});
    if(toggle.getAttribute('aria-expanded')!=='true') fireEvent.click(toggle);
    const panel=document.getElementById(toggle.getAttribute('aria-controls')!)!;
    for(const id of ["ZH-Cseadanco2.5K","ZH-kksedanco2.5","ZH-LLseadanco2.51","ZH-TTsedanco2.5-480","ZH-TTseadanco2.5-720","ZH-MMseadanco2.5-PRO"]){
      fireEvent.click(within(panel).getByText(id));
      expect(screen.getByRole('button',{name:'上传参考图片，最多 30 张'})).toBeInTheDocument();
      expect(screen.getByRole('button',{name:'上传参考视频，最多 10 个'})).toBeInTheDocument();
      expect(screen.getByRole('button',{name:'上传参考音频，最多 10 段'})).toBeInTheDocument();
    }
  });
  it.each([30,0])('keeps video/audio references after selecting another ZH model with %s images and submits every material',async imageCount=>{
    const images=Array.from({length:imageCount},(_,i)=>'https://media.invalid/i-'+i+'.jpg');
    const videos=Array.from({length:10},(_,i)=>'https://media.invalid/v-'+i+'.mp4');
    const audios=Array.from({length:10},(_,i)=>'https://media.invalid/a-'+i+'.mp3');
    mocks.detail.mockResolvedValue({id:42,metadata:{model:'ZH-MMseadanco2.5-PRO',prompt:'多素材视频测试',seconds:10,resolution:'720p',aspect_ratio:'16:9',reference_images:images,reference_videos:videos,audio_urls:audios}});
    render(<MemoryRouter initialEntries={['/app/video?replicate=42']}><VideoPage/></MemoryRouter>);
    const submit=screen.getByRole('button',{name:'开始生成视频'});
    await waitFor(()=>expect(submit).toBeEnabled());
    const toggle=screen.getByRole('button',{name:/Seedance 系列/});
    if(toggle.getAttribute('aria-expanded')!=='true') fireEvent.click(toggle);
    const panel=document.getElementById(toggle.getAttribute('aria-controls')!)!;
    fireEvent.click(within(panel).getByText('ZH-TTsedanco2.5-480'));
    expect(screen.getByRole('button',{name:'上传参考视频，最多 10 个'})).toHaveTextContent('10/10');
    expect(screen.getByRole('button',{name:'上传参考音频，最多 10 段'})).toHaveTextContent('10/10');
    fireEvent.click(submit);
    await waitFor(()=>expect(mocks.generate).toHaveBeenCalledOnce());
    expect(mocks.generate.mock.calls[0][0]).toMatchObject({model:'ZH-TTsedanco2.5-480',reference_images:imageCount ? images : undefined,reference_videos:videos,audio_urls:audios});
  });

  it('places every confirmed ZH model in its family while retaining models from other channels', async () => {
    render(<MemoryRouter><VideoPage/></MemoryRouter>);
    await screen.findByRole('button',{name:/Seedance 系列/});
    for(const {id,group} of entries){
      const toggle = screen.getByRole('button',{name:new RegExp(group)});
      if(toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
      const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
      expect(within(panel).getByText(id)).toBeInTheDocument();
    }
    expect(screen.queryByRole('button',{name:/其他模型/})).not.toBeInTheDocument();
  });
});
