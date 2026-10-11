// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../client/src/api/video', () => ({
  getCachedVideoModels: () => [],
  fetchVideoModels: mocks.list,
  generateVideo: vi.fn(),
}));
vi.mock('../client/src/api/admin', () => ({ adminApi: { getContent: vi.fn() } }));
vi.mock('../client/src/api/content', () => ({ contentApi: { getMyContents: async () => ({items:[],total:0}) } }));
vi.mock('../client/src/hooks/useAuthGuard', () => ({ useAuthGuard: () => () => true }));
vi.mock('../client/src/components/FaceProcessingModal', () => ({default:()=>null}));
vi.mock('../client/src/components/ImageSlicerModal', () => ({default:()=>null}));
vi.mock('../client/src/utils/idb', () => ({getAssets:async()=>[],saveAsset:vi.fn(),deleteAsset:vi.fn()}));
import VideoPage from '../client/src/pages/analysis/VideoPage';

const entries = [
  { id:'ZH-Cseadanco2.5K', group:'Seedance 系列', resolution:'720p' },
  { id:'ZH-A-SD2.0', group:'Seedance 系列', resolution:'720p' },
  { id:'ZH-kksedanco2.5', group:'Seedance 系列', resolution:'720p' },
  { id:'ZH-LLseadanco2.51', group:'Seedance 系列', resolution:'720p' },
  { id:'ZH-Xminimex-h3', group:'MiniMax 系列', resolution:'2k' },
  { id:'ZH-wan-1080', group:'Wan 系列', resolution:'1080p' },
  { id:'seedance_v2.5', group:'HM 系列', resolution:'720p' },
  { id:'seedance-2.5-pro', group:'Seedance 系列', resolution:'720p' },
];
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){} unobserve(){}});
  mocks.list.mockResolvedValue(entries.map(({id,resolution})=>({
    id,name:id,description:'测试模型',available:true,allowedSeconds:[10],rates:{[resolution]:1},
  })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('legacy video sidebar family grouping', () => {
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
