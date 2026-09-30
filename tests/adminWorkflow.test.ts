// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import ModelsPage from '../client/src/pages/admin/ModelsPage';
import { adminApi } from '../client/src/api/admin';
import { invalidateAdminCache } from '../client/src/api/adminCache';

vi.mock('../client/src/api/admin', () => ({ adminApi: {
  getModels: vi.fn(), getModelStatistics: vi.fn(), getChannels: vi.fn(), updateModel: vi.fn(),
  getPricing: vi.fn(), updatePricing: vi.fn(), createPricing: vi.fn(),
} }));
const model = { id: 1, modelId: 'video-a', displayName: 'Video A', provider: 'test', capabilities: ['video'], isActive: 1 };
const rule = { id: 2, modelPattern: 'video-a', displayName: 'Video A', category: 'video', billingType: 'per_call', inputPrice: 1, outputPrice: 0, extraParams: {}, configured: true, modelActive: true };
function Location() { return React.createElement('span', { 'data-testid': 'location' }, useLocation().search); }
function mount() {
  return render(React.createElement(MemoryRouter, { initialEntries: ['/admin/models?search=Video&channel=9'] },
    React.createElement(React.Fragment, null, React.createElement(Location), React.createElement(ModelsPage))));
}
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); localStorage.clear(); invalidateAdminCache();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.mocked(adminApi.getModels).mockResolvedValue([model]);
  vi.mocked(adminApi.getModelStatistics).mockResolvedValue({ items: [] });
  vi.mocked(adminApi.getChannels).mockResolvedValue([{ id: 9, name: 'Channel A', supportedModels: ['video-a'] }]);
  vi.mocked(adminApi.getPricing).mockResolvedValue([rule]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('model management workflow', () => {
  it('keeps the filtered list visible while toggling a model, without re-fetching all models', async () => {
    let finish!: () => void;
    vi.mocked(adminApi.updateModel).mockImplementation(() => new Promise(resolve => { finish = () => resolve({}); }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '停用 Video A' }));
    expect(screen.getByText('Video A')).toBeTruthy();
    expect((screen.getByPlaceholderText('搜索模型名称、ID 或提供商...') as HTMLInputElement).value).toBe('Video');
    expect((screen.getByRole('button', { name: '停用 Video A' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish());
    expect(await screen.findByRole('button', { name: '启用 Video A' })).toBeTruthy();
    expect(adminApi.getModels).toHaveBeenCalledTimes(1);
  });
  it('edits a price in the drawer and preserves the model URL and filters', async () => {
    vi.mocked(adminApi.updatePricing).mockResolvedValue({});
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '管理价格' }));
    const drawer = await screen.findByRole('dialog', { name: 'video-a · 价格详情' });
    fireEvent.click(await within(drawer).findByRole('button', { name: '编辑', exact: true }));
    const editor = await screen.findByRole('dialog', { name: '编辑计费规则' });
    fireEvent.change(within(editor).getByLabelText('单价（¥/次）'), { target: { value: '2.5' } });
    fireEvent.click(within(editor).getByRole('button', { name: '保存并立即生效' }));
    await waitFor(() => expect(adminApi.updatePricing).toHaveBeenCalledWith(2, expect.objectContaining({ modelPattern: 'video-a', inputPrice: 2.5 })));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑计费规则' })).toBeNull());
    fireEvent.click(within(drawer).getByRole('button', { name: '关闭', exact: true }));
    expect(screen.getByTestId('location').textContent).toBe('?search=Video&channel=9');
    expect((screen.getByPlaceholderText('搜索模型名称、ID 或提供商...') as HTMLInputElement).value).toBe('Video');
  });
  it('shows an actionable load error rather than only an empty list', async () => {
    vi.mocked(adminApi.getModels).mockRejectedValueOnce(Error('网络暂时不可用'));
    mount();
    expect((await screen.findByRole('alert')).textContent).toContain('网络暂时不可用');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('Video A')).toBeTruthy();
  });
});
