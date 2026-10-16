// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ImageGenPage from '../client/src/pages/analysis/ImageGenPage';
import { contentApi } from '../client/src/api/content';
import { generateImage } from '../client/src/api/imageGen';

const polling = vi.hoisted(() => ({ run: undefined as undefined | (() => Promise<unknown>) }));
vi.mock('../client/src/utils/polling', () => ({ startPolling: (task: (signal: AbortSignal) => Promise<unknown>) => {
  polling.run = () => task(new AbortController().signal);
  void polling.run();
  return () => {};
} }));
vi.mock('../client/src/api/content', () => ({ contentApi: {
  getMyContents: vi.fn(), getById: vi.fn(), delete: vi.fn(), recoverImage: vi.fn(),
} }));
vi.mock('../client/src/api/imageGen', async original => ({ ...await original<any>(),
  getCachedImageModels: () => models, fetchImageModels: async () => models,
  generateImage: vi.fn(() => new AbortController()),
}));
vi.mock('../client/src/hooks/useAuthGuard', () => ({ useAuthGuard: () => () => true }));
vi.mock('../client/src/utils/imageNormalization', () => ({ MOBILE_IMAGE_ACCEPT: 'image/*',
  isSupportedImageFile: () => true, normalizeImageFile: async () => ({ dataUrl: 'data:image/png;base64,original' }),
}));

const models = [{ id: 'gpt-image-2', name: 'Pidoi', available: true, maxReferenceImages: 5 },
  { id: 'gpt-image-2-siyuetian', name: '四月天', available: true, maxReferenceImages: 9 }];
const failed = { id: 11979, status: 'failed', inputText: '原图描述', modelId: 'gpt-image-2',
  createdAt: '2026-10-15', metadata: JSON.stringify({ aspectRatio: '16:9', count: 2, resolution: '4K' }) };
beforeEach(() => {
  vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [failed], total: 1 });
  vi.mocked(contentApi.getById).mockResolvedValue(failed);
  vi.mocked(contentApi.delete).mockResolvedValue({});
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('图片记录操作', () => {
  it('shows failed actions, restores the original channel and settings, and submits only after confirmation in the composer', async () => {
    render(<ImageGenPage />);
    fireEvent.change(screen.getByRole('combobox', { name: '生成模型' }), { target: { value: 'gpt-image-2-siyuetian' } });
    fireEvent.click(await screen.findByRole('button', { name: '重新生成' }));
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('原图描述'));
    expect((screen.getByRole('combobox', { name: '生成模型' }) as HTMLSelectElement).value).toBe('gpt-image-2');
    expect((screen.getByRole('combobox', { name: '画面比例' }) as HTMLSelectElement).value).toBe('16:9');
    expect(screen.getByText(/历史记录未保存参考图/)).toBeTruthy();
    expect(generateImage).not.toHaveBeenCalled();
    expect(screen.queryByText(/批进行中/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '开始生成图片' }));
    expect(vi.mocked(generateImage).mock.calls[0][0]).toMatchObject({ prompt: '原图描述', model: 'gpt-image-2', aspect_ratio: '16:9', n: 2, resolution: '4K' });
  });

  it('removes deleted failures immediately and ignores an older list response', async () => {
    render(<ImageGenPage />);
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));
    await waitFor(() => expect(screen.queryByText(/任务 #11979/)).toBeNull());
    expect(contentApi.delete).toHaveBeenCalledWith(11979);
    await act(async () => { await polling.run!(); });
    expect(screen.queryByText(/任务 #11979/)).toBeNull();
    expect(contentApi.getById).not.toHaveBeenCalled();
  });

  it('preserves the card if deletion is cancelled or rejected', async () => {
    render(<ImageGenPage />);
    const button = await screen.findByRole('button', { name: '删除' });
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(button);
    expect(contentApi.delete).not.toHaveBeenCalled();
    vi.mocked(contentApi.delete).mockRejectedValueOnce(new Error('删除请求失败'));
    fireEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toContain('删除请求失败');
    expect(screen.getByText(/任务 #11979/)).toBeTruthy();
  });

  it('stops polling failed tasks outside the first history page', async () => {
    render(<ImageGenPage />);
    await screen.findByText(/任务 #11979/);
    vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [], total: 0 });
    await act(async () => { await polling.run!(); });
    expect(contentApi.getById).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '重新生成' })).toBeTruthy();
  });

  it('keeps original references for a live failed request instead of silently changing it into text-to-image', async () => {
    vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [], total: 0 });
    render(<ImageGenPage />);
    fireEvent.click(screen.getByRole('button', { name: '图生图 / 改图' }));
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(['x'], 'ref.png', { type: 'image/png' })] } });
    await screen.findByRole('img', { name: '参考图 1' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '修改原图' } });
    fireEvent.click(screen.getByRole('button', { name: '开始改图' }));
    await act(async () => { vi.mocked(generateImage).mock.calls[0][1]({ type: 'error', message: '提交失败' }); });
    fireEvent.click(screen.getByRole('button', { name: '文生图', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: '重新生成' }));
    await screen.findByRole('textbox', { name: '修改要求' });
    expect(screen.getByRole('img', { name: '参考图 1' })).toBeTruthy();
    expect(generateImage).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '开始改图' }));
    expect(vi.mocked(generateImage).mock.calls[1][0].reference_images).toEqual(['data:image/png;base64,original']);
  });

  it('does not offer deletion or duplicate submission on unsettled tasks', async () => {
    vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [{ ...failed, status: 'review' }], total: 1 });
    render(<ImageGenPage />);
    await screen.findByText(/任务 #11979/);
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重新生成' })).toBeNull();
    expect(screen.queryByText(/批进行中/)).toBeNull();
  });

  it('exposes actions on new results and deletes all images belonging to the same saved record', async () => {
    vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [], total: 0 });
    render(<ImageGenPage />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '两只猫' } });
    fireEvent.click(screen.getByRole('button', { name: '开始生成图片' }));
    await act(async () => { vi.mocked(generateImage).mock.calls[0][1]({ type: 'complete', contentId: 20000,
      imageUrls: ['/api/uploads/cat1.png', '/api/uploads/cat2.png'] }); });
    expect(screen.getAllByRole('button', { name: '重新生成' })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0]);
    await waitFor(() => expect(screen.queryByRole('img', { name: /生成图片/ })).toBeNull());
    expect(contentApi.delete).toHaveBeenCalledWith(20000);
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
  });
});
