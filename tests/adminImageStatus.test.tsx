// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
vi.mock('../client/src/api/admin', () => ({ adminApi: { getContents: vi.fn(), getContent: vi.fn() } }));
import { adminApi } from '../client/src/api/admin';
import ContentsPage from '../client/src/pages/admin/ContentsPage';
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('shows review state and distinguishes absent IDs from old records', async () => {
  const base = { userId: 1, type: 'image', title: 'demo', inputText: '', resultUrl: null, resultText: '', modelId: 'gpt-image-2', cost: 0, createdAt: new Date().toISOString() };
  vi.mocked(adminApi.getContents).mockResolvedValue({ total: 3, items: [
    { ...base, id: 1, status: 'processing', metadata: JSON.stringify({ requiresReview: true, error: '受理结果待核实', upstreamTaskIds: ['req-known'] }) },
    { ...base, id: 2, status: 'failed', metadata: JSON.stringify({ upstreamResponses: [{ state: 'response_without_id', httpStatus: 400 }] }) },
    { ...base, id: 3, status: 'completed', metadata: '{}' },
  ] } as any);
  render(<MemoryRouter><ContentsPage /></MemoryRouter>);
  const table = await screen.findByRole('table');
  expect(await within(table).findByText('待核实')).toBeTruthy();
  expect(within(table).getByText('响应未解析到任务/请求 ID')).toBeTruthy();
  expect(within(table).getByText('未取得上游任务 ID')).toBeTruthy();
  fireEvent.click(within(table).getByRole('button', { name: '查看上游任务 req-known 详情' }));
  expect(screen.getByText('结果待核实')).toBeTruthy();
  expect(screen.getByText('受理结果待核实')).toBeTruthy();
});

it('Pidoi 保存重试不被浏览器计时误标为审核，并提供处理入口',async()=>{
  const item={id:13186,userId:1,type:'image',status:'processing',title:'test',modelId:'gpt-image-2',cost:.22,createdAt:'2026-01-01',
    resultUrl:null,metadata:JSON.stringify({imageProtocol:'pidoi-async-v1',recoveryStage:'download',billingStatus:'reserved',upstreamTaskId:'task_saved',pidoiImageJobs:[{status:'completed',sourceUrl:'https://cdn/a.png'}]})};
  vi.mocked(adminApi.getContents).mockResolvedValue({items:[item],total:1});vi.mocked(adminApi.getContent).mockResolvedValue(item);
  render(<MemoryRouter><ContentsPage/></MemoryRouter>);
  await screen.findByText('保存重试中');
  fireEvent.click(screen.getByRole('button',{name:'查看本地记录 13186 详情'}));
  await screen.findByRole('button',{name:'查询原任务'});
  expect(screen.queryByRole('button',{name:'确认失败并退款'})).toBeNull();
});
