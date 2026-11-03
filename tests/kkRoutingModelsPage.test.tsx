// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ModelsPage from '../client/src/pages/admin/ModelsPage';
import { adminApi } from '../client/src/api/admin';
vi.mock('../client/src/api/admin',()=>({adminApi:{getModels:vi.fn(),getChannels:vi.fn(),getPricing:vi.fn(),getModelStatistics:vi.fn(),getKkRouting:vi.fn(),saveKkRouting:vi.fn()}}));
beforeEach(()=>{
  vi.clearAllMocks();sessionStorage.clear();localStorage.clear();
  vi.mocked(adminApi.getModels).mockResolvedValue([{id:1,modelId:'kkseadanco2.5',displayName:'KK 2.5',capabilities:['video'],isActive:1,provider:'zongheng-v6k'}]);
  vi.mocked(adminApi.getChannels).mockResolvedValue([{id:21,name:'V6K',supportedModels:['kkseadanco2.5']}]);
  vi.mocked(adminApi.getPricing).mockResolvedValue([]);vi.mocked(adminApi.getModelStatistics).mockResolvedValue({items:[]});
  vi.mocked(adminApi.getKkRouting).mockResolvedValue({current:{primary:'stable',fallback:true,channelId:21},version:'spec',channels:[{id:21,name:'V6K',ready:true}]});
});
afterEach(cleanup);
it.each(['表格','卡片'])('opens the working routing control from the live models page in %s mode',async mode=>{
  render(<MemoryRouter><ModelsPage/></MemoryRouter>);
  await screen.findByRole('button',{name:'分流设置'});
  if(mode==='卡片')fireEvent.click(screen.getByRole('button',{name:'卡片'}));
  fireEvent.click(screen.getByRole('button',{name:'分流设置'}));
  expect(await screen.findByRole('region',{name:'KK 自动分流设置'})).toBeVisible();
  expect(await screen.findByText('已保存：稳定优先，自动分流已开启')).toBeVisible();
  expect(adminApi.getKkRouting).toHaveBeenCalledTimes(1);expect(adminApi.saveKkRouting).not.toHaveBeenCalled();
});
