import { api } from './client';

export const adminApi = {
  getDashboard() { return api.get<any>('/admin/dashboard'); },

  getUsers(params: { page?: number; pageSize?: number; search?: string; tierId?: number; isActive?: number } = {}) {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    if (params.search) qs.set('search', params.search);
    if (params.tierId !== undefined) qs.set('tierId', String(params.tierId));
    if (params.isActive !== undefined) qs.set('isActive', String(params.isActive));
    return api.get<any>(`/admin/users?${qs.toString()}`);
  },
  updateUser(id: number, data: any) { return api.put<any>(`/admin/users/${id}`, data); },
  deleteUser(id: number) { return api.delete<any>(`/admin/users/${id}`); },

  getTiers() { return api.get<any>('/admin/tiers'); },
  createTier(data: any) { return api.post<any>('/admin/tiers', data); },
  updateTier(id: number, data: any) { return api.put<any>(`/admin/tiers/${id}`, data); },
  deleteTier(id: number) { return api.delete<any>(`/admin/tiers/${id}`); },

  getModels() { return api.get<any>('/admin/models'); },
  createModel(data: any) { return api.post<any>('/admin/models', data); },
  updateModel(id: number, data: any) { return api.put<any>(`/admin/models/${id}`, data); },
  deleteModel(id: number) { return api.delete<any>(`/admin/models/${id}`); },

  // 渠道管理
  getChannels() { return api.get<any[]>('/admin/channels'); },
  createChannel(data: any) { return api.post<any>('/admin/channels', data); },
  updateChannel(id: number, data: any) { return api.put<any>(`/admin/channels/${id}`, data); },
  deleteChannel(id: number) { return api.delete<any>(`/admin/channels/${id}`); },
  testChannel(id: number) { return api.post<any>(`/admin/channels/${id}/test`); },

  // Token 管理
  getTokens(params: { page?: number; pageSize?: number; search?: string } = {}) {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    if (params.search) qs.set('search', params.search);
    return api.get<any>(`/admin/tokens?${qs.toString()}`);
  },
  createToken(data: any) { return api.post<any>('/admin/tokens', data); },
  updateToken(id: number, data: any) { return api.put<any>(`/admin/tokens/${id}`, data); },
  deleteToken(id: number) { return api.delete<any>(`/admin/tokens/${id}`); },

  // 计费管理
  getPricing() { return api.get<any[]>('/admin/pricing'); },
  createPricing(data: any) { return api.post<any>('/admin/pricing', data); },
  updatePricing(id: number, data: any) { return api.put<any>(`/admin/pricing/${id}`, data); },
  deletePricing(id: number) { return api.delete<any>(`/admin/pricing/${id}`); },

  getSettings() { return api.get<any[]>('/admin/settings'); },
  updateSettings(items: { key: string; value: string }[]) {
    return api.put<any>('/admin/settings', { items });
  },
};

/** 公开接口 - 不需要登录 */
export async function getPublicSettings(): Promise<Record<string, string>> {
  const res = await fetch('/api/settings');
  return res.json();
}
