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
  createUser(data: { email: string; username?: string; password: string; tierId?: string }) { return api.post<any>('/admin/users', data); },
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
  getChannelRuntimeStatus() { return api.get<any[]>('/admin/channels/runtime-status'); },
  getVideoRoutingStats(period: 'all' | '24h' | '7d' | '30d' = 'all') {
    return api.get<any>(`/admin/channels/routing-stats?period=${period}`);
  },
  createChannel(data: any) { return api.post<any>('/admin/channels', data); },
  updateChannel(id: number, data: any) { return api.put<any>(`/admin/channels/${id}`, data); },
  setChannelApiKeyStatus(channelId: number, keyId: number, status: number) { return api.put<any>(`/admin/channels/${channelId}/api-keys/${keyId}/status`, { status }); },
  deleteChannel(id: number) { return api.delete<any>(`/admin/channels/${id}`); },
  testChannel(id: number) { return api.post<any>(`/admin/channels/${id}/test`); },
  syncChannelModels(id: number) { return api.post<any>(`/admin/channels/${id}/sync-models`); },

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
  getPricing(params?: { category?: string; billingType?: string; search?: string }) {
    const query = new URLSearchParams();
    if (params?.category && params.category !== 'all') query.set('category', params.category);
    if (params?.billingType && params.billingType !== 'all') query.set('billingType', params.billingType);
    if (params?.search) query.set('search', params.search);
    return api.get<any[]>(`/admin/pricing${query.size ? `?${query.toString()}` : ''}`);
  },
  createPricing(data: any) { return api.post<any>('/admin/pricing', data); },
  updatePricing(id: number, data: any) { return api.put<any>(`/admin/pricing/${id}`, data); },
  deletePricing(id: number) { return api.delete<any>(`/admin/pricing/${id}`); },

  getSettings() { return api.get<any[]>('/admin/settings'); },
  updateSettings(items: { key: string; value: string }[]) {
    return api.put<any>('/admin/settings', { items });
  },

  // 组织管理
  getOrgs() { return api.get<any[]>('/admin/orgs'); },
  createOrg(data: { name: string; slug: string; ownerId: number; tierId?: number; balance?: number; maxMembers?: number }) {
    return api.post<any>('/admin/orgs', data);
  },
  updateOrg(id: number, data: any) { return api.put<any>(`/admin/orgs/${id}`, data); },
  deleteOrg(id: number) { return api.delete<any>(`/admin/orgs/${id}`); },

  // 内容管理
  getContents(params: { page?: number; pageSize?: number; type?: string; status?: string; search?: string } = {}) {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    if (params.type) qs.set('type', params.type);
    if (params.status) qs.set('status', params.status);
    if (params.search) qs.set('search', params.search);
    return api.get<any>(`/admin/contents?${qs.toString()}`);
  },
  getContent(id: number) { return api.get<any>(`/admin/contents/${id}`); },

  // 模型故障反馈
  getFeedback(params: { page?: number; pageSize?: number; status?: string; modelId?: string; search?: string } = {}) {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    if (params.status) qs.set('status', params.status);
    if (params.modelId) qs.set('modelId', params.modelId);
    if (params.search) qs.set('search', params.search);
    return api.get<any>(`/admin/feedback?${qs.toString()}`);
  },
  updateFeedback(id: number, data: { status?: string; adminNote?: string }) {
    return api.put<any>(`/admin/feedback/${id}`, data);
  },
};

/** 公开接口 - 不需要登录 */
export async function getPublicSettings(): Promise<Record<string, string>> {
  const res = await fetch('/api/settings');
  return res.json();
}
