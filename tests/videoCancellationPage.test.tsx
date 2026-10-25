// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({ history: vi.fn(), detail: vi.fn(), cancel: vi.fn(), remove: vi.fn(), generate: vi.fn() }));
vi.mock('../client/src/api/video', () => ({
  getCachedVideoModels: () => [],
  fetchVideoModels: async () => [{ id: 'seedance_v2.5', name: '测试模型', available: true, allowedSeconds: [6], rates: { '720p': 1 } }],
  generateVideo: mocks.generate,
}));
vi.mock('../client/src/api/content', () => ({ contentApi: { getMyContents: mocks.history, getById: mocks.detail, cancelVideo: mocks.cancel, delete: mocks.remove } }));
vi.mock('../client/src/hooks/useAuthGuard', () => ({ useAuthGuard: () => () => true }));
vi.mock('../client/src/hooks/useVideoQuote', () => ({ useVideoQuote: () => ({ quote: { cost: 1 }, loading: false, error: null, refresh: vi.fn() }) }));
vi.mock('../client/src/components/FaceProcessingModal', () => ({ default: () => null }));
vi.mock('../client/src/components/ImageSlicerModal', () => ({ default: () => null }));
vi.mock('../client/src/utils/idb', () => ({ getAssets: async () => [], saveAsset: vi.fn(), deleteAsset: vi.fn() }));
import VideoPage from '../client/src/pages/analysis/VideoPage';
import { useAuthStore } from '../client/src/stores/authStore';

const initialAuth = useAuthStore.getState();
const record = (canCancel: boolean) => ({ id: 42, type: 'video', modelId: 'seedance_v2.5', status: 'processing', canCancel,
  metadata: { prompt: '原任务继续生成', model: 'seedance_v2.5', seconds: 6, resolution: '720p', aspect_ratio: '16:9', progress: canCancel ? 0 : 30 } });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.history.mockResolvedValue({ items: [], total: 0 }); mocks.detail.mockResolvedValue(record(false));
  mocks.generate.mockReturnValue(new AbortController());
  useAuthStore.setState({ user: { id: 1 } as any, isAuthenticated: true, fetchProfile: vi.fn().mockResolvedValue(undefined) });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useAuthStore.setState(initialAuth); });
const mount = () => render(<MemoryRouter><VideoPage /></MemoryRouter>);

it.each([false, undefined])('restored task with canCancel=%s never offers cancellation', async canCancel => {
  const item = { ...record(false), canCancel };
  mocks.history.mockResolvedValue({ items: [item], total: 1 }); mocks.detail.mockResolvedValue(item);
  mount(); await screen.findByText('原任务继续生成');
  expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument();
});

it('keeps a queued record until the server confirms cancellation, without using DELETE', async () => {
  mocks.history.mockResolvedValue({ items: [record(true)], total: 1 }); mocks.detail.mockResolvedValue(record(true));
  let finish!: () => void;
  mocks.cancel.mockReturnValue(new Promise<void>(r => { finish = r; }));
  mount(); fireEvent.click(await screen.findByRole('button', { name: '取消' }));
  expect(mocks.cancel).toHaveBeenCalledWith(42);
  expect(screen.getByText('原任务继续生成')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '取消中...' })).toBeDisabled();
  await act(async () => { finish(); });
  await waitFor(() => expect(screen.queryByText('原任务继续生成')).not.toBeInTheDocument());
  expect(mocks.remove).not.toHaveBeenCalled();
});

it('retains the record when an old cancel button loses the race to submission', async () => {
  mocks.history.mockResolvedValue({ items: [record(true)], total: 1 }); mocks.detail.mockResolvedValue(record(true));
  mocks.cancel.mockRejectedValue(new Error('任务已开始提交，不能取消'));
  mount(); fireEvent.click(await screen.findByRole('button', { name: '取消' }));
  await screen.findByText('任务已开始提交，不能取消');
  expect(screen.getByText('原任务继续生成')).toBeInTheDocument(); expect(mocks.remove).not.toHaveBeenCalled();
});

it('live submission updates remove the cancel button and a refused cancellation never aborts progress', async () => {
  mount();
  fireEvent.change(await screen.findByPlaceholderText(/描述你想生成的视频/), { target: { value: 'live original task' } });
  const submit = await screen.findByRole('button', { name: '开始生成视频' });
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.click(submit);
  await waitFor(() => expect(mocks.generate).toHaveBeenCalledOnce());
  const onEvent = mocks.generate.mock.calls[0][1];
  const controller = mocks.generate.mock.results[0].value as AbortController;
  const abort = vi.spyOn(controller, 'abort');
  mocks.detail.mockReturnValue(new Promise(() => {}));
  act(() => { onEvent({ type: 'content_id', contentId: 42, canCancel: true }); });
  mocks.cancel.mockRejectedValue(new Error('任务已开始提交，不能取消'));
  fireEvent.click(await screen.findByRole('button', { name: '取消' }));
  await screen.findByText('任务已开始提交，不能取消');
  expect(abort).not.toHaveBeenCalled();
  act(() => { onEvent({ type: 'progress', progress: 30, canCancel: false }); });
  expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument();
  act(() => { onEvent({ type: 'complete', videoUrl: '/uploads/original.mp4', canCancel: false }); });
  expect(screen.getByText('live original task')).toBeInTheDocument();
  expect(mocks.remove).not.toHaveBeenCalled();
});
