// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
vi.mock('../client/src/api/admin', () => ({ adminApi: { getContents: vi.fn(), getContent: vi.fn(), recoverContentUpstream: vi.fn() } }));
import { adminApi } from '../client/src/api/admin';
import ContentsPage from '../client/src/pages/admin/ContentsPage';
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); });
it('恢复生成中的视频明确确认补扣，并刷新详情与列表', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  const item = { id: 13738, userId: 1, type: 'video', title: 'video test', modelId: 'seedance-2.0-mini-720p', status: 'failed', cost: 0,
    resultUrl: null, createdAt: new Date().toISOString(), metadata: JSON.stringify({ videoId: 'task_saved', channelId: 5, error: '查询 404', queueRefunded: true, billingStatus: 'refunded', refundAmount: 1.5 }) };
  const updated = { ...item, status: 'processing', cost: 1.5, metadata: JSON.stringify({ videoId: 'task_saved', progress: 60, billingStatus: 'recovery_precharged', queueRefunded: false }) };
  vi.mocked(adminApi.getContents).mockResolvedValue({ items: [item], total: 1 });
  vi.mocked(adminApi.getContent).mockResolvedValue(updated);
  vi.mocked(adminApi.recoverContentUpstream).mockResolvedValue({ status: 'processing', progress: 60, chargedAmount: 1.5, message: '已补扣 ¥1.50，恢复原任务轮询' });
  render(<MemoryRouter><ContentsPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: '查看本地记录 13738 详情' }));
  const beforeRefresh = vi.mocked(adminApi.getContents).mock.calls.length;
  fireEvent.click(await screen.findByRole('button', { name: '重新获取上游结果' }));
  await waitFor(() => expect(adminApi.getContent).toHaveBeenCalledWith(13738));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('已扣费且未退款的任务不再扣费'));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('已退款任务确认仍在生成或已成功'));
  expect(alert).toHaveBeenCalledWith(expect.stringContaining('已补扣 ¥1.50'));
  await waitFor(() => expect(vi.mocked(adminApi.getContents).mock.calls.length).toBeGreaterThan(beforeRefresh));
});
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

it('生成中的已付费视频可取回原结果，按钮忙碌时禁用，成功后刷新并移除按钮', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  const item = { id: 13797, userId: 1, type: 'video', title: 'paid video', modelId: 'seedance-2.0-mini-720p',
    status: 'processing', cost: 1.5, resultUrl: null, createdAt: new Date().toISOString(),
    metadata: JSON.stringify({ videoId: 'task_saved', channelId: 5, progress: 85 }) };
  const updated = { ...item, status: 'completed', resultUrl: '/uploads/videos/saved.mp4' };
  let resolve!: (r: any) => void;
  vi.mocked(adminApi.getContents).mockResolvedValue({ items: [item], total: 1 });
  vi.mocked(adminApi.getContent).mockResolvedValue(updated);
  vi.mocked(adminApi.recoverContentUpstream).mockImplementation(() => new Promise(r => { resolve = r; }));
  render(<MemoryRouter><ContentsPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: '查看本地记录 13797 详情' }));
  fireEvent.click(await screen.findByRole('button', { name: '重新获取上游结果' }));
  const busy = await screen.findByRole('button', { name: '正在重新获取…' });
  expect((busy as HTMLButtonElement).disabled).toBe(true);
  resolve({ status: 'completed', chargedAmount: 0, message: '任务已恢复，使用原预扣费用结算' });
  await waitFor(() => expect(adminApi.getContent).toHaveBeenCalledWith(13797));
  await waitFor(() => expect(screen.queryByRole('button', { name: '重新获取上游结果' })).toBeNull());
  expect(alert).toHaveBeenCalledWith(expect.stringContaining('任务已恢复'));
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
