// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
vi.mock('../client/src/api/tokens', () => ({ tokensApi: { getTokens: vi.fn() } }));
vi.mock('../client/src/api/developer', () => ({ developerApi: { getModels: vi.fn() } }));
import { tokensApi } from '../client/src/api/tokens';
import { developerApi } from '../client/src/api/developer';
import ApiModelsPage from '../client/src/pages/ApiModelsPage';
import type { DeveloperModelCatalog } from '../shared/developerModels';

const keys = [{ id: 1, name: 'First key', tokenKeyMasked: 'sk-fir****1234', status: 1, expiresAt: null }, { id: 2, name: 'Second key', tokenKeyMasked: 'sk-sec****5678', status: 1, expiresAt: null }];
function catalog(id: number, name: string): DeveloperModelCatalog {
  return { token: { id, name: 'Key', maskedKey: '****' }, checkedAt: new Date().toISOString(), items: [{ id: name, canonicalId: 'model-' + id, name, description: '模型说明', kinds: ['video'], endpoints: ['/v1/videos'], limits: null, pricing: null, available: true, health: null }] };
}
const open = () => render(<MemoryRouter><ApiModelsPage /></MemoryRouter>);
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function () { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function () { this.removeAttribute('open'); } });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  vi.mocked(tokensApi.getTokens).mockResolvedValue({ items: keys, total: 2 });
  vi.mocked(developerApi.getModels).mockImplementation(async id => catalog(id, id === 1 ? 'First model' : 'Second model'));
});
afterEach(cleanup);

describe('API model catalog page', () => {
  it('filters models, opens details and copies an example with a placeholder key', async () => {
    open();
    await screen.findByRole('heading', { name: 'First model' });
    expect(screen.getByRole('table', { name: 'API 模型列表' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '调用价格' })).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.getByText('价格未配置')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: '搜索模型' }), { target: { value: 'missing' } });
    expect(screen.getByText('没有匹配的模型')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    fireEvent.click(screen.getByRole('button', { name: '详情与示例' }));
    expect(screen.getByRole('dialog', { name: 'First model' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '复制示例' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('sk-YOUR_API_KEY'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('"model": "First model"'));
    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('cancels old requests and never displays a previous key’s late response', async () => {
    let resolveFirst!: (value: DeveloperModelCatalog) => void;
    vi.mocked(developerApi.getModels).mockImplementation(id => id === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve(catalog(2, 'Second model')));
    open();
    await waitFor(() => expect(developerApi.getModels).toHaveBeenCalledWith(1, expect.any(AbortSignal)));
    const firstSignal = vi.mocked(developerApi.getModels).mock.calls[0][1]!;
    fireEvent.change(screen.getByRole('combobox', { name: '当前 API Key' }), { target: { value: '2' } });
    await screen.findByRole('heading', { name: 'Second model' });
    expect(firstSignal.aborted).toBe(true);
    await act(async () => resolveFirst(catalog(1, 'Stale model')));
    expect(screen.queryByText('Stale model')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Second model' })).toBeInTheDocument();
  });
  it('guides users with no keys to their profile without requesting models', async () => {
    vi.mocked(tokensApi.getTokens).mockResolvedValue({ items: [], total: 0 });
    open();
    expect(await screen.findByRole('link', { name: '前往创建 API Key' })).toHaveAttribute('href', '/app/profile');
    expect(developerApi.getModels).not.toHaveBeenCalled();
  });
  it('loads all key pages and retries a failed model request', async () => {
    vi.mocked(tokensApi.getTokens).mockImplementation(async ({ page } = {}) => ({ items: page === 1 ? [keys[0]] : [keys[1]], total: 2 }));
    vi.mocked(developerApi.getModels).mockRejectedValueOnce(new Error('Token 已过期')).mockResolvedValue(catalog(1, 'Recovered model'));
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent('Token 已过期');
    expect(screen.getByRole('option', { name: /Second key/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByRole('heading', { name: 'Recovered model' })).toBeInTheDocument();
  });
});
