// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), profile: vi.fn() }));
vi.mock('../client/src/api/client', () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock('../client/src/api/video', () => ({ fetchVideoModels: async () => [{ id: 'test-video', name: '测试视频模型', description: '测试模型', available: true, rates: { '720p': 1.5 }, allowedSeconds: [6, 10] }] }));
vi.mock('../client/src/stores/authStore', () => ({ useAuthStore: () => ({ isAuthenticated: true, fetchProfile: mocks.profile }) }));
vi.mock('../client/src/hooks/useAuthGuard', () => ({ useAuthGuard: () => () => true }));
import VideoBatchPage from '../client/src/pages/analysis/VideoBatchPage';

beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue([]); mocks.post.mockReset(); mocks.profile.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('batch page form and prepaid confirmation', () => {
  it('starts with auto retry disabled and submits separate unchanged creative prompts/counts for quote', async () => {
    render(<VideoBatchPage />);
    await screen.findByText('测试视频模型');
    expect(screen.getByRole('checkbox', { name: /确认失败后/ })).not.toBeChecked();
    fireEvent.change(screen.getByLabelText('原始提示词'), { target: { value: '  第一组用户原词  ' } });
    fireEvent.click(screen.getByRole('button', { name: /添加一组创意/ }));
    fireEvent.change(screen.getAllByLabelText('原始提示词')[1], { target: { value: '第二组创意' } });
    const counts = screen.getAllByRole('spinbutton');
    fireEvent.change(counts[0], { target: { value: '20' } });
    fireEvent.change(counts[1], { target: { value: '30' } });
    mocks.post.mockResolvedValue({ unitCost: 1.5, total: 50, totalCost: 75 });
    fireEvent.click(screen.getByRole('button', { name: /校验并预估/ }));
    await screen.findByRole('button', { name: /确认预扣 ¥75.00/ });
    const body = mocks.post.mock.calls[0][1];
    expect(body.autoRetry).toBe(false);
    expect(body.creatives.map((c: any) => [c.prompt, c.count])).toEqual([['  第一组用户原词  ', 20], ['第二组创意', 30]]);
  });
  it('invalidates a displayed quote after editing and exposes the retry limit choice', async () => {
    render(<VideoBatchPage />); await screen.findByText('测试视频模型');
    mocks.post.mockResolvedValue({ unitCost: 1.5, total: 10, totalCost: 15 });
    fireEvent.change(screen.getByLabelText('原始提示词'), { target: { value: '原词' } });
    fireEvent.click(screen.getByRole('button', { name: /校验并预估/ }));
    await screen.findByRole('button', { name: /确认预扣/ });
    fireEvent.click(screen.getByRole('checkbox', { name: /确认失败后/ }));
    expect(screen.queryByRole('button', { name: /确认预扣/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('每条最多重试')).toHaveValue('2');
  });
  it('keeps the same idempotency key when submitting again after a lost response', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<VideoBatchPage />); await screen.findByText('测试视频模型');
    fireEvent.change(screen.getByLabelText('原始提示词'), { target: { value: '用户原词' } });
    mocks.post.mockResolvedValueOnce({ unitCost: 1.5, total: 10, totalCost: 15 });
    fireEvent.click(screen.getByRole('button', { name: /校验并预估/ }));
    const submit = await screen.findByRole('button', { name: /确认预扣/ });
    mocks.post.mockRejectedValue(new Error('网络中断'));
    fireEvent.click(submit);
    await screen.findByRole('alert');
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(3));
    expect(mocks.post.mock.calls[1][1].requestKey).toBeTruthy();
    expect(mocks.post.mock.calls[2][1].requestKey).toBe(mocks.post.mock.calls[1][1].requestKey);
    expect(mocks.post.mock.calls[2][1].expectedUnitCost).toBe(1.5);
  });
});
