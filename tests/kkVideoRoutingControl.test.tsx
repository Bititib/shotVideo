// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import KkVideoRoutingControl from '../client/src/components/KkVideoRoutingControl';
import { adminApi } from '../client/src/api/admin';
vi.mock('../client/src/api/admin',()=>({adminApi:{getKkRouting:vi.fn(),saveKkRouting:vi.fn()}}));
beforeEach(()=>{
  vi.clearAllMocks();vi.mocked(adminApi.getKkRouting).mockResolvedValue({current:null,version:'original-spec',channels:[{id:21,name:'V6K',ready:true}]});
  vi.mocked(adminApi.saveKkRouting).mockResolvedValue({});
});
afterEach(cleanup);
it('lets an administrator enable fallback, select the primary and save the explicit settings',async()=>{
  const onSaved=vi.fn(async()=>{});render(<KkVideoRoutingControl disabled={false} onSaved={onSaved}/>);
  const toggle=await screen.findByRole('switch',{name:'自动分流'});
  await waitFor(()=>expect(toggle).toBeEnabled());expect(toggle).toHaveAttribute('aria-checked','false');
  fireEvent.click(toggle);expect(toggle).toHaveAttribute('aria-checked','true');
  fireEvent.change(screen.getByLabelText('首选线路'),{target:{value:'kk'}});
  fireEvent.click(screen.getByRole('button',{name:'保存分流设置'}));
  await waitFor(()=>expect(adminApi.saveKkRouting).toHaveBeenCalledWith({primary:'kk',fallback:true,channelId:21},'original-spec'));
  expect(onSaved).toHaveBeenCalledTimes(1);
});
it('does not save over unsaved specification edits',async()=>{
  render(<KkVideoRoutingControl disabled={true} onSaved={vi.fn()}/>);
  expect(await screen.findByRole('switch',{name:'自动分流'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'保存分流设置'}));expect(adminApi.saveKkRouting).not.toHaveBeenCalled();
});
it('shows a rejected update and keeps the previously saved state',async()=>{
  vi.mocked(adminApi.getKkRouting).mockResolvedValue({current:{primary:'kk',fallback:false,channelId:21},version:'v1',channels:[{id:21,name:'V6K',ready:true}]});
  vi.mocked(adminApi.saveKkRouting).mockRejectedValue(Error('当前 Key 未开放稳定线路'));
  render(<KkVideoRoutingControl disabled={false} onSaved={vi.fn()}/>);
  await waitFor(()=>expect(screen.getByRole('switch')).toBeEnabled());fireEvent.click(screen.getByRole('switch'));
  fireEvent.click(screen.getByRole('button',{name:'保存分流设置'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('当前 Key 未开放稳定线路');
  expect(screen.getByText('已保存：KK 优先，自动分流已关闭')).toBeVisible();
});
