// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PricingPage from '../client/src/pages/admin/PricingPage';
import { adminApi } from '../client/src/api/admin';

vi.mock('../client/src/api/admin', () => ({adminApi:{getPricing:vi.fn(),updatePricing:vi.fn(),createPricing:vi.fn()}}));
vi.mock('../client/src/api/adminCache', () => ({getAdminCached:()=>undefined}));
beforeEach(()=>{sessionStorage.clear();localStorage.clear();vi.clearAllMocks();});
afterEach(cleanup);

it('hides retired DDLONG resolution in the card and editor, preserving its stored price when saving 720p', async()=>{
  const rule={id:7,modelPattern:'sd2.5-933',displayName:'HM-Sd2.5-933',category:'video',billingType:'per_call',
    inputPrice:6,outputPrice:0,extraParams:{category:'video','720p':6,'1080p':12},modelActive:true,configured:true,inherited:false};
  vi.mocked(adminApi.getPricing).mockResolvedValue([rule] as any);
  vi.mocked(adminApi.updatePricing).mockResolvedValue({} as any);
  render(<MemoryRouter><PricingPage modelId="sd2.5-933"/></MemoryRouter>);
  await screen.findByRole('button',{name:'编辑'});
  fireEvent.click(screen.getByRole('button',{name:'卡片'}));
  expect(screen.queryByText(/1080p/)).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'编辑'}));
  expect((screen.getByLabelText('720p 单价') as HTMLInputElement).value).toBe('6');
  expect(screen.queryByLabelText('1080p 单价')).toBeNull();
  fireEvent.change(screen.getByLabelText('720p 单价'),{target:{value:'6.5'}});
  fireEvent.click(screen.getByRole('button',{name:'保存并立即生效'}));
  await waitFor(()=>expect(adminApi.updatePricing).toHaveBeenCalledWith(7,expect.objectContaining({inputPrice:6,
    extraParams:{category:'video','720p':6.5,'1080p':12}})));
});

it('continues to show supported 1080p prices for FAST models', async()=>{
  vi.mocked(adminApi.getPricing).mockResolvedValue([{id:8,modelPattern:'SD2.0FAST803',displayName:'FAST803',category:'video',billingType:'per_call',
    inputPrice:1.1,outputPrice:0,extraParams:{'720p':1.1,'1080p':1.3,'2k':1.5},modelActive:true,configured:true,inherited:false}] as any);
  render(<MemoryRouter><PricingPage modelId="SD2.0FAST803"/></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button',{name:'编辑'}));
  expect((screen.getByLabelText('1080p 单价') as HTMLInputElement).value).toBe('1.3');
  expect((screen.getByLabelText('2k 单价') as HTMLInputElement).value).toBe('1.5');
});
