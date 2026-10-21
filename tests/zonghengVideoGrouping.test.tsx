// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn(), generate: vi.fn(), history: vi.fn(), content: vi.fn() }));
vi.mock('../client/src/api/video', () => ({
  getCachedVideoModels: () => [],
  fetchVideoModels: mocks.list,
  generateVideo: mocks.generate,
}));
vi.mock('../client/src/api/admin', () => ({ adminApi: { getContent: mocks.detail } }));
vi.mock('../client/src/api/content', () => ({ contentApi: { getMyContents: mocks.history, getById: mocks.content } }));
vi.mock('../client/src/hooks/useAuthGuard', () => ({ useAuthGuard: () => () => true }));
vi.mock('../client/src/components/FaceProcessingModal', () => ({default:()=>null}));
vi.mock('../client/src/components/ImageSlicerModal', () => ({default:()=>null}));
vi.mock('../client/src/utils/idb', () => ({getAssets:async()=>[],saveAsset:vi.fn(),deleteAsset:vi.fn()}));
vi.mock('../client/src/hooks/useVideoQuote', () => ({ useVideoQuote: () => ({quote:{cost:1},loading:false,error:null,refresh:vi.fn()}) }));
vi.mock('../client/src/utils/imageNormalization', async importOriginal => ({
  ...await importOriginal<any>(), findUnreadableImageIndexes: async () => [],
}));
import VideoPage from '../client/src/pages/analysis/VideoPage';
import { useAuthStore } from '../client/src/stores/authStore';

const entries = [
  { id:'ZH-QQsedanco2.5/720', group:'Seedance 系列', resolution:'720p' },
  { id:'ZH-Cseadanco2.5K', group:'Seedance 系列', resolution:'720p' },
  { id:'ZH-sedanco2.0-300秒必出', group:'Seedance 系列', resolution:'720p' },
  { id:'ZH-A-SD2.0', group:'Seedance 系列', resolution:'720p' },
  { id:'ZH-kksedanco2.5', group:'Seedance 系列', resolution:'720p' },
  { id:'ZH-LLseadanco2.51', group:'Seedance 系列', resolution:'720p' },
  { id:'ZH-TTsedanco2.5-480', group:'Seedance 系列', resolution:'480p' },
  { id:'ZH-TTseadanco2.5-720', group:'Seedance 系列', resolution:'720p' },
  { id:'ZH-KKseadanco2.5X', group:'Seedance 系列', resolution:'720p' },
  { id:'ZH-MMseadanco2.5-PRO', group:'Seedance 系列', resolution:'720p' },
  { id:'ZH-Xminimex-h3', group:'MiniMax 系列', resolution:'2k' },
  { id:'ZH-wan-1080', group:'Wan 系列', resolution:'1080p' },
  { id:'seedance_v2.5', group:'HM 系列', resolution:'720p' },
  { id:'seedance-2.5-pro', group:'Seedance 系列', resolution:'720p' },
];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.history.mockResolvedValue({items:[],total:0});
  mocks.content.mockResolvedValue({status:'processing'});
  useAuthStore.setState({user:null,isAuthenticated:false});
  mocks.generate.mockReturnValue(new AbortController());
  vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){} unobserve(){}});
  mocks.list.mockResolvedValue(entries.map(({id,resolution})=>({
    id,name:id,description:'测试模型',available:true,allowedSeconds:id==='ZH-QQsedanco2.5/720'?[30]:id==='ZH-sedanco2.0-300秒必出'?[15]:[10],rates:{[resolution]:1},
  })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useAuthStore.setState({user:null,isAuthenticated:false}); });

describe('legacy video sidebar family grouping', () => {
  it.each([['query', '查询异常'], ['settlement', '结算待核实']] as const)('restores %s review with a specific label without replaying generation', async (reviewKind, label) => {
    const item = { id: 12966, status: 'review', modelId: 'ZH-kksedanco2.5', cost: 6.5, metadata: { reviewKind, requiresReview: true, prompt: 'review example' } };
    mocks.history.mockResolvedValue({ items: [item], total: 1 }); mocks.content.mockResolvedValue(item);
    useAuthStore.setState({ user: { id: 1 } as any, isAuthenticated: true });
    render(<MemoryRouter><VideoPage /></MemoryRouter>);
    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('shows a restored review task without a generating loader or a new submission', async () => {
    const item={id:12965,status:'review',modelId:'ZH-kksedanco2.5',cost:6.5,createdAt:'2026-10-16 12:27:55',metadata:{model:'ZH-kksedanco2.5',prompt:'待核实示例',seconds:30,resolution:'720p',aspect_ratio:'16:9',requiresReview:true,progressText:'纵横科技提交结果待核实'}};
    mocks.history.mockResolvedValue({items:[item],total:1});mocks.content.mockResolvedValue(item);
    useAuthStore.setState({user:{id:1} as any,isAuthenticated:true});
    render(<MemoryRouter><VideoPage/></MemoryRouter>);
    await screen.findByText('提交待核实');
    expect(screen.getByText('提交结果待核实，请在生成记录核实原任务，请勿重复提交。')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('纵横科技');expect(mocks.generate).not.toHaveBeenCalled();
    expect(document.querySelector('.animate-spin')).toBeNull();
  });

  it('shows fixed 15 seconds, 9 image slots and 3 audio slots for the new Seedance 2.0 model',async()=>{
    render(<MemoryRouter><VideoPage/></MemoryRouter>);
    const toggle=await screen.findByRole('button',{name:/Seedance 系列/});
    if(toggle.getAttribute('aria-expanded')!=='true')fireEvent.click(toggle);
    const panel=document.getElementById(toggle.getAttribute('aria-controls')!)!;
    fireEvent.click(within(panel).getByText('ZH-sedanco2.0-300秒必出'));
    expect(screen.getByRole('button',{name:'上传参考图片，最多 9 张'})).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'上传参考音频，最多 3 段'})).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:/上传参考视频/})).not.toBeInTheDocument();
    await screen.findByText('15 秒');
  });


  it('shows the confirmed reference upload limits for every ZH Seedance 2.5 entry', async () => {
    render(<MemoryRouter><VideoPage/></MemoryRouter>);
    const toggle=await screen.findByRole('button',{name:/Seedance 系列/});
    if(toggle.getAttribute('aria-expanded')!=='true') fireEvent.click(toggle);
    const panel=document.getElementById(toggle.getAttribute('aria-controls')!)!;
    for(const id of ["ZH-Cseadanco2.5K","ZH-kksedanco2.5","ZH-LLseadanco2.51","ZH-TTsedanco2.5-480","ZH-TTseadanco2.5-720","ZH-MMseadanco2.5-PRO","ZH-KKseadanco2.5X"]){
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
