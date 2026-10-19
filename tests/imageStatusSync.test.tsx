// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ poll: undefined as any }));
vi.mock('../client/src/utils/polling', () => ({ startPolling: vi.fn((callback: any) => {
  mocks.poll = () => callback(new AbortController().signal);
  void mocks.poll(); return vi.fn();
}) }));
vi.mock('../client/src/api/imageGen', async original => ({
  ...await original<any>(), fetchImageModels: vi.fn(async () => [{ id: 'gpt-image-2', name: 'GPT Image', available: true }]),
  getCachedImageModels: () => [{ id: 'gpt-image-2', name: 'GPT Image', available: true }],
  generateImage: vi.fn(() => new AbortController()),
}));
vi.mock('../client/src/api/content', () => ({ contentApi: { getMyContents: vi.fn(), getById: vi.fn() } }));
vi.mock('../client/src/hooks/useAuthGuard', () => ({ useAuthGuard: () => () => true }));
import ImageGenPage from '../client/src/pages/analysis/ImageGenPage';
import { generateImage } from '../client/src/api/imageGen';
import { contentApi } from '../client/src/api/content';
beforeEach(() => { vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [], total: 0 }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const row = (status: string, metadata = {}) => ({ id: 12693, type: 'image', status, metadata,
  inputText: '测试图片', model: 'gpt-image-2', createdAt: new Date().toISOString() });
const taskCard = () => document.querySelector<HTMLElement>('[data-task-id="12693"]');
function expectTaskCard(status: string, label: string) {
  const card = taskCard();
  expect(card).toBeTruthy();
  expect(card?.dataset.status).toBe(status);
  expect(card?.querySelector('.ig-task-status')?.textContent).toBe(label);
  expect(card?.querySelector('.ig-task-meta')?.textContent).toContain('任务 #12693');
  return card!;
}
async function submit() {
  await act(async () => { render(<ImageGenPage />); });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '测试图片' } });
  fireEvent.click(screen.getByRole('button', { name: '开始生成图片' }));
  const callback = vi.mocked(generateImage).mock.calls[0][1];
  act(() => callback({ type: 'content_id', contentId: 12693 }));
  return callback;
}
it('reconciles a live batch to failed even without an SSE terminal event', async () => {
  await submit();
  vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [row('failed', { failureReason: '上游超时', count: 1 })] });
  await act(async () => { await mocks.poll(); });
  const card = expectTaskCard('failed', '失败');
  expect(card.querySelector('.ig-task-detail')?.textContent).toBe('上游超时');
  expect(screen.queryByLabelText('图片 1 生成中')).toBeNull();
  expect(generateImage).toHaveBeenCalledTimes(1);
});
it('fetches tracked jobs outside the first page and recovers a lost success event', async () => {
  const callback = await submit();
  act(() => callback({ type: 'disconnected', contentId: 12693, message: '连接断开' }));
  vi.mocked(contentApi.getById).mockResolvedValue({ ...row('completed'), resultUrl: '/uploads/done.png' });
  await act(async () => { await mocks.poll(); });
  expect(contentApi.getById).toHaveBeenCalledWith(12693, expect.any(AbortSignal));
  expect(screen.getByRole('img', { name: /历史图片/ })).toBeTruthy();
  expectTaskCard('completed', '成功');
  expect(generateImage).toHaveBeenCalledTimes(1);
});
it('restores pending review without claiming the image failed or spinning', async () => {
  vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [row('processing', { requiresReview: true, error: '上游受理结果待核实' })] });
  await act(async () => { render(<ImageGenPage />); });
  const card = expectTaskCard('review', '待核实');
  expect(card.querySelector('.ig-task-detail')?.textContent).toBe('上游受理结果待核实');
  expect(document.querySelector('.ig-batch .ig-spin')).toBeNull();
});
it('does not infer queueing merely from zero percent', async () => {
  vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [row('processing', { progresses: [0] })] });
  await act(async () => { render(<ImageGenPage />); });
  expect(screen.getByLabelText('图片 1 生成中')).toBeTruthy();
  expect(screen.queryByText('#1 排队中')).toBeNull();
});
it('explains stale processing records without inventing a final status', async () => {
  vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [{ ...row('processing'), createdAt: new Date(Date.now() - 86400000).toISOString() }] });
  await act(async () => { render(<ImageGenPage />); });
  expectTaskCard('review', '核实中');
  expect(screen.getByText(/后台尚未确认成功或失败/)).toBeTruthy();
  expect(document.querySelector('.ig-batch .ig-spin')).toBeNull();
});
it('preserves the batch with an explicit checking state after a polling failure', async () => {
  await submit();
  vi.mocked(contentApi.getMyContents).mockRejectedValueOnce(new Error('offline'));
  await act(async () => { await expect(mocks.poll()).rejects.toThrow('offline'); });
  expectTaskCard('review', '核实中');
  expect(screen.getByText(/暂时无法读取任务状态/)).toBeTruthy();
});
