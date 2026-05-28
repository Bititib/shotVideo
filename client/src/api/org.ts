import { api } from './client';

export const orgApi = {
  /** 获取当前用户的组织信息 */
  getMyOrg() { return api.get<any>('/org/me'); },

  /** 更新组织信息 */
  updateOrg(data: { name: string }) { return api.put<any>('/org/me', data); },

  /** 获取组织成员列表 */
  getMembers() { return api.get<any[]>('/org/members'); },

  /** 创建组织成员（直接创建员工） */
  createMember(data: { email: string; username?: string; password: string; role?: string }) {
    return api.post<any>('/org/members', data);
  },

  /** 修改成员角色 */
  updateMemberRole(memberId: number, role: string) {
    return api.put<any>(`/org/members/${memberId}/role`, { role });
  },

  /** 移除成员 */
  removeMember(memberId: number) {
    return api.delete<any>(`/org/members/${memberId}`);
  },

  /** 获取组织用量统计 */
  getUsage() { return api.get<any>('/org/usage'); },
};
