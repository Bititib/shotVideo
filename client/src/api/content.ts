import { api } from './client';

export const contentApi = {
  /** 获取我的生成内容 */
  getMyContents(params: { page?: number; pageSize?: number; type?: string; status?: string; search?: string; dateFrom?: string; dateTo?: string } = {}) {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    if (params.type) qs.set('type', params.type);
    if (params.status) qs.set('status', params.status);
    if (params.search) qs.set('search', params.search);
    if (params.dateFrom) qs.set('dateFrom', params.dateFrom);
    if (params.dateTo) qs.set('dateTo', params.dateTo);
    return api.get<any>(`/contents?${qs.toString()}`);
  },

  /** 获取当前 API Key 用户的调用生成记录 */
  getMyApiHistory(params: { page?: number; pageSize?: number; type?: string; status?: string; search?: string; dateFrom?: string; dateTo?: string } = {}) {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    if (params.type) qs.set('type', params.type);
    if (params.status) qs.set('status', params.status);
    if (params.search) qs.set('search', params.search);
    if (params.dateFrom) qs.set('dateFrom', params.dateFrom);
    if (params.dateTo) qs.set('dateTo', params.dateTo);
    return api.get<any>(`/contents/api-history?${qs.toString()}`);
  },

  getMyApiHistoryById(id: number) { return api.get<any>(`/contents/api-history/${id}`); },

  deleteMyApiHistory(id: number) { return api.delete<any>(`/contents/api-history/${id}`); },

  /** 获取组织内容（管理员） */
  getOrgContents(params: { page?: number; pageSize?: number; type?: string; userId?: number; search?: string } = {}) {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    if (params.type) qs.set('type', params.type);
    if (params.userId) qs.set('userId', String(params.userId));
    if (params.search) qs.set('search', params.search);
    return api.get<any>(`/contents/org?${qs.toString()}`);
  },

  /** 获取内容详情 */
  getById(id: number) { return api.get<any>(`/contents/${id}`); },

  /** 删除内容 */
  delete(id: number) { return api.delete<any>(`/contents/${id}`); },
};
