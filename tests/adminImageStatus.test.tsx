// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
vi.mock('../client/src/api/admin', () => ({ adminApi: { getContents: vi.fn() } }));
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
  expect(within(table).getByText('上游响应未提供 ID')).toBeTruthy();
  expect(within(table).getByText('无已保存 ID（旧记录）')).toBeTruthy();
  fireEvent.click(within(table).getByRole('button', { name: '查看上游任务 req-known 详情' }));
  expect(screen.getByText('结果待核实')).toBeTruthy();
  expect(screen.getByText('受理结果待核实')).toBeTruthy();
});
