// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../client/src/api/client';
import { authApi } from '../client/src/api/auth';
import { invalidateAuthSession, saveAuthToken } from '../client/src/api/authSession';
import { useAuthStore } from '../client/src/stores/authStore';
import LoginModal from '../client/src/components/LoginModal';

const profile = { id: 1, email: 'user@example.com', username: 'User', role: 'user' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function signedIn(token = 'old-token') {
  saveAuthToken(token);
  useAuthStore.setState({ user: profile as any, isAuthenticated: true, isLoading: false });
}
beforeEach(() => {
  localStorage.clear();
  invalidateAuthSession();
  useAuthStore.setState({ showLoginModal: false });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('login recovery through the actual API client and auth store', () => {
  it('registers through the visible dialog and completes the normal account session without an API Key',async()=>{
    useAuthStore.setState({showLoginModal:true});
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({token:'registered-token',user:profile},{status:201})).mockResolvedValueOnce(Response.json({...profile,balance:0,hasActiveApiKey:false}));
    vi.stubGlobal('fetch',fetcher);
    render(<MemoryRouter initialEntries={['/app/docs?tab=models']}><LoginModal /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button',{name:'立即注册'}));
    fireEvent.change(screen.getByLabelText('用户名'),{target:{value:'New user'}});
    fireEvent.change(screen.getByLabelText('邮箱'),{target:{value:profile.email}});
    fireEvent.change(screen.getByLabelText('密码'),{target:{value:'correct-password'}});
    fireEvent.change(screen.getByLabelText('确认密码'),{target:{value:'different-password'}});
    fireEvent.click(screen.getByRole('button',{name:'注册并登录'}));
    expect((await screen.findByRole('alert')).textContent).toContain('两次输入的密码不一致');expect(fetcher).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('确认密码'),{target:{value:'correct-password'}});
    fireEvent.click(screen.getByRole('button',{name:'注册并登录'}));
    await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({email:profile.email,username:'New user',password:'correct-password'});
    expect(fetcher.mock.calls[0][0]).toBe('/api/auth/register');
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBe('Bearer registered-token');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);expect(useAuthStore.getState().user).toMatchObject({balance:0,hasActiveApiKey:false});
  });
  it('shows the actual credential error in the login dialog, then allows a corrected login', async () => {
    useAuthStore.setState({ showLoginModal: true });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: '邮箱或密码错误' }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ token: 'new-token', user: profile }))
      .mockResolvedValueOnce(Response.json(profile));
    vi.stubGlobal('fetch', fetcher);
    render(<MemoryRouter initialEntries={['/app']}><LoginModal /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: profile.email } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect((await screen.findByRole('alert')).textContent).toBe('邮箱或密码错误');
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'correct-password' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(fetcher.mock.calls[2][1].headers.Authorization).toBe('Bearer new-token');
  });

  it('does not invalidate an existing session when the public login endpoint rejects credentials', async () => {
    signedIn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: '邮箱或密码错误' }, { status: 401 })));
    await expect(authApi.login(profile.email, 'wrong')).rejects.toMatchObject({ message: '邮箱或密码错误', status: 401, data: { error: '邮箱或密码错误' } });
    expect(localStorage.getItem('token')).toBe('old-token');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('clears both token and visible login state on expiry, then successfully logs in again', async () => {
    signedIn();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ error: '登录已过期，请重新登录' }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ token: 'new-token', user: profile }))
      .mockResolvedValueOnce(Response.json(profile)));
    await expect(api.get('/contents')).rejects.toMatchObject({ status: 401 });
    expect(localStorage.getItem('token')).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().requireAuth()).toBe(false);
    expect(useAuthStore.getState().showLoginModal).toBe(true);
    await useAuthStore.getState().login(profile.email, 'correct');
    expect(useAuthStore.getState().requireAuth()).toBe(true);
    expect(useAuthStore.getState().showLoginModal).toBe(false);
  });

  it.each([401, 503, 200])('ignores an old profile response (%s) arriving after a new login', async status => {
    signedIn();
    const old = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(Response.json({ token: 'new-token', user: profile }))
      .mockResolvedValueOnce(Response.json(profile)));
    const check = useAuthStore.getState().checkAuth();
    await useAuthStore.getState().login(profile.email, 'correct');
    old.resolve(Response.json(status === 200 ? { ...profile, id: 99 } : { error: '旧请求失败' }, { status }));
    await check;
    expect(localStorage.getItem('token')).toBe('new-token');
    expect(useAuthStore.getState().user?.id).toBe(1);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('accepts login even if the old session expires while credentials are being checked', async () => {
    signedIn();
    const old = deferred<Response>();
    const login = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(login.promise).mockResolvedValueOnce(Response.json(profile)));
    const check = useAuthStore.getState().checkAuth();
    const attempt = useAuthStore.getState().login(profile.email, 'correct');
    old.resolve(Response.json({ error: '登录已过期' }, { status: 401 }));
    await check;
    login.resolve(Response.json({ token: 'new-token', user: profile }));
    await attempt;
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('does not let an anonymous request or an old protected request erase the new token', async () => {
    const anonymous = deferred<Response>();
    const old = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(anonymous.promise).mockReturnValueOnce(old.promise));
    const first = api.get('/contents').catch(error => error);
    signedIn();
    const second = api.get('/contents').catch(error => error);
    signedIn('new-token');
    anonymous.resolve(Response.json({ error: '请先登录' }, { status: 401 }));
    old.resolve(Response.json({ error: '登录已过期' }, { status: 401 }));
    await Promise.all([first, second]);
    expect(localStorage.getItem('token')).toBe('new-token');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it.each([429, 500, 503, 'network'])('preserves login on a temporary profile error (%s) and can retry', async status => {
    signedIn();
    const fetcher = vi.fn();
    if (status === 'network') fetcher.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    else fetcher.mockResolvedValueOnce(Response.json({ error: '暂不可用' }, { status: status as number }));
    fetcher.mockResolvedValueOnce(Response.json({ ...profile, username: 'Updated' }));
    vi.stubGlobal('fetch', fetcher);
    await useAuthStore.getState().fetchProfile();
    expect(localStorage.getItem('token')).toBe('old-token');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    await useAuthStore.getState().fetchProfile();
    expect(useAuthStore.getState().user?.username).toBe('Updated');
  });

  it('keeps the session on a profile timeout', async () => {
    vi.useFakeTimers();
    signedIn();
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const check = useAuthStore.getState().checkAuth();
    await vi.advanceTimersByTimeAsync(30000);
    await check;
    expect(localStorage.getItem('token')).toBe('old-token');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('can recover from a temporary startup failure without deleting the persisted token', async () => {
    saveAuthToken('persisted-token');
    useAuthStore.setState({ isLoading: true });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(Response.json(profile)));
    expect(await useAuthStore.getState().checkAuth()).toBe(false);
    expect(useAuthStore.getState().isLoading).toBe(false);
    expect(localStorage.getItem('token')).toBe('persisted-token');
    expect(await useAuthStore.getState().checkAuth()).toBe(true);
  });

  it('ignores an old 401 even when the server issues the same token on a new login', async () => {
    signedIn();
    const old = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(Response.json({ token: 'old-token', user: profile }))
      .mockResolvedValueOnce(Response.json(profile)));
    const pending = api.get('/contents').catch(error => error);
    await useAuthStore.getState().login(profile.email, 'correct');
    old.resolve(Response.json({ error: '过期' }, { status: 401 }));
    await pending;
    expect(localStorage.getItem('token')).toBe('old-token');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('does not show the old account if a replacement login cannot load its profile', async () => {
    signedIn();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ token: 'new-account-token', user: { ...profile, id: 2 } }))
      .mockResolvedValueOnce(Response.json({ error: '服务暂不可用' }, { status: 503 })));
    await expect(useAuthStore.getState().login('other@example.com', 'correct')).rejects.toThrow('服务暂不可用');
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(localStorage.getItem('token')).toBe('new-account-token');
  });

  it('deduplicates checks for one session but checks a replacement session independently', async () => {
    signedIn();
    const old = deferred<Response>();
    const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(Response.json(profile));
    vi.stubGlobal('fetch', fetcher);
    const first = useAuthStore.getState().checkAuth();
    const duplicate = useAuthStore.getState().checkAuth();
    expect(fetcher).toHaveBeenCalledTimes(1);
    saveAuthToken('new-token');
    await useAuthStore.getState().checkAuth();
    expect(fetcher).toHaveBeenCalledTimes(2);
    old.resolve(Response.json({ error: '过期' }, { status: 401 }));
    await Promise.all([first, duplicate]);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('does not restore a logged-out user from a late successful profile', async () => {
    signedIn();
    const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(Response.json({ success: true })));
    const check = useAuthStore.getState().checkAuth();
    useAuthStore.getState().logout();
    pending.resolve(Response.json(profile));
    await check;
    expect(localStorage.getItem('token')).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('does not restore a login cancelled by logout before its credentials return', async () => {
    const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(Response.json({ success: true })));
    const attempt = useAuthStore.getState().login(profile.email, 'correct');
    const rejected = expect(attempt).rejects.toThrow('登录状态已变更');
    useAuthStore.getState().logout();
    pending.resolve(Response.json({ token: 'new-token', user: profile }));
    await rejected;
    expect(localStorage.getItem('token')).toBeNull();
  });
});
