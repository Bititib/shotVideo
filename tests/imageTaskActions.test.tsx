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
    fireEvent.click((await screen.findAllByRole('button', { name: '重新生成' }))[0]);
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
    fireEvent.click((await screen.findAllByRole('button', { name: '删除' }))[0]);
    await waitFor(() => expect(screen.queryByText(/任务 #11979/)).toBeNull());
    expect(contentApi.delete).toHaveBeenCalledWith(11979);
    await act(async () => { await polling.run!(); });
    expect(screen.queryByText(/任务 #11979/)).toBeNull();
    expect(contentApi.getById).not.toHaveBeenCalled();
  });

  it('preserves the card if deletion is cancelled or rejected', async () => {
    render(<ImageGenPage />);
    const button = (await screen.findAllByRole('button', { name: '删除' }))[0];
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(button);
    expect(contentApi.delete).not.toHaveBeenCalled();
    vi.mocked(contentApi.delete).mockRejectedValueOnce(new Error('删除请求失败'));
    fireEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toContain('删除请求失败');
    expect(screen.getAllByText(/任务 #11979/)[0]).toBeTruthy();
  });

  it('stops polling failed tasks outside the first history page', async () => {
    render(<ImageGenPage />);
    await screen.findAllByText(/任务 #11979/);
    vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [], total: 0 });
    await act(async () => { await polling.run!(); });
    expect(contentApi.getById).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: '重新生成' })[0]).toBeTruthy();
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
    fireEvent.click(screen.getAllByRole('button', { name: '重新生成' })[0]);
    await screen.findByRole('textbox', { name: '修改要求' });
    expect(screen.getByRole('img', { name: '参考图 1' })).toBeTruthy();
    expect(generateImage).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '开始改图' }));
    expect(vi.mocked(generateImage).mock.calls[1][0].reference_images).toEqual(['data:image/png;base64,original']);
  });

  it('does not offer deletion or duplicate submission on unsettled tasks', async () => {
    vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [{ ...failed, status: 'review' }], total: 1 });
    render(<ImageGenPage />);
    await screen.findAllByText(/任务 #11979/);
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
    await waitFor(() => expect(screen.queryAllByRole('article')).toHaveLength(0));
    expect(contentApi.delete).toHaveBeenCalledWith(20000);
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
  });
});
describe('统一图片网格', () => {
  const cards = () => screen.getAllByRole('article');
  const ids = () => cards().map(card => card.getAttribute('data-task-id'));
  const record = (id: number, status: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
    id, status, createdAt, inputText: '任务描述 ' + id, modelId: 'gpt-image-2',
    metadata: { count: 1, aspectRatio: '16:9', progresses: [60] }, ...extra,
  });

  it('mixes every status in submission order and keeps the same card when polling completes', async () => {
    const createdAt = new Date().toISOString();
    const processing = record(102, 'processing', createdAt);
    const newest = record(103, 'failed', createdAt);
    const complete = record(101, 'completed', createdAt, { resultUrl: '/api/uploads/one.png' });
    vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [complete, newest, processing], total: 3 });
    render(<ImageGenPage />);
    await screen.findByText('任务 #102');
    expect(ids()).toEqual(['103', '102', '101']);
    expect(document.querySelectorAll('.ig-artwork-grid')).toHaveLength(1);
    const before = cards()[1];
    vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [complete,
      { ...processing, status: 'completed', resultUrl: '/api/uploads/two.png' }, newest], total: 3 });
    await act(async () => { await polling.run!(); });
    expect(ids()).toEqual(['103', '102', '101']);
    expect(cards()[1]).toBe(before);
    expect(cards()[1].getAttribute('data-status')).toBe('completed');
    fireEvent.click(screen.getByRole('button', { name: /^失败/ }));
    expect(ids()).toEqual(['103']);
    fireEvent.click(screen.getByRole('button', { name: /^成功/ }));
    expect(ids()).toEqual(['102', '101']);
    fireEvent.click(screen.getByRole('button', { name: /^生成中/ }));
    expect(screen.queryAllByRole('article')).toHaveLength(0);
    expect(screen.getByText('已加载记录中暂无此状态的图片')).toBeTruthy();
  });

  it('keeps multi-image slots and task identity stable through completion', async () => {
    const batch = record(201, 'processing', new Date().toISOString(), {
      metadata: { count: 2, imageUrls: ['', '/api/uploads/second.png'], progresses: [50, 100] },
    });
    vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [batch], total: 1 });
    render(<ImageGenPage />);
    await screen.findByText('第 2 / 2 张');
    const before = cards();
    expect(before.map(card => card.getAttribute('data-status'))).toEqual(['processing', 'completed']);
    vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [{
      ...batch, status: 'completed', resultUrl: '/api/uploads/first.png',
      metadata: { count: 2, imageUrls: ['/api/uploads/first.png', '/api/uploads/second.png'] },
    }], total: 1 });
    await act(async () => { await polling.run!(); });
    expect(cards()).toHaveLength(2);
    expect(cards()[0]).toBe(before[0]);
    expect(cards()[1]).toBe(before[1]);
    expect(cards().map(card => card.querySelector('img')?.getAttribute('src'))).toEqual(['/api/uploads/first.png', '/api/uploads/second.png']);
  });

  it('keeps a live result at its submission position even when another task finishes first', async () => {
    vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [], total: 0 });
    render(<ImageGenPage />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '先提交' } });
    fireEvent.click(screen.getByRole('button', { name: '开始生成图片' }));
    await act(async () => { vi.mocked(generateImage).mock.calls[0][1]({ type: 'status', contentId: 301 }); });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '后提交' } });
    fireEvent.click(screen.getByRole('button', { name: '开始生成图片' }));
    await act(async () => { vi.mocked(generateImage).mock.calls[1][1]({ type: 'status', contentId: 302 }); });
    const before = cards();
    expect(ids()).toEqual(['302', '301']);
    await act(async () => { vi.mocked(generateImage).mock.calls[0][1]({
      type: 'complete', imageUrls: ['/api/uploads/first.png'],
    }); });
    expect(ids()).toEqual(['302', '301']);
    expect(cards()[1]).toBe(before[1]);
    await act(async () => { vi.mocked(generateImage).mock.calls[1][1]({
      type: 'complete', contentId: 302, imageUrls: ['/api/uploads/second.png'],
    }); });
    expect(ids()).toEqual(['302', '301']);
    expect(cards()[0]).toBe(before[0]);
  });

  it('loads failures and review records on later pages without duplicating existing cards', async () => {
    const first = record(401, 'completed', '2026-10-16T08:00:00Z', { resultUrl: '/api/uploads/first.png' });
    vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [first], total: 21 });
    render(<ImageGenPage />);
    await screen.findByText('任务 #401');
    fireEvent.click(screen.getByRole('button', { name: /^失败/ }));
    vi.mocked(contentApi.getMyContents).mockResolvedValueOnce({ items: [
      first, record(400, 'failed', '2026-10-16T07:00:00Z'), record(399, 'review', '2026-10-16T06:00:00Z'),
    ], total: 21 });
    fireEvent.click(screen.getByRole('button', { name: '加载更多记录' }));
    await screen.findByText('任务 #400');
    expect(ids()).toEqual(['400']);
    expect(contentApi.getMyContents).toHaveBeenLastCalledWith({ type: 'image', page: 2, pageSize: 20 });
    fireEvent.click(screen.getByRole('button', { name: /^全部/ }));
    expect(ids()).toEqual(['401', '400', '399']);
  });

  it('keeps a failed preview marked for recovery across polling until a new URL arrives', async () => {
    const done = record(501, 'completed', '2026-10-16 08:00:00', { resultUrl: '/api/uploads/broken.png' });
    vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [done], total: 1 });
    render(<ImageGenPage />);
    const image = await screen.findByRole('img', { name: '历史图片' });
    expect(document.querySelector('time')?.dateTime).toBe('2026-10-16T08:00:00.000Z');
    fireEvent.error(image);
    await act(async () => { await polling.run!(); });
    expect(screen.getByText('原文件暂时无法读取')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新获取' })).toBeTruthy();
    vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [{ ...done, resultUrl: '/api/uploads/recovered.png' }], total: 1 });
    await act(async () => { await polling.run!(); });
    expect(screen.queryByText('原文件暂时无法读取')).toBeNull();
    expect(screen.getByRole('img').getAttribute('src')).toBe('/api/uploads/recovered.png');
  });
});
