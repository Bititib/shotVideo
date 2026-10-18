// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../client/src/api/admin', () => ({ adminApi: {
  getContents: vi.fn(),
  getContent: vi.fn(),
  saveContentRecoveryTaskId: vi.fn(),
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
