import { api } from './client';

export const tokensApi = {
  getTokens(params: { page?: number; pageSize?: number; search?: string } = {}) {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    if (params.search) qs.set('search', params.search);
    return api.get<any>(`/tokens?${qs.toString()}`);
  },

  createToken(data: { name: string; allowedModels?: string[]; expiresAt?: string }) {
    return api.post<any>('/tokens', data);
  },

  updateToken(id: number, data: { name?: string; status?: number; expiresAt?: string | null }) {
    return api.put<any>(`/tokens/${id}`, data);
  },

  deleteToken(id: number) {
    return api.delete<any>(`/tokens/${id}`);
  },
};
