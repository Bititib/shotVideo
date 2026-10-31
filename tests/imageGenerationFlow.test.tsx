// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import ImageGenPage from '../client/src/pages/analysis/ImageGenPage';
import { fetchImageModels, generatedImageReference, generateImage, getCachedImageModels } from '../client/src/api/imageGen';
import { contentApi } from '../client/src/api/content';
import { MJ_MODEL_ID, mjLimits } from '../shared/mj';
import { APIPATH_MODELS } from '../shared/apipathModels';

vi.mock('../client/src/api/imageGen', async original => ({
  ...await original<any>(), fetchImageModels: vi.fn(), getCachedImageModels: vi.fn(),
  generatedImageReference: vi.fn(), generateImage: vi.fn(() => new AbortController()),
}));
vi.mock('../client/src/api/content', () => ({ contentApi: { getMyContents: vi.fn() } }));
vi.mock('../client/src/hooks/useAuthGuard', () => ({ useAuthGuard: () => () => true }));
vi.mock('../client/src/utils/imageNormalization', () => ({
  MOBILE_IMAGE_ACCEPT: 'image/*', isSupportedImageFile: (file: File) => file.type.startsWith('image/'),
  normalizeImageFile: async (file: File) => ({ dataUrl: 'data:image/jpeg;base64,' + file.name }),
}));

const models = [
  { id: 'gpt-image-2', name: 'GPT Image 2', description: '', available: true, maxReferenceImages: 5 },
  { id: 'nano-banana-2-lite', name: 'Banana Lite', description: '', available: true, maxReferenceImages: 0 },
  { id: 'gpt-image-2-siyuetian', name: 'GPT 四月天', description: '', available: true, maxReferenceImages: 9 },
];
beforeEach(() => {
  vi.mocked(getCachedImageModels).mockReturnValue(models);
  vi.mocked(fetchImageModels).mockResolvedValue(models);
  vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [], total: 0 } as any);
  vi.mocked(generatedImageReference).mockResolvedValue('data:image/png;base64,original');
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function upload(count = 1) {
  fireEvent.click(screen.getByRole('button', { name: '图生图 / 改图' }));
  fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: Array.from({ length: count }, (_, i) => new File(['image'], `ref${i}.jpg`, { type: 'image/jpeg' })) } });
  await screen.findByRole('img', { name: '参考图 1' });
}
function history() {
  vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [{ id: 1, resultUrl: '/api/uploads/result.png?token=signed', inputText: '旧提示词', status: 'completed', createdAt: '2026-10-13' }], total: 1 } as any);
}

