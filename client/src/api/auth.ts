import { api } from './client';

export interface LoginResponse {
  token: string;
  user: { id: number; email: string; username: string; role: string };
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
  isActive: number;
  createdAt: string;
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
