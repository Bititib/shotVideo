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
  expect((within(dialog).getByRole('button',{name:'补录并重新获取'}) as HTMLButtonElement).disabled).toBe(true);
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

it('shows the missing-ID supplement form and saves before querying upstream', async () => {
  render(<MemoryRouter><ContentsPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: '查看本地记录 13360 详情' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('管理员补录与恢复')).toBeTruthy();
  fireEvent.change(within(dialog).getByLabelText('补录上游任务 ID'), { target: { value: 'task-upstream-1' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '补录并重新获取' }));

  await waitFor(() => expect(adminApi.recoverContentUpstream).toHaveBeenCalledWith(13360));
  expect(adminApi.saveContentRecoveryTaskId).toHaveBeenCalledWith(13360, 'task-upstream-1');
  expect(vi.mocked(adminApi.saveContentRecoveryTaskId).mock.invocationCallOrder[0])
    .toBeLessThan(vi.mocked(adminApi.recoverContentUpstream).mock.invocationCallOrder[0]);
});

it('does not start recovery when candidate verification fails and leaves the input available', async () => {
  vi.mocked(adminApi.saveContentRecoveryTaskId).mockRejectedValueOnce(new Error('上游查询 HTTP 404'));
  render(<MemoryRouter><ContentsPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', {name:'查看本地记录 13360 详情'}));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('补录上游任务 ID'),{target:{value:'wrong-id'}});
  fireEvent.click(within(dialog).getByRole('button',{name:'补录并重新获取'}));
  await waitFor(()=>expect(window.alert).toHaveBeenCalledWith('上游查询 HTTP 404'));
  expect(adminApi.recoverContentUpstream).not.toHaveBeenCalled();
  expect(within(dialog).getByLabelText('补录上游任务 ID')).toBeTruthy();
});

it('withdraws an old unverified manual ID, then exposes supplement and confirmed refund without charging', async () => {
  const meta = {reviewKind:'submission',billingStatus:'review',requiresReview:true,
    videoId:'wrong-id',upstreamTaskId:'wrong-id',recoveryTaskIdSupplemented:true,
    recoveryAudit:[{action:'supplement_task_id',taskId:'wrong-id',previousTaskId:''}]};
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
  expect(within(dialog).queryByRole('button',{name:'一键失败并退款'})).toBeNull();
  fireEvent.click(within(dialog).getByRole('button',{name:'撤销未核实补录'}));
  await waitFor(()=>expect(within(dialog).getByRole('button',{name:'一键失败并退款'})).toBeTruthy());
  expect(adminApi.withdrawContentRecoveryTaskId).toHaveBeenCalledWith(13360,'wrong-id');
  expect(within(dialog).getByLabelText('补录上游任务 ID')).toBeTruthy();
  expect(adminApi.recoverContentUpstream).not.toHaveBeenCalled();
});