describe('图片生成与继续改图', () => {
  it.each([['1K', 1], ['2K', 2], ['4K', 4]] as const)('selects Sunburst %s inside one entry and submits its matching price tier', async (resolution, price) => {
    const spec = APIPATH_MODELS.find(m => m.id === 'gpt-image-2-5-sunburst')!;
    const catalog = [{ id: spec.id, name: spec.name, description: spec.description!, available: true,
      rate: 1, resolutionPrices: { '1K': 1, '2K': 2, '4K': 4 }, maxReferenceImages: 4, routingLimits: spec.limits }];
    vi.mocked(getCachedImageModels).mockReturnValue(catalog);
    vi.mocked(fetchImageModels).mockResolvedValue(catalog);
    render(<ImageGenPage />);
    const control = screen.getByRole('combobox', { name: '输出分辨率' }) as HTMLSelectElement;
    expect(Array.from(control.options, option => option.value)).toEqual(['1K', '2K', '4K']);
    fireEvent.change(control, { target: { value: resolution } });
    expect(screen.getByTitle('预计费用').textContent).toBe('¥' + price.toFixed(2));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'sunset' } });
    fireEvent.click(screen.getByRole('button', { name: '开始生成图片' }));
    expect(vi.mocked(generateImage).mock.calls[0][0]).toMatchObject({ model: spec.id, resolution, n: 1 });
  });
  it('displays MJ task progress on all pending images without requiring an image index', async () => {
    const mj = [{ id: MJ_MODEL_ID, name: 'MJ', description: '', available: true, routingLimits: mjLimits() }];
    vi.mocked(getCachedImageModels).mockReturnValue(mj);
    vi.mocked(fetchImageModels).mockResolvedValue(mj);
    render(<ImageGenPage />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a paper boat' } });
    fireEvent.click(screen.getByRole('button', { name: '开始生成图片' }));
    const emit = vi.mocked(generateImage).mock.calls[0][1];
    await act(async () => { emit({ type: 'progress', progress: 42 }); });
    expect(screen.getAllByText('42%')).toHaveLength(4);
    await act(async () => {
      emit({ type: 'image_ready', index: 0, imageUrl: '/api/uploads/first.png' });
      emit({ type: 'progress', progress: 70 });
    });
    expect(screen.getAllByText('70%')).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: /^预览.*图片/ })).toHaveLength(1);
    await act(async () => { emit({ type: 'progress', index: 1, progress: 85 }); });
    expect(screen.getAllByText('85%')).toHaveLength(1);
    expect(screen.getAllByText('70%')).toHaveLength(2);
  });
  it('restores the persisted task progress after a page refresh', async () => {
    vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [{ id: 13439, status: 'processing',
      modelId: MJ_MODEL_ID, createdAt: new Date().toISOString(), metadata: JSON.stringify({ count: 4, progress: 57 }) }], total: 1 } as any);
    render(<ImageGenPage />);
    expect(await screen.findAllByText('57%')).toHaveLength(4);
    expect(generateImage).not.toHaveBeenCalled();
  });
  it('shows generation status without inventing a percentage when none was supplied', async () => {
    vi.mocked(contentApi.getMyContents).mockResolvedValue({ items: [{ id: 13439, status: 'processing',
      modelId: MJ_MODEL_ID, createdAt: new Date().toISOString(), metadata: JSON.stringify({ count: 4 }) }], total: 1 } as any);
    render(<ImageGenPage />);
    await screen.findByRole('status', { name: /^图片 1 (生成中|排队中)$/ });
    expect(screen.queryByText(/^\d+%$/)).toBeNull();
    expect(generateImage).not.toHaveBeenCalled();
  });
  it('offers every managed MJ ratio and submits its fixed resolution without quality', async () => {
    const mj = [{ id: MJ_MODEL_ID, name: 'MJ', description: '', available: true, maxReferenceImages: 6, routingLimits: mjLimits() }];
    vi.mocked(getCachedImageModels).mockReturnValue(mj);
    vi.mocked(fetchImageModels).mockResolvedValue(mj);
    render(<ImageGenPage />);
    const ratio = screen.getByRole('combobox', { name: '画面比例' }) as HTMLSelectElement;
    expect(Array.from(ratio.options, option => option.value)).toEqual(mjLimits().ratios);
    fireEvent.change(ratio, { target: { value: '1:8' } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a tall tree' } });
    fireEvent.click(screen.getByRole('button', { name: '开始生成图片' }));
    expect(screen.getByText('按实际结果 · 按次计费')).toBeTruthy();
    expect(vi.mocked(generateImage).mock.calls[0][0]).toMatchObject({ model: MJ_MODEL_ID, resolution: '1K', aspect_ratio: '1:8', n: 4 });
    expect(vi.mocked(generateImage).mock.calls[0][0].quality).toBeUndefined();
  });
  it('requires an original image before editing', async () => {
    render(<ImageGenPage />);
    fireEvent.click(screen.getByRole('button', { name: '图生图 / 改图' }));
    fireEvent.change(screen.getByRole('textbox', { name: '修改要求' }), { target: { value: '换成海边背景' } });
    expect((screen.getByRole('button', { name: '开始改图' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect((await screen.findByRole('alert')).textContent).toContain('请先上传需要修改的原图');
    expect(generateImage).not.toHaveBeenCalled();
  });

  it('submits all five references and omits retained references in text mode', async () => {
    render(<ImageGenPage />);
    await upload(5);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '保留主体，修改背景' } });
    fireEvent.click(screen.getByRole('button', { name: '开始改图' }));
    expect(vi.mocked(generateImage).mock.calls[0][0].reference_images).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: '文生图', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: '开始生成图片' }));
    expect(vi.mocked(generateImage).mock.calls[1][0].reference_images).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: '图生图 / 改图' }));
    expect(screen.getAllByRole('img', { name: /参考图/ })).toHaveLength(5);
  });

  it('blocks text-only models without discarding uploaded references', async () => {
    render(<ImageGenPage />);
    await upload();
    fireEvent.change(screen.getByRole('combobox', { name: '生成模型' }), { target: { value: 'nano-banana-2-lite' } });
    expect(screen.getByText(/当前模型仅支持文生图/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /上传原图/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '换背景' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(generateImage).not.toHaveBeenCalled();
    expect(screen.getByRole('img', { name: '参考图 1' })).toBeTruthy();
  });

  it('requires removal of excess references after switching models', async () => {
    render(<ImageGenPage />);
    fireEvent.change(screen.getByRole('combobox', { name: '生成模型' }), { target: { value: 'gpt-image-2-siyuetian' } });
    await upload(6);
    fireEvent.change(screen.getByRole('combobox', { name: '生成模型' }), { target: { value: 'gpt-image-2' } });
    expect(screen.getByText('当前模型最多支持 5 张参考图，请移除多余图片。')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '换背景' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(generateImage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '移除参考图 6' }));
    fireEvent.click(screen.getByRole('button', { name: '开始改图' }));
    expect(vi.mocked(generateImage).mock.calls[0][0].reference_images).toHaveLength(5);
  });

  it('reuses history with a capable model and waits for modification instructions', async () => {
    history(); render(<ImageGenPage />);
    fireEvent.change(screen.getByRole('combobox', { name: '生成模型' }), { target: { value: 'nano-banana-2-lite' } });
    fireEvent.click(await screen.findByRole('button', { name: '继续改图' }));
    await screen.findByRole('textbox', { name: '修改要求' });
    expect(generatedImageReference).toHaveBeenCalledWith('/api/uploads/result.png?token=signed');
    expect((screen.getByRole('img', { name: '参考图 1' }) as HTMLImageElement).src).toBe('data:image/png;base64,original');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    expect(generateImage).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '把背景改成海边' } });
    fireEvent.click(screen.getByRole('button', { name: '开始改图' }));
    expect(vi.mocked(generateImage).mock.calls[0][0]).toMatchObject({ model: 'gpt-image-2', reference_images: ['data:image/png;base64,original'], prompt: '把背景改成海边' });
  });

  it('preserves the current inputs if loading the original fails', async () => {
    history(); vi.mocked(generatedImageReference).mockRejectedValueOnce(new Error('原图已过期'));
    render(<ImageGenPage />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '保留这段描述' } });
    fireEvent.click(await screen.findByRole('button', { name: '继续改图' }));
    expect((await screen.findByRole('alert')).textContent).toContain('原图已过期');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('保留这段描述');
    expect(generateImage).not.toHaveBeenCalled();
  });

  it('reuses a newly generated result without automatically submitting another job', async () => {
    render(<ImageGenPage />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '一只猫' } });
    fireEvent.click(screen.getByRole('button', { name: '开始生成图片' }));
    await act(async () => { vi.mocked(generateImage).mock.calls[0][1]({ type: 'complete', imageUrls: ['/api/uploads/new.png'] }); });
    fireEvent.click(screen.getByRole('button', { name: '继续改图' }));
    await screen.findByRole('textbox', { name: '修改要求' });
    expect(generatedImageReference).toHaveBeenCalledWith('/api/uploads/new.png');
    expect(generateImage).toHaveBeenCalledTimes(1);
  });
});


