// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CopywritingPage from '../client/src/pages/analysis/CopywritingPage';
import { analysisApi } from '../client/src/api/analysis';
import { contentApi } from '../client/src/api/content';
import { defaultCopywritingOptions } from '../shared/copywriting';

vi.mock('../client/src/api/analysis', () => ({ analysisApi: { analyzeCopywriting: vi.fn(), generateImage: vi.fn() } }));
vi.mock('../client/src/api/content', () => ({ contentApi: { getById: vi.fn(), update: vi.fn() } }));
vi.mock('../client/src/hooks/useAuthGuard', () => ({ useAuthGuard: () => () => true }));
vi.mock('../client/src/components/ModelSelector', () => ({ default: ({ value, onChange }: any) => <select aria-label="分析模型" value={value} onChange={event => onChange(event.target.value)}><option value="">默认模型</option><option value="gemini-selected">选定模型</option></select> }));
vi.mock('../client/src/utils/imageNormalization', () => ({ MOBILE_IMAGE_ACCEPT: 'image/*', isSupportedImageFile: (file: File) => file.type.startsWith('image/'), normalizeImageFile: async (file: File) => ({ file, blob: file }) }));

const detail = () => ({ title: '通勤随行杯', subtitle: '日常出发，从容随行', sections: Array.from({ length: 3 }, (_, i) => ({ heading: '分屏 ' + (i + 1), body: '清晰的产品介绍', bullets: ['外观简洁'] })), specifications: [{ name: '颜色', value: '绿色' }], faqs: [], factsToConfirm: ['容量待确认'] });
const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
let exportedName = '';
beforeEach(() => {
  vi.clearAllMocks(); exportedName = '';
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:copywriting-test') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { exportedName = this.download; });
  vi.mocked(analysisApi.analyzeCopywriting).mockImplementation(async (_files, _model, options) => options?.mode === 'marketing'
    ? { contentId: 11, tiktok: { hook: 'Marketing hook', caption: 'Caption', hashtags: ['#product'] }, amazon: { title: 'Amazon 标题', bulletPoints: ['卖点'], productDescription: '商品描述' }, detailPageImages: [] }
    : { contentId: 10, detailPage: detail() });
  vi.mocked(contentApi.update).mockResolvedValue({ id: 10 });
  vi.mocked(contentApi.getById).mockResolvedValue({ id: 10, type: 'copywriting', resultText: JSON.stringify({ detailPage: detail() }), metadata: JSON.stringify({ copywritingOptions: { ...defaultCopywritingOptions, mode: 'detail', platform: 'amazon', language: 'en' } }) });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const mount = (url = '/app/copywriting') => render(<MemoryRouter initialEntries={[url]}><CopywritingPage /></MemoryRouter>);
const upload = async (count = 1) => {
  fireEvent.change(screen.getByLabelText('上传产品素材'), { target: { files: Array.from({ length: count }, (_, i) => new File(['image'], 'product-' + i + '.png', { type: 'image/png' })) } });
  await waitFor(() => expect(screen.getByRole('button', { name: '生成文案' })).toBeTruthy());
};

describe('copywriting detail mode in the existing page', () => {
  it('sends product images, target platform, language, audience and verified facts to the existing API', async () => {
    mount(); await upload(2);
    fireEvent.change(screen.getByLabelText('目标平台'), { target: { value: 'amazon' } });
    fireEvent.change(screen.getByLabelText('文案语言'), { target: { value: 'en' } });
    fireEvent.click(screen.getByText('补充产品信息（选填）'));
    fireEvent.change(screen.getByLabelText('产品名称'), { target: { value: '随行杯' } });
    fireEvent.change(screen.getByLabelText('目标人群'), { target: { value: '通勤人群' } });
    fireEvent.change(screen.getByLabelText('已核实的产品信息'), { target: { value: '颜色绿色' } });
    expect((screen.getByRole('button', { name: '生成文案' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('以上产品信息已核实'));
    fireEvent.change(screen.getByLabelText('分析模型'), { target: { value: 'gemini-selected' } });
    fireEvent.click(screen.getByRole('button', { name: '生成文案' }));
    expect(await screen.findByRole('heading', { name: '通勤随行杯' })).toBeTruthy();
    expect(analysisApi.analyzeCopywriting).toHaveBeenCalledWith(expect.arrayContaining([expect.any(File), expect.any(File)]), 'gemini-selected', expect.objectContaining({ mode: 'detail', platform: 'amazon', language: 'en', productName: '随行杯', audience: '通勤人群', productFacts: '颜色绿色', factsConfirmed: true }));
    expect(screen.getByText('容量待确认')).toBeTruthy();
  });

  it('invalidates factual confirmation when the source information changes', async () => {
    mount(); await upload();
    fireEvent.click(screen.getByText('补充产品信息（选填）'));
    fireEvent.change(screen.getByLabelText('已核实的产品信息'), { target: { value: '颜色绿色' } });
    fireEvent.click(screen.getByLabelText('以上产品信息已核实'));
    fireEvent.change(screen.getByLabelText('已核实的产品信息'), { target: { value: '颜色白色' } });
    expect((screen.getByLabelText('以上产品信息已核实') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('button', { name: '生成文案' }) as HTMLButtonElement).disabled).toBe(true);
    expect(analysisApi.analyzeCopywriting).not.toHaveBeenCalled();
  });

  it('edits, saves, copies and exports the current document without another generation', async () => {
    mount(); await upload(); fireEvent.click(screen.getByRole('button', { name: '生成文案' }));
    await screen.findByRole('heading', { name: '通勤随行杯' });
    fireEvent.click(screen.getByRole('button', { name: '编辑', exact: true }));
    fireEvent.change(screen.getByLabelText('详情页主标题'), { target: { value: '修改后的商品标题' } });
    fireEvent.change(screen.getByLabelText('第 1 屏正文'), { target: { value: '人工编辑的正文' } });
    fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
    await screen.findByText('修改已保存');
    expect(contentApi.update).toHaveBeenCalledWith(10, { detailPage: expect.objectContaining({ title: '修改后的商品标题', sections: expect.arrayContaining([expect.objectContaining({ body: '人工编辑的正文' })]) }) });
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('人工编辑的正文')));
    fireEvent.change(screen.getByLabelText('导出格式'), { target: { value: 'txt' } });
    fireEvent.click(screen.getByRole('button', { name: '导出', exact: true }));
    expect(exportedName).toBe('修改后的商品标题.txt');
    const exportedBlob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob;
    const text = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(exportedBlob); });
    expect(text).toContain('人工编辑的正文'); expect(text).toContain('容量待确认');
    expect(analysisApi.analyzeCopywriting).toHaveBeenCalledTimes(1);
  });

  it('reopens existing history for editing and keeps the draft when saving fails', async () => {
    vi.mocked(contentApi.update).mockRejectedValue(new Error('保存暂时失败'));
    mount('/app/copywriting?contentId=10');
    await screen.findByRole('heading', { name: '通勤随行杯' });
    expect(contentApi.getById).toHaveBeenCalledWith(10, expect.any(AbortSignal));
    expect((screen.getByLabelText('文案语言') as HTMLSelectElement).value).toBe('en');
    fireEvent.click(screen.getByRole('button', { name: '编辑', exact: true }));
    fireEvent.change(screen.getByLabelText('详情页主标题'), { target: { value: '未保存的修改' } });
    fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '保存暂时失败');
    expect((await screen.findByLabelText('详情页主标题') as HTMLTextAreaElement).value).toBe('未保存的修改');
    expect(screen.getByText('详情页文案 · 未保存')).toBeTruthy();
    expect(analysisApi.analyzeCopywriting).not.toHaveBeenCalled();
  });

  it('retains the original marketing workflow and supports keyboard switching', async () => {
    mount();
    fireEvent.keyDown(screen.getByRole('tab', { name: '详情页文案' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: '营销文案' }).getAttribute('aria-selected')).toBe('true');
    await upload(); fireEvent.click(screen.getByRole('button', { name: '生成文案' }));
    expect(await screen.findByText('Amazon 标题')).toBeTruthy(); expect(screen.getByText('Marketing hook')).toBeTruthy();
    expect(vi.mocked(analysisApi.analyzeCopywriting).mock.calls[0][2]?.mode).toBe('marketing');
  });

  it('enforces the existing ten-file limit before processing or submitting', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('上传产品素材'), { target: { files: Array.from({ length: 11 }, () => new File(['x'], 'product.png', { type: 'image/png' })) } });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '最多上传 10 个产品素材');
    expect(analysisApi.analyzeCopywriting).not.toHaveBeenCalled();
  });
});
