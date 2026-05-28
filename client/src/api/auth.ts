import { api } from './client';

export interface LoginResponse {
  token: string;
  user: { id: number; email: string; username: string; role: string; orgId: number | null };
}

export interface OrgInfo {
  id: number;
  name: string;
  slug: string;
  myRole: string;   // owner / admin / member
  balance: number;
}

export interface UserProfile {
  id: number;
  email: string;
  username: string;
  role: string;
  tier: {
    id: number;
    name: string;
    displayName: string;
    dailyQuota: number;
    allowedFeatures: string[];
  } | null;
  tierExpiresAt: string | null;
  usedToday: number;
  remainingToday: number;
  balance: number;
  isActive: number;
  createdAt: string;
  org: OrgInfo | null;
}

export const authApi = {
  register(email: string, username: string, password: string) {
    return api.post<LoginResponse>('/auth/register', { email, username, password }, { skipAuth: true });
  },

  login(email: string, password: string) {
    return api.post<LoginResponse>('/auth/login', { email, password }, { skipAuth: true });
  },

  getProfile() {
    return api.get<UserProfile>('/auth/me');
  },
};
