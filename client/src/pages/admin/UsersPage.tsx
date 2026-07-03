import React, { useEffect, useState, useCallback } from 'react';
import { adminApi } from '../../api/admin';
import { Search, ChevronLeft, ChevronRight, X, Check, Ban, UserPlus } from 'lucide-react';

export default function UsersPage() {
  const [users, setUsers] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [tiers, setTiers] = useState<any[]>([]);
  const [editUser, setEditUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newUser, setNewUser] = useState({ email: '', username: '', password: '', tierId: '' });
  const [createError, setCreateError] = useState('');
  const pageSize = 15;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [userData, tierData] = await Promise.all([
        adminApi.getUsers({ page, pageSize, search: search || undefined }),
        adminApi.getTiers(),
      ]);
      setUsers(userData.items); setTotal(userData.total); setTiers(tierData);
    } finally { setLoading(false); }
  }, [page, search]);

  useEffect(() => { load(); }, [load]);

  const handleUpdate = async () => {
    if (!editUser) return;
    try {
      await adminApi.updateUser(editUser.id, {
        tierId: editUser.tierId,
        tierExpiresAt: editUser.tierExpiresAt,
        isActive: editUser.isActive,
        role: editUser.role,
        quotaOverride: editUser.quotaOverride ? parseInt(editUser.quotaOverride) : null,
        balance: parseFloat(editUser.balance) || 0,
        password: editUser.password || undefined,
      });
      setEditUser(null); load();
    } catch (e: any) { alert(e.message); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('确定删除此用户？')) return;
    try { await adminApi.deleteUser(id); load(); } catch (e: any) { alert(e.message); }
  };

  const handleCreate = async () => {
    if (!newUser.email || !newUser.password) { setCreateError('邮箱和密码不能为空'); return; }
    if (newUser.password.length < 6) { setCreateError('密码至少6位'); return; }
    setCreateError('');
    try {
      await adminApi.createUser(newUser);
      setShowCreate(false);
      setNewUser({ email: '', username: '', password: '', tierId: '' });
      load();
    } catch (e: any) { setCreateError(e.message); }
  };

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">👥 用户管理</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500">共 {total} 个用户</span>
          <button onClick={() => setShowCreate(true)} className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-medium transition-colors">
            <UserPlus className="w-4 h-4" /> 创建用户
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative mb-6">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
        <input type="text" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="搜索邮箱..." className="w-full bg-white/[0.03] border border-white/5 rounded-xl pl-11 pr-4 py-3 text-sm text-white focus:outline-none focus:border-white/10 placeholder:text-zinc-600" />
      </div>

      {/* Table */}
      <div className="bg-white/[0.02] border border-white/5 rounded-2xl overflow-hidden mb-6">
        <table className="w-full">
          <thead><tr className="border-b border-white/5">
            {['ID', '邮箱', '用户名', '等级', '余额', '今日用量', '状态', '操作'].map(h => <th key={h} className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-4 py-3 font-medium">{h}</th>)}
          </tr></thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="text-center py-12"><div className="w-6 h-6 border-2 border-white/10 border-t-white rounded-full animate-spin mx-auto" /></td></tr>
            ) : users.map(u => {
              const tierColors: Record<string, string> = { '免费用户': 'text-zinc-400', '基础会员': 'text-yellow-400', '专业会员': 'text-blue-400', '企业会员': 'text-purple-400' };
              return (
                <tr key={u.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                  <td className="px-4 py-3 text-xs text-zinc-500">{u.id}</td>
                  <td className="px-4 py-3 text-sm text-zinc-300">{u.email}</td>
                  <td className="px-4 py-3 text-sm text-zinc-300">{u.username}</td>
                  <td className="px-4 py-3"><span className={`text-xs font-medium ${tierColors[u.tierName] || 'text-zinc-400'}`}>{u.tierName || '-'}</span></td>
                  <td className="px-4 py-3 text-xs"><span className={u.balance > 0 ? 'text-green-400' : 'text-zinc-500'}>¥{(u.balance || 0).toFixed(2)}</span></td>
                  <td className="px-4 py-3 text-xs text-zinc-400">{u.usedToday}</td>
                  <td className="px-4 py-3">{u.isActive ? <span className="text-xs text-green-400">启用</span> : <span className="text-xs text-red-400">禁用</span>}</td>
                  <td className="px-4 py-3 flex items-center gap-2">
                    <button onClick={() => setEditUser({ ...u })} className="text-[10px] px-2.5 py-1 bg-white/5 hover:bg-white/10 rounded-lg text-zinc-300 transition-colors">编辑</button>
                    <button onClick={() => handleDelete(u.id)} className="text-[10px] px-2.5 py-1 bg-red-500/10 hover:bg-red-500/20 rounded-lg text-red-400 transition-colors">删除</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="p-2 bg-white/5 rounded-lg disabled:opacity-30"><ChevronLeft className="w-4 h-4" /></button>
          <span className="text-xs text-zinc-400 px-3">{page} / {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="p-2 bg-white/5 rounded-lg disabled:opacity-30"><ChevronRight className="w-4 h-4" /></button>
        </div>
      )}

      {/* Edit Modal */}
      {editUser && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setEditUser(null)}>
          <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-5">编辑用户: {editUser.username || editUser.email}</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">等级</label>
                <select value={editUser.tierId} onChange={e => setEditUser({ ...editUser, tierId: parseInt(e.target.value) })} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none">
                  {tiers.map((t: any) => <option key={t.id} value={t.id}>{t.displayName}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">过期时间 (留空=永久)</label>
                <input type="date" value={editUser.tierExpiresAt?.split('T')[0] || ''} onChange={e => setEditUser({ ...editUser, tierExpiresAt: e.target.value || null })} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none" />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">配额覆盖 (留空=使用等级默认)</label>
                <input type="number" value={editUser.quotaOverride || ''} onChange={e => setEditUser({ ...editUser, quotaOverride: e.target.value })} placeholder="例: 50" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none placeholder:text-zinc-600" />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5 font-medium flex items-center justify-between">
                  <span>💰 账户余额 (元)</span>
                  <span className="text-[10px] text-zinc-500 font-normal">点击下方按钮快捷充值</span>
                </label>
                <input type="number" value={editUser.balance ?? 0} onChange={e => setEditUser({ ...editUser, balance: e.target.value })} step="0.01" min="0" placeholder="0.00" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none placeholder:text-zinc-600" />
                <div className="flex gap-1.5 mt-2">
                  {[10, 50, 100, 500, 1000].map(amount => (
                    <button
                      key={amount}
                      type="button"
                      onClick={() => {
                        const current = parseFloat(editUser.balance) || 0;
                        setEditUser({ ...editUser, balance: (current + amount).toFixed(2) });
                      }}
                      className="flex-1 py-1 bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 rounded-lg text-[10px] font-medium transition-colors border border-blue-500/15"
                    >
                      +{amount}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      const amountStr = prompt('请输入充值金额（输入正数增加，负数扣减）：');
                      if (amountStr) {
                        const amount = parseFloat(amountStr);
                        if (!isNaN(amount)) {
                          const current = parseFloat(editUser.balance) || 0;
                          setEditUser({ ...editUser, balance: Math.max(0, current + amount).toFixed(2) });
                        }
                      }
                    }}
                    className="px-2.5 py-1 bg-zinc-500/10 hover:bg-zinc-500/20 text-zinc-300 rounded-lg text-[10px] font-medium transition-colors border border-zinc-500/15"
                  >
                    自定义
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">重置密码 (留空则不修改)</label>
                <input type="text" value={editUser.password || ''} onChange={e => setEditUser({ ...editUser, password: e.target.value })} placeholder="输入新密码(至少6位)" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none placeholder:text-zinc-600" />
              </div>
              <div className="flex items-center gap-3">
                <label className="text-xs text-zinc-400">账号状态</label>
                <button onClick={() => setEditUser({ ...editUser, isActive: editUser.isActive ? 0 : 1 })} className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${editUser.isActive ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                  {editUser.isActive ? '✅ 启用' : '🚫 禁用'}
                </button>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setEditUser(null)} className="flex-1 py-2.5 bg-white/5 hover:bg-white/10 rounded-xl text-sm transition-colors">取消</button>
              <button onClick={handleUpdate} className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-medium transition-colors">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* Create User Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setShowCreate(false)}>
          <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-5">创建新用户</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">邮箱 *</label>
                <input type="email" value={newUser.email} onChange={e => setNewUser({ ...newUser, email: e.target.value })} placeholder="user@example.com" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none placeholder:text-zinc-600" />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">用户名</label>
                <input type="text" value={newUser.username} onChange={e => setNewUser({ ...newUser, username: e.target.value })} placeholder="留空则自动从邮箱提取" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none placeholder:text-zinc-600" />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">密码 *</label>
                <input type="text" value={newUser.password} onChange={e => setNewUser({ ...newUser, password: e.target.value })} placeholder="至少6位" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none placeholder:text-zinc-600" />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">等级</label>
                <select value={newUser.tierId} onChange={e => setNewUser({ ...newUser, tierId: e.target.value })} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none">
                  <option value="">默认等级</option>
                  {tiers.map((t: any) => <option key={t.id} value={t.id}>{t.displayName}</option>)}
                </select>
              </div>
              {createError && <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2 text-sm text-red-400">{createError}</div>}
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowCreate(false)} className="flex-1 py-2.5 bg-white/5 hover:bg-white/10 rounded-xl text-sm transition-colors">取消</button>
              <button onClick={handleCreate} className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-medium transition-colors">创建</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
