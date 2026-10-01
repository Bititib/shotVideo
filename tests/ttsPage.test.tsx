// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('../client/src/api/analysis', () => ({ getCachedTtsModels: () => [], analysisApi: { getTtsModels: vi.fn(), generateTts: vi.fn(), getClonedVoices: vi.fn(), cloneVoice: vi.fn(), deleteClonedVoice: vi.fn() } }));
vi.mock('../client/src/api/content', () => ({ contentApi: { getMyContents: vi.fn().mockResolvedValue({ items: [], total: 0 }) } }));
vi.mock('../client/src/hooks/useAuthGuard', () => ({ useAuthGuard: () => () => true }));
import TtsPage from '../client/src/pages/analysis/TtsPage';
import { analysisApi } from '../client/src/api/analysis';

beforeEach(() => {
  vi.mocked(analysisApi.getClonedVoices).mockResolvedValue([]);
  vi.mocked(analysisApi.getTtsModels).mockResolvedValue([
    { modelId: 'gemini-3.8-flash-tts', displayName: 'Gemini 3.8', voices: ['NewVoice', 'SecondVoice'] },
    { modelId: 'old-tts', displayName: 'Older TTS', voices: ['Kore'] },
  ]);
  vi.mocked(analysisApi.generateTts).mockResolvedValue({ audioBase64: 'UklGRg==', mimeType: 'audio/wav' });
  vi.stubGlobal('Audio', class {
    addEventListener() {} pause() {} play() { return Promise.resolve(); }
  });
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:audio-test' });
});

it('uploads a reference, selects the persisted cloned voice and displays fallback warnings', async () => {
  const clone = { voiceId: 'voices/voice_123', displayName: '我的声音', type: 'cloned' as const, state: 'ACTIVE' };
  vi.mocked(analysisApi.cloneVoice).mockResolvedValue(clone);
  vi.mocked(analysisApi.getClonedVoices).mockResolvedValueOnce([]).mockResolvedValue([clone]);
  vi.mocked(analysisApi.generateTts).mockResolvedValue({ audioBase64: 'UklGRg==', mimeType: 'audio/wav', usedVoice: 'NewVoice', warning: '克隆音色已失效，已回退' });
  render(<TtsPage />);
  await screen.findByRole('button', { name: 'NewVoice' });
  const file = new File(['fixture'], 'reference.wav', { type: 'audio/wav' });
  fireEvent.change(screen.getByLabelText('克隆音色名称'), { target: { value: '我的声音' } });
  fireEvent.change(screen.getByLabelText('参考音频'), { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: '创建克隆音色' }));
  await screen.findByText('声音克隆成功，可以选择该音色生成配音。');
  expect(analysisApi.cloneVoice).toHaveBeenCalledWith(file, '我的声音');
  fireEvent.change(screen.getByLabelText('配音文案'), { target: { value: '你好' } });
  fireEvent.click(screen.getByRole('button', { name: '开始合成语音' }));
  await waitFor(() => expect(analysisApi.generateTts).toHaveBeenCalledWith('你好', 'voices/voice_123', 'gemini-3.8-flash-tts'));
  await screen.findByText('克隆音色已失效，已回退');
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it('submits an upstream-only voice and downloads the actual WAV format', async () => {
  render(<TtsPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'SecondVoice' }));
  fireEvent.change(screen.getByRole('textbox', { name: '配音文案' }), { target: { value: '你好' } });
  fireEvent.click(screen.getByRole('button', { name: '开始合成语音' }));
  await waitFor(() => expect(analysisApi.generateTts).toHaveBeenCalledWith('你好', 'SecondVoice', 'gemini-3.8-flash-tts'));
  expect((await screen.findByRole('link', { name: '下载音频' })).getAttribute('download')).toMatch(/\.wav$/);
});

it('replaces a voice that is not supported after switching models', async () => {
  render(<TtsPage />);
  await screen.findByRole('button', { name: 'NewVoice' });
  fireEvent.click(screen.getByRole('button', { name: /Older TTS/ }));
  expect(screen.queryByRole('button', { name: 'NewVoice' })).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: '配音文案' }), { target: { value: 'hello' } });
  fireEvent.click(screen.getByRole('button', { name: '开始合成语音' }));
  await waitFor(() => expect(analysisApi.generateTts).toHaveBeenCalledWith('hello', 'Kore', 'old-tts'));
});

it('does not invent models when the registered catalog is empty', async () => {
  vi.mocked(analysisApi.getTtsModels).mockResolvedValue([]);
  render(<TtsPage />);
  await screen.findByText('暂无可用语音模型，请联系管理员配置。');
  fireEvent.change(screen.getByRole('textbox', { name: '配音文案' }), { target: { value: 'hello' } });
  expect((screen.getByRole('button', { name: '开始合成语音' }) as HTMLButtonElement).disabled).toBe(true);
  expect(analysisApi.generateTts).not.toHaveBeenCalled();
});

it('does not offer undocumented voices when the upstream returns no voice catalog', async () => {
  vi.mocked(analysisApi.getTtsModels).mockResolvedValue([{modelId:'gemini-3.8-flash-tts', displayName:'Gemini 3.8', voices:[], voiceSource:'unavailable'}]);
  render(<TtsPage />);
  await screen.findByRole('button',{name:/Gemini 3.8/});
  expect(screen.getByText('上游尚未返回音色列表，暂时无法选择音色。')).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Sulafat'})).toBeNull();
  expect(screen.queryByRole('button',{name:'Zephyr'})).toBeNull();
  fireEvent.change(screen.getByLabelText('配音文案'),{target:{value:'你好'}});
  expect((screen.getByRole('button',{name:'开始合成语音'}) as HTMLButtonElement).disabled).toBe(true);
});
