// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../client/src/api/admin', () => ({ adminApi: {
  getContents: vi.fn(),
  getContent: vi.fn(),
  saveContentRecoveryTaskId: vi.fn(),
  withdrawContentRecoveryTaskId: vi.fn(),
  recoverContentUpstream: vi.fn(),
  downloadContentOriginalV6k: vi.fn(),
  restoreContentOriginalVideo: vi.fn(),
} }));

import { adminApi } from '../client/src/api/admin';
import ContentsPage from '../client/src/pages/admin/ContentsPage';

const item = {
  id: 13360,
  userId: 98,
  type: 'video',
  title: 'missing upstream task',
  inputText: 'prompt',
  resultUrl: null,
  resultText: 'Upstream task ID is missing',
  modelId: 'wan3.0-video-prime',
  cost: 0,
  status: 'failed',
  createdAt: '2026-10-18T05:10:40Z',
  userEmail: 'user@example.com',
  userName: 'vx-test',
  metadata: JSON.stringify({ channelName: 'snumom WAN3.0 渠道', seconds: 15, resolution: '720p', aspect_ratio: '9:16' }),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.mocked(adminApi.getContents).mockResolvedValue({ items: [item], total: 1 } as any);
  vi.mocked(adminApi.getContent).mockResolvedValue(item as any);
  vi.mocked(adminApi.saveContentRecoveryTaskId).mockResolvedValue({ message: '已补录', taskId: 'task-upstream-1' });
  vi.mocked(adminApi.recoverContentUpstream).mockResolvedValue({ status: 'processing', message: '仍在生成' });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('shows the supplement and confirmed-refund controls for historical placeholder IDs', async () => {
  const broken = {...item, status:'review',cost:7,metadata:JSON.stringify({reviewKind:'submission',billingStatus:'review',requiresReview:true,
    videoId:'未取得上游任务 ID',upstreamTaskId:'未取得上游任务 ID',error:'HTTP 502'})};
  vi.mocked(adminApi.getContents).mockResolvedValue({items:[broken],total:1} as any);
  vi.mocked(adminApi.getContent).mockResolvedValue(broken as any);
  render(<MemoryRouter><ContentsPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button',{name:'查看本地记录 13360 详情'}));
  const dialog = await screen.findByRole('dialog');
  const field = within(dialog).getByLabelText('补录上游任务 ID') as HTMLInputElement;
  expect(field.value).toBe('');
  expect(within(dialog).getByRole('button',{name:'一键失败并退款'})).toBeTruthy();
  fireEvent.change(field,{target:{value:'未取得上游任务 ID'}});
  expect((within(dialog).getByRole('button',{name:'补录并恢复到订单'}) as HTMLButtonElement).disabled).toBe(true);
  expect(adminApi.saveContentRecoveryTaskId).not.toHaveBeenCalled();
});

it.each([
  ['review', { reviewKind: 'submission', requiresReview: true }, '提交待核实'],
  ['review', { reviewKind: 'query', requiresReview: true }, '查询异常'],
  ['review', { reviewKind: 'settlement', requiresReview: true }, '结算待核实'],
  ['processing', { upstreamQueryError: 'temporary lookup error' }, '查询重试中'],
] as const)('shows %s phase %j as %s instead of a generic review badge', async (status, metadata, label) => {
  vi.mocked(adminApi.getContents).mockResolvedValue({ items: [{ ...item, status, metadata: JSON.stringify(metadata) }], total: 1 } as any);
  render(<MemoryRouter><ContentsPage /></MemoryRouter>);
  expect(await screen.findByText(label)).toBeTruthy();
});

it('uses the non-billing restore endpoint for non-V6K orders with missing IDs', async () => {
  vi.mocked(adminApi.restoreContentOriginalVideo).mockResolvedValueOnce({ id: item.id, taskId: 'task-upstream-1',
    status: 'completed', resultUrl: '/uploads/videos/original.mp4', message: '原视频已恢复' });
  render(<MemoryRouter><ContentsPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: '查看本地记录 13360 详情' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('原视频恢复')).toBeTruthy();
  fireEvent.change(within(dialog).getByLabelText('补录上游任务 ID'), { target: { value: 'task-upstream-1' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '补录并恢复到订单' }));

  await waitFor(() => expect(adminApi.restoreContentOriginalVideo).toHaveBeenCalledWith(13360, 'task-upstream-1'));
  expect(adminApi.saveContentRecoveryTaskId).not.toHaveBeenCalled();
  expect(adminApi.recoverContentUpstream).not.toHaveBeenCalled();
});

it('does not start recovery when candidate verification fails and leaves the input available', async () => {
  vi.mocked(adminApi.restoreContentOriginalVideo).mockRejectedValueOnce(new Error('上游查询 HTTP 404'));
  render(<MemoryRouter><ContentsPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', {name:'查看本地记录 13360 详情'}));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('补录上游任务 ID'),{target:{value:'wrong-id'}});
  fireEvent.click(within(dialog).getByRole('button',{name:'补录并恢复到订单'}));
  await waitFor(()=>expect(window.alert).toHaveBeenCalledWith('上游查询 HTTP 404'));
  expect(adminApi.recoverContentUpstream).not.toHaveBeenCalled();
  expect(within(dialog).getByLabelText('补录上游任务 ID')).toBeTruthy();
});

it.each(['failed', 'processing'])('keeps the read-only V6K download separate from restoration on a %s specification order', async status => {
  const order = { ...item, status, metadata: JSON.stringify({
    managedSpecification: true, zonghengProtocol: 'v6k', channelId: 21,
    requiresReview: status === 'processing', reviewKind: 'submission',
  }) };
  vi.mocked(adminApi.getContents).mockResolvedValue({ items: [order], total: 1 } as any);
  vi.mocked(adminApi.getContent).mockResolvedValue(order as any);
  vi.mocked(adminApi.downloadContentOriginalV6k).mockRejectedValueOnce(new Error('上游任务状态为 in_progress'));
  render(<MemoryRouter><ContentsPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: '查看本地记录 13360 详情' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).queryByRole('button', { name: '补录并重新获取' })).toBeNull();
  fireEvent.change(within(dialog).getByLabelText('补录上游任务 ID'), { target: { value: 'task_original' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '仅管理员下载（不结算）' }));
  await waitFor(() => expect(window.alert).toHaveBeenCalledWith('上游任务状态为 in_progress'));
  expect(adminApi.downloadContentOriginalV6k).toHaveBeenCalledWith(13360, 'task_original');
  expect(adminApi.restoreContentOriginalVideo).not.toHaveBeenCalled();
  expect(adminApi.saveContentRecoveryTaskId).not.toHaveBeenCalled();
  expect(adminApi.recoverContentUpstream).not.toHaveBeenCalled();
});

it('restores a verified V6K original through the dedicated endpoint and refreshes the order preview', async () => {
  const order = { ...item, status: 'processing', metadata: JSON.stringify({
    managedSpecification: true, zonghengProtocol: 'v6k', channelId: 21, requiresReview: true, reviewKind: 'submission',
  }) };
  const restored = { ...order, status: 'completed', resultUrl: '/uploads/videos/original.mp4' };
  vi.mocked(adminApi.getContents).mockResolvedValue({ items: [order], total: 1 } as any);
  vi.mocked(adminApi.getContent).mockResolvedValue(order as any);
  vi.mocked(adminApi.restoreContentOriginalVideo).mockImplementation(async () => {
    vi.mocked(adminApi.getContent).mockResolvedValue(restored as any);
    return { id: order.id, status: 'completed', resultUrl: restored.resultUrl, taskId: 'task_original', message: '原视频已恢复' };
  });
  render(<MemoryRouter><ContentsPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: '查看本地记录 13360 详情' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('补录上游任务 ID'), { target: { value: 'task_original' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '补录并恢复到订单' }));
  await waitFor(() => expect(dialog.querySelector('video')).not.toBeNull());
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('已退款按原金额补扣原账户'));
  expect(adminApi.restoreContentOriginalVideo).toHaveBeenCalledExactlyOnceWith(13360, 'task_original');
  expect(adminApi.downloadContentOriginalV6k).not.toHaveBeenCalled();
  expect(adminApi.saveContentRecoveryTaskId).not.toHaveBeenCalled();
  expect(adminApi.recoverContentUpstream).not.toHaveBeenCalled();
});

it('keeps a delivered video visible and exposes settlement retry when the original balance is insufficient', async () => {
  const order = { ...item, status: 'completed', resultUrl: '/uploads/videos/original.mp4', metadata: JSON.stringify({
    channelId: 21, videoId: 'task_original', originalVideoRestoration: { taskId: 'task_original' },
    originalVideoBillingPending: true, originalVideoBillingError: '原退款账户余额不足',
  }) };
  vi.mocked(adminApi.getContents).mockResolvedValue({ items: [order], total: 1 } as any);
  vi.mocked(adminApi.getContent).mockResolvedValue(order as any);
  vi.mocked(adminApi.restoreContentOriginalVideo).mockResolvedValue({ id: item.id, status: 'completed', taskId: 'task_original', resultUrl: order.resultUrl, message: '已结算' });
  render(<MemoryRouter><ContentsPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: '查看本地记录 13360 详情' }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog.querySelector('video')).not.toBeNull();
  expect(within(dialog).getByText(/原退款账户余额不足/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: '重试原订单结算' }));
  await waitFor(() => expect(adminApi.restoreContentOriginalVideo).toHaveBeenCalledWith(item.id, 'task_original'));
  expect(adminApi.downloadContentOriginalV6k).not.toHaveBeenCalled();
});

