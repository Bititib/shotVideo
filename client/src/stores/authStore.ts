import { create } from 'zustand';
import { authApi, UserProfile } from '../api/auth';

interface AuthState {
  user: UserProfile | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  showLoginModal: boolean;

  login: (email: string, password: string) => Promise<void>;
  register: (email: string, username: string, password: string) => Promise<void>;
  logout: () => void;
  fetchProfile: () => Promise<void>;
  checkAuth: () => Promise<boolean>;
  openLoginModal: () => void;
  closeLoginModal: () => void;
  /** 需要登录才能执行的操作：已登录直接返回 true，未登录弹窗并返回 false */
  requireAuth: () => boolean;
}

let authCheckRequest: Promise<boolean> | null = null;

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  showLoginModal: false,

  login: async (email, password) => {
    const result = await authApi.login(email, password);
    localStorage.setItem('token', result.token);
    // 获取完整 profile（含等级信息）
    const profile = await authApi.getProfile();
    set({ user: profile, isAuthenticated: true, showLoginModal: false });
  },

  register: async (email, username, password) => {
    const result = await authApi.register(email, username, password);
    localStorage.setItem('token', result.token);
    const profile = await authApi.getProfile();
    set({ user: profile, isAuthenticated: true, showLoginModal: false });
  },

  logout: () => {
    localStorage.removeItem('token');
    set({ user: null, isAuthenticated: false });
  },

  fetchProfile: async () => {
    try {
      const profile = await authApi.getProfile();
      set({ user: profile, isAuthenticated: true });
    } catch {
      set({ user: null, isAuthenticated: false });
      localStorage.removeItem('token');
    }
  },

  checkAuth: async () => {
    if (authCheckRequest) return authCheckRequest;

    const token = localStorage.getItem('token');
    if (!token) {
      set({ isLoading: false, isAuthenticated: false });
      return false;
    }

    const request = (async () => {
      try {
        const profile = await authApi.getProfile();
        set({ user: profile, isAuthenticated: true, isLoading: false });
        return true;
      } catch {
        localStorage.removeItem('token');
        set({ user: null, isAuthenticated: false, isLoading: false });
        return false;
      }
    })();
    authCheckRequest = request;

    try {
      return await request;
    } finally {
      if (authCheckRequest === request) authCheckRequest = null;
    }
  },

  openLoginModal: () => set({ showLoginModal: true }),
  closeLoginModal: () => set({ showLoginModal: false }),

  requireAuth: () => {
    const { isAuthenticated } = get();
    if (isAuthenticated) return true;
    set({ showLoginModal: true });
    return false;
  },
}));
