// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import type { VideoModel } from '../client/src/api/video';
import { groupTt25ModelCards } from '../client/src/utils/tt25ModelCards';
import { v6kTt25Limits } from '../shared/v6kTt25';

const mocks = vi.hoisted(() => ({ list: vi.fn(), generate: vi.fn(), history: vi.fn(), content: vi.fn(), quote: vi.fn(), detail: vi.fn() }));
vi.mock('../client/src/api/video', () => ({ getCachedVideoModels: () => [], fetchVideoModels: mocks.list, generateVideo: mocks.generate }));
vi.mock('../client/src/api/content', () => ({ contentApi: { getMyContents: mocks.history, getById: mocks.content } }));
vi.mock('../client/src/api/admin', () => ({ adminApi: { getContent: mocks.detail } }));
vi.mock('../client/src/hooks/useAuthGuard', () => ({ useAuthGuard: () => () => true }));
vi.mock('../client/src/hooks/useVideoQuote', () => ({ useVideoQuote: mocks.quote }));
vi.mock('../client/src/components/FaceProcessingModal', () => ({ default: () => null }));
vi.mock('../client/src/components/ImageSlicerModal', () => ({ default: () => null }));
vi.mock('../client/src/utils/idb', () => ({ getAssets: async () => [], saveAsset: vi.fn(), deleteAsset: vi.fn() }));
vi.mock('../client/src/utils/imageNormalization', async original => ({ ...await original<any>(), findUnreadableImageIndexes: async () => [] }));
import VideoPage from '../client/src/pages/analysis/VideoPage';
import { useAuthStore } from '../client/src/stores/authStore';

function models(prefix = 'ZH-'): VideoModel[] {
  return [['480', .28], ['720', .4], ['1080', .9]].map(([suffix, price]) => {
    const id = prefix + 'TTseadanco2.5-' + suffix, resolution = suffix + 'p';
    return { id, name: id, description: 'original description', available: true, billingType: 'per_second',
      maxSeconds: 30, allowedSeconds: Array.from({ length: 26 }, (_, i) => i + 5), rates: { [resolution]: price }, routingLimits: v6kTt25Limits(id)! } as VideoModel;
  });
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.list.mockResolvedValue(models()); mocks.history.mockResolvedValue({ items: [], total: 0 });
  mocks.generate.mockReturnValue(new AbortController());
  mocks.quote.mockImplementation((id: string, resolution: string, seconds: number) => {
    const price = models().find(m => m.id === id)?.rates?.[resolution as '480p'] ?? 0;
    return { quote: { model: id, resolution, seconds, rate: price, cost: Number((price * seconds).toFixed(6)), billingType: 'per_second' }, loading: false, error: null, refresh: vi.fn() };
  });
  useAuthStore.setState({ user: { id: 1 } as any, isAuthenticated: true });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useAuthStore.setState({ user: null, isAuthenticated: false }); });

describe('TT 2.5 presentation grouping', () => {
  it.each(['ZH-', ''])('shows one card with live prices without mutating real products (%s)', prefix => {
    const source = models(prefix), snapshot = JSON.stringify(source), cards = groupTt25ModelCards(source, source[1].id, '720p');
    expect(cards).toHaveLength(1); expect(cards[0]).toMatchObject({ id: source[1].id, name: 'TT Seedance 2.5', rates: { '480p': .28, '720p': .4, '1080p': .9 } });
    expect(Object.values(cards[0].resolutionModels!).map(m => m.id)).toEqual(source.map(m => m.id)); expect(JSON.stringify(source)).toBe(snapshot);
    source[1].rates!['720p'] = .47;
    expect(groupTt25ModelCards(source, source[1].id, '720p')[0].rates!['720p']).toBe(.47);
  });
  it('keeps TTT fixed-price models, different constraints, duplicate resolutions and other models separate', () => {
    const source = models(), fixed = { ...source[1], id: 'TTTseadanco2.5/720', name: 'TTT fixed', billingType: 'per_call' as const };
    expect(groupTt25ModelCards([...source, fixed], source[0].id, '480p')).toHaveLength(2);
    expect(groupTt25ModelCards([...source, { ...source[0], id: 'TTseadanco2.5-480' }], source[0].id, '480p')).toHaveLength(4);
    source[1].routingLimits = { ...source[1].routingLimits!, maxImages: 5 };
    expect(groupTt25ModelCards(source, source[0].id, '480p')).toHaveLength(3);
  });
  it('shows a single compact model card and all three resolution prices', async () => {
    render(<MemoryRouter><VideoPage /></MemoryRouter>);
    const card = await screen.findByRole('button', { name: /TT Seedance 2.5/ });
    expect(screen.getAllByRole('button', { name: /TT Seedance 2.5/ })).toHaveLength(1);
    for (const price of ['¥0.28/秒', '¥0.40/秒', '¥0.90/秒']) expect(card.textContent).toContain(price);
    expect(card.textContent).toContain('5–30秒');
    for (const source of models()) expect(screen.queryByText(source.name)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上传参考图片，最多 30 张' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上传参考视频，最多 10 个' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上传参考音频，最多 10 段' })).toBeInTheDocument();
  });
  it.each([['480p', 8.4], ['720p', 12], ['1080p', 27]] as const)('quotes and submits the real %s model at its own 30-second price', async (resolution, cost) => {
    render(<MemoryRouter><VideoPage /></MemoryRouter>);
    await screen.findByRole('button', { name: /TT Seedance 2.5/ });
    await waitFor(() => expect(screen.getByRole('button', { name: '480p', exact: true })).toBeInTheDocument());
    if (resolution !== '480p') {
      fireEvent.click(screen.getByRole('button', { name: '480p', exact: true })); fireEvent.click(screen.getByRole('button', { name: resolution, exact: true }));
    }
    fireEvent.click(screen.getByRole('button', { name: '6 秒', exact: true })); fireEvent.click(screen.getByRole('button', { name: '30 秒', exact: true }));
    fireEvent.change(screen.getByPlaceholderText(/描述你想生成的视频内容/), { target: { value: '测试对应分辨率的真实型号' } });
    const id = 'ZH-TTseadanco2.5-' + resolution.replace('p', '');
    await waitFor(() => expect(mocks.quote).toHaveBeenLastCalledWith(id, resolution, 30, true, []));
    fireEvent.click(screen.getByRole('button', { name: '开始生成视频' }));
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    expect(mocks.generate.mock.calls[0][0]).toMatchObject({ model: id, resolution, video_length: 30, expectedCost: cost });
  });
  it('does not make an unavailable resolution selectable or switch the selected model when prices refresh', async () => {
    const source = models(); source[2].available = false; mocks.list.mockResolvedValue(source);
    render(<MemoryRouter><VideoPage /></MemoryRouter>); await screen.findByRole('button', { name: /TT Seedance 2.5/ });
    await waitFor(() => expect(screen.getByRole('button', { name: '480p', exact: true })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '480p', exact: true }));
    expect(screen.getByRole('button', { name: '1080p（暂不可用）' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '720p', exact: true }));
    source[0].rates!['480p'] = .31; mocks.list.mockResolvedValue([...source]); fireEvent(window, new Event('focus'));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: '720p', exact: true })).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /TT Seedance 2.5/ })).getByText('¥0.31/秒')).toBeInTheDocument();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