it.each(['wrong-id','未取得上游任务 ID'])('withdraws an old unverified manual ID %s, then exposes supplement and confirmed refund without charging', async taskId => {
  const meta = {reviewKind:'submission',billingStatus:'review',requiresReview:true,
    videoId:taskId,upstreamTaskId:taskId,recoveryTaskIdSupplemented:true,upstreamStatus:'unknown',
    recoveryAudit:[{action:'supplement_task_id',taskId,previousTaskId:''}]};
  const broken = {...item,status:'review',cost:7,metadata:JSON.stringify(meta)};
  vi.mocked(adminApi.getContents).mockResolvedValue({items:[broken],total:1} as any);
  vi.mocked(adminApi.getContent).mockResolvedValue(broken as any);
  vi.mocked(adminApi.withdrawContentRecoveryTaskId).mockImplementation(async()=>{
    vi.mocked(adminApi.getContent).mockResolvedValue({...broken,metadata:JSON.stringify({reviewKind:'submission',billingStatus:'review'})} as any);
    return {message:'已撤销，费用未变更'};
  });
  render(<MemoryRouter><ContentsPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button',{name:'查看本地记录 13360 详情'}));
  const dialog = await screen.findByRole('dialog');
  if (taskId === 'wrong-id') expect(within(dialog).queryByRole('button',{name:'一键失败并退款'})).toBeNull();
  fireEvent.click(within(dialog).getByRole('button',{name:'撤销未核实补录'}));
  await waitFor(()=>expect(within(dialog).getByRole('button',{name:'一键失败并退款'})).toBeTruthy());
  expect(adminApi.withdrawContentRecoveryTaskId).toHaveBeenCalledWith(13360,taskId);
  expect(within(dialog).getByLabelText('补录上游任务 ID')).toBeTruthy();
  expect(adminApi.recoverContentUpstream).not.toHaveBeenCalled();
});