it('refreshes a cooled-down MJ model without submitting a generation or losing the draft', async () => {
  vi.useFakeTimers();
  try {
    const mj = { id:MJ_MODEL_ID, name:'MJ', description:'', available:false, unavailableReason:'credits' as const, retryAt:Date.now() + 60_000, routingLimits:mjLimits() };
    vi.mocked(getCachedImageModels).mockReturnValue([mj]);
    vi.mocked(fetchImageModels).mockResolvedValue([mj]);
    render(<ImageGenPage />);
    await act(async () => {});
    fireEvent.change(screen.getByRole('textbox'), { target:{ value:'保留我的提示词' } });
    expect(screen.getByText(/上游积分不足，已暂停生成/)).toBeTruthy();
    expect((screen.getByRole('button', { name:'开始生成图片' }) as HTMLButtonElement).disabled).toBe(true);
    vi.mocked(fetchImageModels).mockResolvedValue([{ ...mj, available:true, unavailableReason:undefined, retryAt:undefined }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_100); });
    expect((screen.getByRole('button', { name:'开始生成图片' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('保留我的提示词');
    expect(fetchImageModels).toHaveBeenCalledWith(true);
    expect(generateImage).not.toHaveBeenCalled();
  } finally { cleanup(); vi.useRealTimers(); }
});
