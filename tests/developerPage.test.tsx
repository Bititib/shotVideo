// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
const auth = vi.hoisted(() => ({ isAuthenticated: true, openLoginModal: vi.fn() }));
vi.mock('../client/src/stores/authStore', () => ({ useAuthStore: () => auth }));
vi.mock('../client/src/pages/DocsPage', () => ({ default: () => <p>接口说明内容</p> }));
vi.mock('../client/src/pages/ApiModelsPage', () => ({ default: () => <label>模型筛选<input aria-label="模型筛选" /></label> }));
import DeveloperPage from '../client/src/pages/DeveloperPage';

function Location() { return <output aria-label="当前地址">{useLocation().search}</output>; }
function open(url = '/app/docs') { render(<MemoryRouter initialEntries={[url]}><DeveloperPage /><Location /></MemoryRouter>); }
beforeEach(() => { auth.isAuthenticated = true; vi.clearAllMocks(); });
afterEach(cleanup);
describe('combined developer center', () => {
  it('switches tabs through the URL and preserves model filters', async () => {
    open();
    await screen.findByText('接口说明内容');
    expect(screen.getByRole('tab', { name: '接口文档' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByLabelText('模型筛选')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'API 模型' }));
    fireEvent.change(await screen.findByRole('textbox', { name: '模型筛选' }), { target: { value: 'seedance' } });
    expect(screen.getByLabelText('当前地址')).toHaveTextContent('?tab=models');
    fireEvent.click(screen.getByRole('tab', { name: '接口文档' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('接口说明内容');
    fireEvent.click(screen.getByRole('tab', { name: 'API 模型' }));
    expect(screen.getByRole('textbox', { name: '模型筛选' })).toHaveValue('seedance');
  });
  it('opens the model deep link and supports keyboard tab navigation', async () => {
    open('/app/docs?tab=models');
    await screen.findByRole('textbox', { name: '模型筛选' });
    const modelTab = screen.getByRole('tab', { name: 'API 模型' });
    modelTab.focus();
    fireEvent.keyDown(modelTab, { key: 'ArrowLeft' });
    await waitFor(() => expect(screen.getByRole('tab', { name: '接口文档' })).toHaveFocus());
    expect(screen.getByLabelText('当前地址')).toHaveTextContent('?tab=docs');
  });
  it('keeps docs public and prompts login for models', async () => {
    auth.isAuthenticated = false;
    open('/app/docs?tab=models');
    expect(screen.getByRole('heading', { name: '登录后查看 API 模型' })).toBeInTheDocument();
    expect(screen.queryByLabelText('模型筛选')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '登录 / 注册' }));
    expect(auth.openLoginModal).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('tab', { name: '接口文档' }));
    await screen.findByText('接口说明内容');
  });
});
