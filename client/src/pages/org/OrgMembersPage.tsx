import React, { useEffect, useState, useCallback } from 'react';
import { orgApi } from '../../api/org';
import { UserPlus, Shield, Trash2, Edit2, Eye, EyeOff, Mail, Lock, User } from 'lucide-react';

export default function OrgMembersPage() {
  const [members, setMembers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newMember, setNewMember] = useState({ email: '', username: '', password: '', role: 'member' });
  const [showPassword, setShowPassword] = useState(false);
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await orgApi.getMembers();
      setMembers(data);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!newMember.email || !newMember.password) {
      setCreateError('邮箱和密码不能为空');
      return;
    }
    if (newMember.password.length < 6) {
      setCreateError('密码至少6位');
      return;
    }
    setCreateError('');
    setCreating(true);
    try {
      await orgApi.createMember(newMember);
      setShowCreate(false);
      setNewMember({ email: '', username: '', password: '', role: 'member' });
      load();
    } catch (e: any) {
      setCreateError(e.message);
    } finally { setCreating(false); }
  };

  const handleChangeRole = async (memberId: number, currentRole: string) => {
    const newRole = currentRole === 'admin' ? 'member' : 'admin';
    if (!confirm(`确定将此成员${newRole === 'admin' ? '提升为管理员' : '降级为普通成员'}？`)) return;
    try {
      await orgApi.updateMemberRole(memberId, newRole);
      load();
    } catch (e: any) { alert(e.message); }
  };

  const handleRemove = async (memberId: number) => {
    if (!confirm('确定移除此成员？该成员将变为独立用户')) return;
    try {
      await orgApi.removeMember(memberId);
      load();
    } catch (e: any) { alert(e.message); }
  };

  const getRoleBadge = (role: string) => {
    switch (role) {
      case 'owner': return <span className="text-[10px] px-1.5 py-0.5 bg-amber-500/15 text-amber-400 rounded-md font-medium">创建者</span>;
      case 'admin': return <span className="text-[10px] px-1.5 py-0.5 bg-blue-500/15 text-blue-400 rounded-md font-medium">管理员</span>;
      default: return <span className="text-[10px] px-1.5 py-0.5 bg-zinc-500/15 text-zinc-400 rounded-md font-medium">成员</span>;
    }
  };

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">👥 成员管理</h1>
        <button onClick={() => setShowCreate(true)} className="flex items-center gap-1.5 px-4 py-2.5 bg-teal-600 hover:bg-teal-500 rounded-xl text-sm font-medium transition-colors">
          <UserPlus className="w-4 h-4" /> 添加员工
        </button>
      </div>

      {/* Members Table */}
      <div className="bg-white/[0.03] border border-white/5 rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/5 bg-white/[0.01]">
              <th className="text-left py-3.5 px-5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">成员</th>
              <th className="text-center py-3.5 px-3 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">角色</th>
              <th className="text-center py-3.5 px-3 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">状态</th>
              <th className="text-center py-3.5 px-3 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">今日用量</th>
              <th className="text-right py-3.5 px-5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="py-12 text-center"><div className="w-6 h-6 border-2 border-white/10 border-t-white rounded-full animate-spin mx-auto" /></td></tr>
            ) : members.length === 0 ? (
              <tr><td colSpan={5} className="py-12 text-center text-zinc-500 text-sm">暂无成员，点击"添加员工"开始</td></tr>
            ) : members.map(m => (
              <tr key={m.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                <td className="py-3.5 px-5">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-teal-500/20 to-cyan-500/20 flex items-center justify-center text-xs font-bold text-teal-400 shrink-0">
                      {m.username?.[0]?.toUpperCase() || '?'}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm text-white truncate">{m.username}</p>
                      <p className="text-[10px] text-zinc-500 truncate">{m.email}</p>
                    </div>
                  </div>
                </td>
                <td className="py-3.5 px-3 text-center">{getRoleBadge(m.role)}</td>
                <td className="py-3.5 px-3 text-center">
                  {m.isActive ? (
                    <span className="inline-flex items-center gap-1 text-[10px] text-green-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" /> 活跃
                    </span>
                  ) : (
                    <span className="text-[10px] text-red-400">已禁用</span>
                  )}
                </td>
                <td className="py-3.5 px-3 text-center text-xs text-zinc-300">{m.usedToday}</td>
                <td className="py-3.5 px-5 text-right">
                  {m.role !== 'owner' && (
                    <div className="flex items-center justify-end gap-1.5">
                      <button onClick={() => handleChangeRole(m.id, m.role)} className="p-1.5 hover:bg-white/10 rounded-lg transition-colors" title={m.role === 'admin' ? '降为成员' : '升为管理员'}>
                        <Shield className="w-3.5 h-3.5 text-zinc-400 hover:text-blue-400" />
                      </button>
                      <button onClick={() => handleRemove(m.id)} className="p-1.5 hover:bg-red-500/10 rounded-lg transition-colors" title="移除成员">
                        <Trash2 className="w-3.5 h-3.5 text-zinc-400 hover:text-red-400" />
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Create Member Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setShowCreate(false)}>
          <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-1">添加新员工</h3>
            <p className="text-xs text-zinc-500 mb-5">为组织创建一个新的成员账号</p>

            <div className="space-y-3.5">
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input type="email" value={newMember.email} onChange={e => setNewMember({ ...newMember, email: e.target.value })} placeholder="邮箱地址 *" className="w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white focus:outline-none focus:border-teal-500/50 transition-colors placeholder:text-zinc-600" />
              </div>
              <div className="relative">
                <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input type="text" value={newMember.username} onChange={e => setNewMember({ ...newMember, username: e.target.value })} placeholder="用户名（可选）" className="w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white focus:outline-none focus:border-teal-500/50 transition-colors placeholder:text-zinc-600" />
              </div>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input type={showPassword ? 'text' : 'password'} value={newMember.password} onChange={e => setNewMember({ ...newMember, password: e.target.value })} placeholder="初始密码 *（至少6位）" className="w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-10 py-2.5 text-sm text-white focus:outline-none focus:border-teal-500/50 transition-colors placeholder:text-zinc-600" />
                <button onClick={() => setShowPassword(!showPassword)} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300">
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <div>
                <label className="block text-[10px] text-zinc-400 mb-1.5">角色</label>
                <div className="flex gap-2">
                  <button onClick={() => setNewMember({ ...newMember, role: 'member' })} className={`flex-1 py-2 rounded-xl text-xs font-medium transition-all ${newMember.role === 'member' ? 'bg-teal-500/15 text-teal-400 border border-teal-500/30' : 'bg-white/5 text-zinc-400 border border-white/5'}`}>
                    普通成员
                  </button>
                  <button onClick={() => setNewMember({ ...newMember, role: 'admin' })} className={`flex-1 py-2 rounded-xl text-xs font-medium transition-all ${newMember.role === 'admin' ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30' : 'bg-white/5 text-zinc-400 border border-white/5'}`}>
                    组织管理员
                  </button>
                </div>
              </div>
              {createError && <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2 text-xs text-red-400">{createError}</div>}
            </div>

            <div className="flex gap-3 mt-5">
              <button onClick={() => setShowCreate(false)} className="flex-1 py-2.5 bg-white/5 hover:bg-white/10 rounded-xl text-sm transition-colors">取消</button>
              <button onClick={handleCreate} disabled={creating} className="flex-1 py-2.5 bg-teal-600 hover:bg-teal-500 disabled:opacity-50 rounded-xl text-sm font-medium transition-colors">
                {creating ? '创建中...' : '创建员工'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
