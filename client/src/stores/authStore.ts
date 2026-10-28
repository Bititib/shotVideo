import { create } from 'zustand';
import { authApi, UserProfile } from '../api/auth';
import { getAuthSession, isCurrentAuthSession, saveAuthToken, invalidateAuthSession, onAuthSessionInvalidated } from '../api/authSession';

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

let authCheckRequest: { session: ReturnType<typeof getAuthSession>; promise: Promise<boolean> } | null = null;
let loginAttempt = 0;

async function completeLogin(request: () => ReturnType<typeof authApi.login>) {
  const attempt = ++loginAttempt;
  const result = await request();
  if (attempt !== loginAttempt) throw new Error('登录状态已变更，请重新登录');
  const session = saveAuthToken(result.token);
  useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
  const profile = await authApi.getProfile();
  if (attempt !== loginAttempt || !isCurrentAuthSession(session)) throw new Error('登录状态已变更，请重新登录');
  useAuthStore.setState({ user: profile, isAuthenticated: true, isLoading: false, showLoginModal: false });
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  showLoginModal: false,

  login: async (email, password) => {
    await completeLogin(() => authApi.login(email, password));
  },

  register: async (email, username, password) => {
    await completeLogin(() => authApi.register(email, username, password));
  },

  logout: () => {
    loginAttempt += 1;
    void fetch('/api/auth/logout',{method:'POST'}).catch(()=>{});
    invalidateAuthSession();
  },

  fetchProfile: async () => {
    await get().checkAuth();
  },

  checkAuth: async () => {
    const session = getAuthSession();
    if (!session.token) {
      set({ user: null, isLoading: false, isAuthenticated: false });
      return false;
    }
    if (authCheckRequest && isCurrentAuthSession(authCheckRequest.session)) return authCheckRequest.promise;

    const request = (async () => {
      try {
        const profile = await authApi.getProfile();
        if (!isCurrentAuthSession(session)) return get().isAuthenticated;
        set({ user: profile, isAuthenticated: true, isLoading: false });
        return true;
      } catch {
        // The API client invalidates confirmed 401s. Network errors, timeouts,
        // rate limiting and server errors are not evidence of an expired login.
        if (isCurrentAuthSession(session)) set({ isLoading: false });
        return get().isAuthenticated;
      }
    })();
    authCheckRequest = { session, promise: request };

    try {
      return await request;
    } finally {
      if (authCheckRequest?.promise === request) authCheckRequest = null;
    }
  },

  openLoginModal: () => set({ showLoginModal: true }),
  closeLoginModal: () => set({ showLoginModal: false }),

  requireAuth: () => {
    const { isAuthenticated } = get();
    if (isAuthenticated && getAuthSession().token) return true;
    set({ user: null, isAuthenticated: false, showLoginModal: true });
    return false;
  },
}));

onAuthSessionInvalidated(() => {
  authCheckRequest = null;
  useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
});
