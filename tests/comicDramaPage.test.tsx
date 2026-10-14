// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ComicDramaPage from '../client/src/pages/analysis/ComicDramaPage';
import { analysisApi } from '../client/src/api/analysis';
import { useAuthStore } from '../client/src/stores/authStore';

vi.mock('../client/src/api/analysis', () => ({ analysisApi: {
  getAvailableModels: vi.fn(),
  planComicDramaSeries: vi.fn(),
  analyzeComicDramaScript: vi.fn(),
} }));
vi.mock('../client/src/api/imageGen', () => ({ fetchImageModels: vi.fn().mockResolvedValue([]), generateImage: vi.fn() }));
vi.mock('../client/src/api/video', () => ({ fetchVideoModels: vi.fn().mockResolvedValue([]), generateVideo: vi.fn() }));

const script = '林晚推开门，失踪三年的哥哥站在阴影中，握着一枚发光的旧怀表。\n'.repeat(10);
const initialAuth = useAuthStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useAuthStore.setState({ ...initialAuth, isAuthenticated: false, showLoginModal: false });
  vi.mocked(analysisApi.getAvailableModels).mockResolvedValue([{ modelId: 'gemini-test', displayName: '测试模型' }]);
});
afterEach(() => {
  cleanup();
  useAuthStore.setState(initialAuth);
  localStorage.clear();
});

async function mount(mode: 'episode' | 'series') {
  render(<ComicDramaPage />);
  await screen.findByRole('option', { name: '测试模型' });
  if (mode === 'series') fireEvent.click(screen.getByRole('button', { name: '整部剧本自动分集' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: script } });
  return screen.getByRole('button', { name: mode === 'series' ? '生成分集方案' : '自动分析剧本' });
}

describe('漫剧工坊生成入口使用真实登录检查', () => {
  it.each(['episode', 'series'] as const)('未登录时 %s 入口打开登录框并阻止请求', async mode => {
    fireEvent.click(await mount(mode));
    await waitFor(() => expect(useAuthStore.getState().showLoginModal).toBe(true));
    expect(analysisApi.planComicDramaSeries).not.toHaveBeenCalled();
    expect(analysisApi.analyzeComicDramaScript).not.toHaveBeenCalled();
  });

  it('已登录时生成分集方案并进入确认页面', async () => {
    useAuthStore.setState({ isAuthenticated: true });
    vi.mocked(analysisApi.planComicDramaSeries).mockResolvedValue({
      title: '旧怀表', logline: '失踪的哥哥归来', genre: '悬疑', visualStyle: '国漫', totalCharacters: script.length,
      episodes: [{ episodeNumber: 1, title: '归来', summary: '哥哥归来', hook: '怀表倒转', startBlock: 1, endBlock: 2, estimatedDuration: 90, characterCount: script.length, script }],
    });
    const submit = await mount('series');
    fireEvent.change(screen.getByLabelText('每集目标时长'), { target: { value: '120' } });
    fireEvent.change(screen.getByLabelText('期望集数（可选）'), { target: { value: '3' } });
    fireEvent.click(submit);
    expect(await screen.findByRole('heading', { name: '确认后批量建立剧集' })).toBeTruthy();
    expect(analysisApi.planComicDramaSeries).toHaveBeenCalledWith(script.trim(), {
      targetDuration: 120, requestedEpisodes: 3, modelId: 'gemini-test',
    });
    expect(useAuthStore.getState().showLoginModal).toBe(false);
  });

  it('已登录时提交单集分析并显示接口错误', async () => {
    useAuthStore.setState({ isAuthenticated: true });
    vi.mocked(analysisApi.analyzeComicDramaScript).mockRejectedValue(new Error('分析服务暂时不可用'));
    fireEvent.click(await mount('episode'));
    expect(await screen.findByText('分析服务暂时不可用')).toBeTruthy();
    expect(analysisApi.analyzeComicDramaScript).toHaveBeenCalledWith(script.trim(), 'gemini-test');
    expect((screen.getByRole('button', { name: '自动分析剧本' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
