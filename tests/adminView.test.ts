// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAdminFilters, useAdminScroll } from '../client/src/hooks/useAdminView';

function View({ ready = true }: { ready?: boolean }) {
  const { values, setFilter, reset } = useAdminFilters({ search: '', channel: 'all' });
  const location = useLocation();
  const navigate = useNavigate();
  useAdminScroll(ready);
  return React.createElement('div', null,
    React.createElement('input', { 'aria-label': '搜索', value: values.search, onChange: e => setFilter('search', e.target.value) }),
    React.createElement('span', { 'data-testid': 'channel' }, values.channel),
    React.createElement('span', { 'data-testid': 'url' }, location.search),
    React.createElement('button', { onClick: reset }, '清除'),
    React.createElement('button', { onClick: () => navigate(-1) }, '后退'),
    React.createElement(Link, { to: '/admin/pricing' }, '价格'),
    React.createElement(Link, { to: '/admin/models?channel=7' }, '渠道七'),
  );
}
function mount(initial = '/admin/models', ready = true) {
  return render(React.createElement(MemoryRouter, { initialEntries: [initial] },
    React.createElement(Routes, null,
      React.createElement(Route, { path: '/admin/models', element: React.createElement(View, { ready }) }),
      React.createElement(Route, { path: '/admin/pricing', element: React.createElement(Link, { to: '/admin/models' }, '返回模型') }),
    )));
}
beforeEach(() => { sessionStorage.clear(); vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('admin view continuity', () => {
  it('restores filters after a plain sidebar round trip', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: 'wan' } });
    expect(screen.getByTestId('url').textContent).toContain('search=wan');
    fireEvent.click(screen.getByText('价格'));
    fireEvent.click(screen.getByText('返回模型'));
    expect((screen.getByLabelText('搜索') as HTMLInputElement).value).toBe('wan');
    fireEvent.click(screen.getByText('清除'));
    fireEvent.click(screen.getByText('价格'));
    fireEvent.click(screen.getByText('返回模型'));
    expect((screen.getByLabelText('搜索') as HTMLInputElement).value).toBe('');
  });
  it('lets explicit deep links override remembered filters, including on browser back', async () => {
    sessionStorage.setItem('admin-view:undefined:/admin/models', 'search=old&channel=2');
    mount('/admin/models?search=new');
    expect(screen.getByTestId('channel').textContent).toBe('all');
    fireEvent.click(screen.getByText('渠道七'));
    expect(screen.getByTestId('channel').textContent).toBe('7');
    expect((screen.getByLabelText('搜索') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByText('后退'));
    await waitFor(() => expect((screen.getByLabelText('搜索') as HTMLInputElement).value).toBe('new'));
  });
  it('waits for the list before restoring scroll', () => {
    sessionStorage.setItem('admin-scroll:undefined:/admin/models', JSON.stringify({ window: 420, main: 0 }));
    const page = mount('/admin/models', false);
    expect(window.scrollTo).not.toHaveBeenCalled();
    page.unmount();
    mount();
    expect(window.scrollTo).toHaveBeenCalledWith(0, 420);
  });
  it('does not merge an old remembered search into a new channel link on the same page', async () => {
    sessionStorage.setItem('admin-view:undefined:/admin/models', 'search=old&channel=2');
    mount();
    expect((screen.getByLabelText('搜索') as HTMLInputElement).value).toBe('old');
    fireEvent.click(screen.getByText('渠道七'));
    await waitFor(() => expect(screen.getByTestId('channel').textContent).toBe('7'));
    expect((screen.getByLabelText('搜索') as HTMLInputElement).value).toBe('');
  });
});
