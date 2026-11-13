// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
const mocks = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock('../client/src/api/client', () => ({ api: mocks }));
vi.mock('../client/src/stores/authStore', () => ({ useAuthStore: (selector: any) => selector({ user: { id: 7 } }) }));
vi.mock('../client/src/hooks/useAuthGuard', () => ({ useAuthGuard: () => () => true }));
vi.mock('../client/src/components/ModelSelector', () => ({ default: ({onChange}: any) => <button onClick={() => onChange('gemini-2.5-flash')}>选模型</button> }));
vi.mock('../client/src/utils/imageNormalization', () => ({ MOBILE_IMAGE_ACCEPT: 'image/*', isSupportedImageFile: () => true,
  normalizeImageFile: async (file: File) => ({ file, blob: file }) }));
import ImagePage from '../client/src/pages/analysis/ImagePage';
const gallery = { images: ['https://example.com/1.jpg', 'https://example.com/2.jpg'], audioTitle: '原声', audioUrl: 'https://example.com/a.mp3' };
const result = (n: number) => ({ overallConcept: '画面' + n, reversePrompt: 'Prompt ' + n, reversePromptTranslation: '提示词' + n, aspectRatio: '1:1', keywords: [], styleTags: [] });
const completed = { id: 'test-job-123456789', items: [0,1].map(index => ({index, status:'completed', result:result(index+1),error:null})) };
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  URL.createObjectURL = vi.fn(() => 'blob:preview'); URL.revokeObjectURL = vi.fn();
  mocks.post.mockImplementation(async (url: string, body: any) => url === '/analysis/image-jobs' ? completed : body.mode === 'list' ? gallery : new Blob([body.url], { type: 'image/jpeg' }));
  mocks.get.mockImplementation(async (url: string) => url.includes('/images/') ? new Blob(['image'], {type:'image/jpeg'}) : completed);
});
afterEach(cleanup);
async function importLink() {
  render(<ImagePage />);
  fireEvent.click(screen.getByText('选模型'));
  fireEvent.change(screen.getByPlaceholderText('粘贴 TikTok 图文链接或图片直链'), { target: { value: 'https://www.tiktok.com/@user/photo/1' } });
  fireEvent.click(screen.getByRole('button', { name: '导入' }));
  await screen.findByRole('button', { name: '查看第 2 张结果' });
}
it('submits every imported image once and switches independent results without additional submissions', async () => {
  await importLink();
  expect(mocks.post).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', {name:'开始逆向'}));
  await screen.findByText('画面1');
  const submitted = mocks.post.mock.calls.filter(call => call[0] === '/analysis/image-jobs');
  expect(submitted).toHaveLength(1);
  expect(submitted[0][1].getAll('files')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', {name:'查看第 2 张结果'}));
  expect(screen.getByText('画面2')).toBeInTheDocument();
  expect(screen.getByText('Prompt 2')).toBeInTheDocument();
  expect(screen.queryByText('画面1')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name:'查看第 1 张结果'}));
  expect(screen.getByText('画面1')).toBeInTheDocument();
  expect(mocks.post.mock.calls.filter(call => call[0] === '/analysis/image-jobs')).toHaveLength(1);
});
it('keeps successful results visible when another image fails', async () => {
  const mixed = {...completed, items:[completed.items[0], {...completed.items[1],status:'error',result:null,error:'图片格式不支持'}]};
  mocks.get.mockResolvedValue(mixed);
  await importLink();
  fireEvent.click(screen.getByRole('button', {name:'开始逆向'}));
  await screen.findByText('画面1');
  fireEvent.click(screen.getByRole('button', {name:'查看第 2 张结果'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('图片格式不支持');
  fireEvent.click(screen.getByRole('button', {name:'查看第 1 张结果'}));
  expect(screen.getByText('画面1')).toBeInTheDocument();
});
it('restores stored jobs by querying, without calling analysis again', async () => {
  localStorage.setItem('image-analysis-job:7',completed.id);
  render(<ImagePage />);
  await screen.findByText('画面1');
  await screen.findByRole('button', {name:'查看第 2 张结果'});
  fireEvent.click(screen.getByRole('button', {name:'查看第 2 张结果'}));
  expect(screen.getByText('画面2')).toBeInTheDocument();
  expect(mocks.post).not.toHaveBeenCalled();
});
it('allows viewing a completed image while another image is still running', async () => {
  const working = {...completed, items:[completed.items[0], {...completed.items[1],status:'running',result:null}]};
  mocks.get.mockResolvedValue(working);
  await importLink();
  fireEvent.click(screen.getByRole('button', {name:'开始逆向'}));
  await screen.findByText('画面1');
  await waitFor(() => expect(screen.getByRole('button', {name:'AI 分析中...'})).toBeDisabled());
  fireEvent.click(screen.getByRole('button', {name:'查看第 2 张结果'}));
  expect(screen.queryByText('画面1')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name:'查看第 1 张结果'}));
  expect(screen.getByText('画面1')).toBeInTheDocument();
  expect(mocks.post.mock.calls.filter(call => call[0] === '/analysis/image-jobs')).toHaveLength(1);
});
it('queries the original request after a lost submission response instead of resubmitting', async () => {
  await importLink();
  mocks.post.mockImplementation(async (url: string) => { if (url === '/analysis/image-jobs') throw new Error('connection lost'); return new Blob(['image'],{type:'image/jpeg'}); });
  fireEvent.click(screen.getByRole('button', {name:'开始逆向'}));
  await screen.findByText('画面1');
  expect(mocks.get).toHaveBeenCalled();
  expect(mocks.post.mock.calls.filter(call => call[0] === '/analysis/image-jobs')).toHaveLength(1);
});
it('does not submit any analysis if preparing an input fails', async () => {
  await importLink(); mocks.post.mockRejectedValueOnce(new Error('图片下载失败'));
  fireEvent.click(screen.getByRole('button', {name:'开始逆向'}));
  await waitFor(() => expect(screen.getByRole('button', {name:'开始逆向'})).toBeEnabled());
  expect(mocks.post.mock.calls.filter(call => call[0] === '/analysis/image-jobs')).toHaveLength(0);
});
it('ignores late import responses after reset', async () => {
  let done!: (value: any) => void;
  mocks.post.mockImplementationOnce(() => new Promise(resolve => {done = resolve;}));
  render(<ImagePage />);
  fireEvent.change(screen.getByPlaceholderText('粘贴 TikTok 图文链接或图片直链'), {target:{value:gallery.images[0]}});
  fireEvent.click(screen.getByRole('button', {name:'导入'}));
  fireEvent.click(screen.getByRole('button', {name:'重置'}));
  await act(async () => done(gallery));
  expect(screen.queryByRole('button', {name:'查看第 2 张结果'})).not.toBeInTheDocument();
});
