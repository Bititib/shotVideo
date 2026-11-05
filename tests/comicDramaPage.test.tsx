// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ComicDramaPage from '../client/src/pages/analysis/ComicDramaPage';
import { analysisApi } from '../client/src/api/analysis';
import { fetchVideoModels, generateVideo } from '../client/src/api/video';
import { useAuthStore } from '../client/src/stores/authStore';

vi.mock('../client/src/api/analysis', () => ({ analysisApi: {
  getAvailableModels: vi.fn(),
  listComicDramaProjects: vi.fn().mockResolvedValue([]),
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
  if (useAuthStore.getState().isAuthenticated) localStorage.setItem('token','test-comic-session');
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

  it('手动生成把智赢七秒分镜原样交给视频接口', async () => {
    useAuthStore.setState({ isAuthenticated: true });
    vi.mocked(fetchVideoModels).mockResolvedValueOnce([{id:'sd-2.5-fullblood-line2',name:'智赢测试',description:'',available:true}]);
    const shot = {shotNumber:1,duration:7,shotSize:'中景',camera:'固定',action:'开门',dialogue:'',characters:[],imagePrompt:'门',videoPrompt:'推门'};
    vi.mocked(analysisApi.analyzeComicDramaScript).mockResolvedValueOnce({title:'旧怀表',logline:'',genre:'',visualStyle:'',estimatedDuration:7,characters:[],props:[],
      scenes:[{sceneNumber:1,title:'公寓',location:'门口',time:'夜',summary:'开门',assetPrompt:'公寓',shots:[shot]}]});
    vi.mocked(generateVideo).mockImplementationOnce((_params, emit) => {
      emit({type:'error',message:'测试结束'}); return new AbortController();
    });
    fireEvent.click(await mount('episode'));
    const next = await screen.findByRole('button',{name:'生成下一步'});
    for (const title of ['资产图','分镜图']) {
      const row = screen.getAllByText(title).map(label => label.parentElement?.parentElement)
        .find(item => item?.querySelector('[role="switch"]'));
      fireEvent.click(row!.querySelector('[role="switch"]')!);
    }
    fireEvent.click(next);
    await waitFor(() => expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({model:'sd-2.5-fullblood-line2',video_length:7}),expect.any(Function)));
  });
});
