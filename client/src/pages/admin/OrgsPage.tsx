import React, { useEffect, useState, useCallback } from 'react';
import { adminApi } from '../../api/admin';
import { Search, ChevronLeft, ChevronRight, X, Building2, UserPlus, Users, Wallet, Crown } from 'lucide-react';

export default function OrgsPage() {
  const [orgs, setOrgs] = useState<any[]>([]);
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [tiers, setTiers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editOrg, setEditOrg] = useState<any>(null);
  const [newOrg, setNewOrg] = useState({ name: '', slug: '', ownerId: '', tierId: '', balance: '0', maxMembers: '10' });
  const [createError, setCreateError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [orgData, userData, tierData] = await Promise.all([
        adminApi.getOrgs(),
        adminApi.getUsers({ pageSize: 200 }),
        adminApi.getTiers(),
      ]);
      setOrgs(orgData);
      setAllUsers(userData.items || []);
      setTiers(tierData);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!newOrg.name || !newOrg.slug || !newOrg.ownerId) {
      setCreateError('名称、标识和拥有者不能为空');
      return;
    }
    setCreateError('');
    try {
      await adminApi.createOrg({
        name: newOrg.name,
        slug: newOrg.slug,
        ownerId: parseInt(newOrg.ownerId),
        tierId: newOrg.tierId ? parseInt(newOrg.tierId) : undefined,
        balance: parseFloat(newOrg.balance) || 0,
        maxMembers: parseInt(newOrg.maxMembers) || 10,
      });
      setShowCreate(false);
      setNewOrg({ name: '', slug: '', ownerId: '', tierId: '', balance: '0', maxMembers: '10' });
      load();
    } catch (e: any) { setCreateError(e.message); }
  };

  const handleUpdate = async () => {
    if (!editOrg) return;
    try {
      await adminApi.updateOrg(editOrg.id, {
        name: editOrg.name,
        tierId: editOrg.tierId,
        balance: parseFloat(editOrg.balance) || 0,
        maxMembers: parseInt(editOrg.maxMembers) || 10,
        isActive: editOrg.isActive,
      });
      setEditOrg(null);
      load();
    } catch (e: any) { alert(e.message); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('确定删除此组织？将同时解除所有成员关联')) return;
    try { await adminApi.deleteOrg(id); load(); } catch (e: any) { alert(e.message); }
  };

  const slugify = (text: string) => text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '');

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">🏢 组织管理</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500">共 {orgs.length} 个组织</span>
          <button onClick={() => setShowCreate(true)} className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-medium transition-colors">
            <Building2 className="w-4 h-4" /> 创建组织
          </button>
        </div>
      </div>

      {/* Org Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        {loading ? (
          <div className="col-span-2 flex justify-center py-12"><div className="w-6 h-6 border-2 border-white/10 border-t-white rounded-full animate-spin" /></div>
        ) : orgs.length === 0 ? (
          <div className="col-span-2 text-center py-12 text-zinc-500 text-sm">暂无组织，点击上方按钮创建</div>
        ) : orgs.map(org => (
          <div key={org.id} className="bg-white/[0.02] border border-white/5 rounded-2xl p-5 hover:border-white/10 transition-colors">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-base font-semibold text-white flex items-center gap-2">
                  {org.name}
                  {org.isActive ? (
                    <span className="text-[10px] px-1.5 py-0.5 bg-green-500/10 text-green-400 rounded-md">启用</span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 bg-red-500/10 text-red-400 rounded-md">禁用</span>
                  )}
                </h3>
                <p className="text-xs text-zinc-500 mt-0.5 font-mono">{org.slug}</p>
              </div>
              <div className="flex gap-1.5">
                <button onClick={() => setEditOrg({ ...org })} className="text-[10px] px-2.5 py-1 bg-white/5 hover:bg-white/10 rounded-lg text-zinc-300 transition-colors">编辑</button>
                <button onClick={() => handleDelete(org.id)} className="text-[10px] px-2.5 py-1 bg-red-500/10 hover:bg-red-500/20 rounded-lg text-red-400 transition-colors">删除</button>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-3">
              <div className="bg-white/[0.02] rounded-xl p-3 text-center">
                <Users className="w-3.5 h-3.5 text-blue-400 mx-auto mb-1" />
                <p className="text-lg font-bold text-white">{org.memberCount}</p>
                <p className="text-[9px] text-zinc-500">成员</p>
              </div>
              <div className="bg-white/[0.02] rounded-xl p-3 text-center">
                <Wallet className="w-3.5 h-3.5 text-green-400 mx-auto mb-1" />
                <p className="text-lg font-bold text-white">¥{(org.balance || 0).toFixed(0)}</p>
                <p className="text-[9px] text-zinc-500">余额</p>
              </div>
              <div className="bg-white/[0.02] rounded-xl p-3 text-center">
                <Crown className="w-3.5 h-3.5 text-purple-400 mx-auto mb-1" />
                <p className="text-xs font-medium text-purple-400">{org.tierName}</p>
                <p className="text-[9px] text-zinc-500">等级</p>
              </div>
              <div className="bg-white/[0.02] rounded-xl p-3 text-center">
                <UserPlus className="w-3.5 h-3.5 text-amber-400 mx-auto mb-1" />
                <p className="text-xs font-medium text-zinc-300 truncate">{org.ownerEmail}</p>
                <p className="text-[9px] text-zinc-500">Owner</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setShowCreate(false)}>
          <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-5">创建新组织</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">组织名称 *</label>
                <input type="text" value={newOrg.name} onChange={e => {
                  setNewOrg({ ...newOrg, name: e.target.value, slug: slugify(e.target.value) });
                }} placeholder="如: 某某科技有限公司" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none placeholder:text-zinc-600" />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">标识（slug）*</label>
                <input type="text" value={newOrg.slug} onChange={e => setNewOrg({ ...newOrg, slug: e.target.value })} placeholder="如: acme-corp" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none placeholder:text-zinc-600 font-mono" />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">拥有者（企业管理员） *</label>
                <select value={newOrg.ownerId} onChange={e => setNewOrg({ ...newOrg, ownerId: e.target.value })} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none">
                  <option value="">选择用户...</option>
                  {allUsers.filter(u => !u.orgId).map(u => (
                    <option key={u.id} value={u.id}>{u.email} ({u.username})</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">等级</label>
                  <select value={newOrg.tierId} onChange={e => setNewOrg({ ...newOrg, tierId: e.target.value })} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none">
                    <option value="">默认</option>
                    {tiers.map((t: any) => <option key={t.id} value={t.id}>{t.displayName}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">初始余额 (¥)</label>
                  <input type="number" value={newOrg.balance} onChange={e => setNewOrg({ ...newOrg, balance: e.target.value })} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">最大成员数</label>
                <input type="number" value={newOrg.maxMembers} onChange={e => setNewOrg({ ...newOrg, maxMembers: e.target.value })} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none" />
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

      {/* Edit Modal */}
      {editOrg && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setEditOrg(null)}>
          <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-5">编辑组织: {editOrg.name}</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">名称</label>
                <input type="text" value={editOrg.name} onChange={e => setEditOrg({ ...editOrg, name: e.target.value })} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">等级</label>
                  <select value={editOrg.tierId} onChange={e => setEditOrg({ ...editOrg, tierId: parseInt(e.target.value) })} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none">
                    {tiers.map((t: any) => <option key={t.id} value={t.id}>{t.displayName}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">💰 余额 (¥)</label>
                  <input type="number" value={editOrg.balance ?? 0} onChange={e => setEditOrg({ ...editOrg, balance: e.target.value })} step="0.01" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">最大成员数</label>
                <input type="number" value={editOrg.maxMembers} onChange={e => setEditOrg({ ...editOrg, maxMembers: e.target.value })} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none" />
              </div>
              <div className="flex items-center gap-3">
                <label className="text-xs text-zinc-400">状态</label>
                <button onClick={() => setEditOrg({ ...editOrg, isActive: editOrg.isActive ? 0 : 1 })} className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${editOrg.isActive ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                  {editOrg.isActive ? '✅ 启用' : '🚫 禁用'}
                </button>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setEditOrg(null)} className="flex-1 py-2.5 bg-white/5 hover:bg-white/10 rounded-xl text-sm transition-colors">取消</button>
              <button onClick={handleUpdate} className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-medium transition-colors">保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
