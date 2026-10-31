// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
const mocks = vi.hoisted(() => ({ settings: vi.fn(), publicModels: vi.fn(), privateModels: vi.fn(), tokens: vi.fn(), docs: vi.fn() }));
const auth = vi.hoisted(() => ({ user: null as any, isAuthenticated: false, isLoading: false, showLoginModal: false,
  checkAuth: vi.fn(), openLoginModal: vi.fn(), closeLoginModal: vi.fn(), logout: vi.fn(), login: vi.fn(), register: vi.fn() }));
vi.mock('../client/src/stores/authStore', () => ({ useAuthStore: (selector?: any) => selector ? selector(auth) : auth }));
vi.mock('../client/src/api/admin', () => ({ getPublicSettings: mocks.settings }));
vi.mock('../client/src/api/developer', () => ({ developerApi: { getPublicModels: mocks.publicModels, getModels: mocks.privateModels } }));
vi.mock('../client/src/api/tokens', () => ({ tokensApi: { getTokens: mocks.tokens } }));
vi.mock('../client/src/pages/DocsPage', () => ({ default: () => { mocks.docs(); return <h2>接口文档内容</h2>; } }));
import App from '../client/src/App';

function Location() { const location = useLocation(); return <output aria-label="当前页面地址">{location.pathname + location.search}</output>; }
function open(url: string) { render(<MemoryRouter initialEntries={[url]}><App /><Location /></MemoryRouter>); }
beforeEach(() => {
  vi.clearAllMocks(); auth.user = null; auth.isAuthenticated = false;
  mocks.settings.mockResolvedValue({}); mocks.tokens.mockResolvedValue({ items: [], total: 0 });
  mocks.publicModels.mockResolvedValue({ token: null, checkedAt: '2026-10-31T10:00:00Z', items: [{
    id: 'ZH-TTseadanco2.5-480', canonicalId: 'ZH-TTseadanco2.5-480', name: 'TT 480P API', description: '支持视频 API',
    kinds: ['video'], endpoints: ['/v1/videos'], available: true, limits: null, health: null,
    pricing: { currency: 'CNY', billing_type: 'per_second', unit: 'second', unit_price: .28, output_unit_price: 0, resolution_prices: { '480p': .28 } },
  }] });
});
afterEach(cleanup);

describe('standalone public API model catalog routes', () => {
  it.each(['/app/models', '/models'])('opens %s as a public independent model page without loading docs or private keys', async url => {
    open(url);
    expect(await screen.findByRole('heading', { name: '模型列表', level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'TT 480P API' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'API 模型列表' })).toHaveTextContent('¥0.28 / 秒');
    expect(screen.getByLabelText('当前页面地址')).toHaveTextContent('/app/models');
    expect(screen.queryByRole('heading', { name: '开发者中心' })).not.toBeInTheDocument();
    expect(mocks.docs).not.toHaveBeenCalled(); expect(mocks.tokens).not.toHaveBeenCalled(); expect(mocks.privateModels).not.toHaveBeenCalled();
    expect(auth.openLoginModal).not.toHaveBeenCalled();
    expect(within(screen.getByLabelText('主导航')).getByRole('link', { name: '模型列表' })).toHaveAttribute('aria-current', 'page');
  });
  it('opens the page from the homepage and provides a footer entry for smaller screens', async () => {
    open('/');
    const navigation = await screen.findByRole('navigation', { name: '首页导航' });
    expect(within(screen.getByRole('contentinfo')).getByRole('link', { name: '模型列表' })).toHaveAttribute('href', '/app/models');
    fireEvent.click(within(navigation).getByRole('link', { name: '模型列表' }));
    expect(await screen.findByRole('heading', { name: '模型列表', level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'TT 480P API' })).toBeInTheDocument();
    expect(auth.openLoginModal).not.toHaveBeenCalled();
  });
  it('retains the old docs model tab and links it to the independent page', async () => {
    open('/app/docs?tab=models');
    expect(await screen.findByRole('heading', { name: '开发者中心' })).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'API 模型列表' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: '独立查看模型列表' }));
    expect(await screen.findByRole('heading', { name: '模型列表', level: 1 })).toBeInTheDocument();
    expect(screen.getByLabelText('当前页面地址')).toHaveTextContent('/app/models');
    expect(auth.openLoginModal).not.toHaveBeenCalled();
  });
  it('provides a working return link to interface documentation', async () => {
    open('/app/models'); await screen.findByRole('heading', { name: '模型列表', level: 1 });
    fireEvent.click(screen.getByRole('link', { name: '接口文档' }));
    expect(await screen.findByRole('heading', { name: '开发者中心' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '接口文档内容' })).toBeInTheDocument();
    expect(screen.getByLabelText('当前页面地址')).toHaveTextContent('/app/docs?tab=docs');
  });
  it('allows an authenticated account without an API key to use the standalone public catalog', async () => {
    auth.user = { id: 1, username: 'new-user', hasActiveApiKey: false }; auth.isAuthenticated = true;
    open('/app/models');
    expect(await screen.findByRole('heading', { name: 'TT 480P API' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '当前 API Key' })).toHaveValue('');
    expect(screen.getByRole('link', { name: '管理 API Key' })).toHaveAttribute('href', '/app/profile');
    expect(mocks.privateModels).not.toHaveBeenCalled(); expect(auth.openLoginModal).not.toHaveBeenCalled();
  });
});
