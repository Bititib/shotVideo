import React, { useEffect, useState } from 'react';
import { adminApi } from '../../api/admin';
import { Plus, X } from 'lucide-react';

const featureOptions = [
  { id: 'general', label: '通用分析' }, { id: 'ecommerce', label: '带货分析' }, { id: 'image', label: '图片逆向' },
  { id: 'copywriting', label: '电商文案' }, { id: 'account', label: '账号分析' }, { id: 'generate_image', label: 'AI生图' }, { id: 'modify_prompt', label: '换品' },
];

export default function TiersPage() {
  const [tiers, setTiers] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const [t, m] = await Promise.all([adminApi.getTiers(), adminApi.getModels()]);
    setTiers(t); setModels(m); setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const openNew = () => setEdit({ name: '', displayName: '', dailyQuota: 10, allowedFeatures: [], modelIds: [], sortOrder: tiers.length, isNew: true });
  const openEdit = (t: any) => setEdit({ ...t, modelIds: t.models?.map((m: any) => m.modelId) || [], isNew: false });

  const handleSave = async () => {
    if (!edit) return;
    try {
      const data = { name: edit.name, displayName: edit.displayName, dailyQuota: edit.dailyQuota, allowedFeatures: edit.allowedFeatures, sortOrder: edit.sortOrder, modelIds: edit.modelIds };
      if (edit.isNew) { await adminApi.createTier(data); } else { await adminApi.updateTier(edit.id, data); }
      setEdit(null); load();
    } catch (e: any) { alert(e.message); }
  };

  const handleDelete = async (id: number) => { if (!confirm('确定删除？有用户使用中的等级无法删除。')) return; try { await adminApi.deleteTier(id); load(); } catch (e: any) { alert(e.message); } };

  const tierColors: Record<string, string> = { free: 'border-zinc-500/30', basic: 'border-yellow-500/30', pro: 'border-blue-500/30', enterprise: 'border-purple-500/30' };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-2 border-white/10 border-t-white rounded-full animate-spin" /></div>;

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">⭐ 等级配置</h1>
        <button onClick={openNew} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-medium transition-colors"><Plus className="w-4 h-4" /> 新增等级</button>
      </div>

      <div className="space-y-4">
        {tiers.map(t => (
          <div key={t.id} className={`bg-white/[0.02] border ${tierColors[t.name] || 'border-white/5'} rounded-2xl p-5`}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <h3 className="text-base font-semibold text-white">{t.displayName}</h3>
                <span className="text-[10px] text-zinc-500 bg-white/5 px-2 py-0.5 rounded">{t.name}</span>
                <span className="text-[10px] text-zinc-500">{t.userCount} 用户</span>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => openEdit(t)} className="text-[10px] px-3 py-1 bg-white/5 hover:bg-white/10 rounded-lg text-zinc-300">编辑</button>
                <button onClick={() => handleDelete(t.id)} className="text-[10px] px-3 py-1 bg-red-500/10 hover:bg-red-500/20 rounded-lg text-red-400">删除</button>
              </div>
            </div>
            <div className="flex flex-wrap gap-4 text-xs text-zinc-400">
              <span>配额: <span className="text-white font-medium">{t.dailyQuota === -1 ? '不限' : `${t.dailyQuota}次/天`}</span></span>
              <span>功能: <span className="text-zinc-300">{Array.isArray(t.allowedFeatures) ? (t.allowedFeatures.includes('*') ? '全部' : t.allowedFeatures.join(', ')) : '-'}</span></span>
              <span>模型: <span className="text-zinc-300">{t.models?.map((m: any) => m.modelName).join(', ') || '无'}</span></span>
            </div>
          </div>
        ))}
      </div>

      {/* Edit Modal */}
      {edit && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setEdit(null)}>
          <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-5">{edit.isNew ? '新增等级' : `编辑: ${edit.displayName}`}</h3>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block text-xs text-zinc-400 mb-1.5">等级标识</label><input type="text" value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} placeholder="如: vip" disabled={!edit.isNew} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none disabled:opacity-50" /></div>
                <div><label className="block text-xs text-zinc-400 mb-1.5">显示名称</label><input type="text" value={edit.displayName} onChange={e => setEdit({ ...edit, displayName: e.target.value })} placeholder="如: VIP会员" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none" /></div>
              </div>
              <div><label className="block text-xs text-zinc-400 mb-1.5">每日配额 (-1=不限)</label><input type="number" value={edit.dailyQuota} onChange={e => setEdit({ ...edit, dailyQuota: parseInt(e.target.value) })} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none" /></div>
              <div>
                <label className="block text-xs text-zinc-400 mb-2">允许功能</label>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => setEdit({ ...edit, allowedFeatures: edit.allowedFeatures.includes('*') ? [] : ['*'] })} className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${edit.allowedFeatures.includes('*') ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' : 'bg-white/5 text-zinc-400 border border-white/5'}`}>全部 (*)</button>
                  {featureOptions.map(f => (
                    <button key={f.id} onClick={() => { const af = edit.allowedFeatures.filter((x: string) => x !== '*'); setEdit({ ...edit, allowedFeatures: af.includes(f.id) ? af.filter((x: string) => x !== f.id) : [...af, f.id] }); }}
                      className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${edit.allowedFeatures.includes(f.id) || edit.allowedFeatures.includes('*') ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'bg-white/5 text-zinc-400 border border-white/5'}`}>{f.label}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-2">可用模型</label>
                <div className="flex flex-wrap gap-2">
                  {models.map((m: any) => (
                    <button key={m.id} onClick={() => setEdit({ ...edit, modelIds: edit.modelIds.includes(m.id) ? edit.modelIds.filter((x: number) => x !== m.id) : [...edit.modelIds, m.id] })}
                      className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${edit.modelIds.includes(m.id) ? 'bg-green-500/20 text-green-300 border border-green-500/30' : 'bg-white/5 text-zinc-400 border border-white/5'}`}>{m.displayName}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setEdit(null)} className="flex-1 py-2.5 bg-white/5 hover:bg-white/10 rounded-xl text-sm transition-colors">取消</button>
              <button onClick={handleSave} className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-medium transition-colors">保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
