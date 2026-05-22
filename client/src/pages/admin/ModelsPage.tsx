import React, { useEffect, useState } from 'react';
import { adminApi } from '../../api/admin';
import { Plus, Cpu, Power, PowerOff } from 'lucide-react';

export default function ModelsPage() {
  const [models, setModels] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => { setLoading(true); setModels(await adminApi.getModels()); setLoading(false); };
  useEffect(() => { load(); }, []);

  const openNew = () => setEdit({ provider: 'google', modelId: '', displayName: '', apiKey: '', capabilities: ['text'], isActive: 1, isNew: true });
  const openEdit = (m: any) => setEdit({ ...m, apiKey: '', isNew: false }); // apiKey is masked, user must re-enter

  const handleSave = async () => {
    if (!edit) return;
    try {
      const data: any = { provider: edit.provider, modelId: edit.modelId, displayName: edit.displayName, capabilities: edit.capabilities, isActive: edit.isActive };
      if (edit.apiKey) data.apiKey = edit.apiKey; // Only send if user entered a new key
      if (edit.isNew) { await adminApi.createModel(data); } else { await adminApi.updateModel(edit.id, data); }
      setEdit(null); load();
    } catch (e: any) { alert(e.message); }
  };

  const handleDelete = async (id: number) => { if (!confirm('确定删除此模型？')) return; try { await adminApi.deleteModel(id); load(); } catch (e: any) { alert(e.message); } };

  const toggleActive = async (m: any) => {
    try { await adminApi.updateModel(m.id, { isActive: m.isActive ? 0 : 1 }); load(); } catch (e: any) { alert(e.message); }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-2 border-white/10 border-t-white rounded-full animate-spin" /></div>;

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">🤖 大模型管理</h1>
        <button onClick={openNew} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-medium transition-colors"><Plus className="w-4 h-4" /> 添加模型</button>
      </div>

      <div className="space-y-4">
        {models.map(m => (
          <div key={m.id} className={`bg-white/[0.02] border rounded-2xl p-5 ${m.isActive ? 'border-white/5' : 'border-red-500/20 opacity-60'}`}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500/20 to-purple-500/20 flex items-center justify-center border border-white/5">
                  <Cpu className="w-5 h-5 text-blue-400" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">{m.displayName}</h3>
                  <p className="text-[10px] text-zinc-500">{m.provider} · {m.modelId}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => toggleActive(m)} className={`p-1.5 rounded-lg transition-colors ${m.isActive ? 'bg-green-500/10 text-green-400 hover:bg-green-500/20' : 'bg-red-500/10 text-red-400 hover:bg-red-500/20'}`}>
                  {m.isActive ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
                </button>
                <button onClick={() => openEdit(m)} className="text-[10px] px-3 py-1 bg-white/5 hover:bg-white/10 rounded-lg text-zinc-300">编辑</button>
                <button onClick={() => handleDelete(m.id)} className="text-[10px] px-3 py-1 bg-red-500/10 hover:bg-red-500/20 rounded-lg text-red-400">删除</button>
              </div>
            </div>
            <div className="flex flex-wrap gap-4 text-xs text-zinc-400">
              <span>能力: <span className="text-zinc-300">{Array.isArray(m.capabilities) ? m.capabilities.join(', ') : '-'}</span></span>
              <span>API Key: <span className="text-zinc-300 font-mono">{m.apiKey || '使用全局Key'}</span></span>
              <span>累计调用: <span className="text-zinc-300">{m.totalCalls?.toLocaleString() || 0}次</span></span>
              <span>状态: {m.isActive ? <span className="text-green-400">启用</span> : <span className="text-red-400">禁用</span>}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Edit Modal */}
      {edit && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setEdit(null)}>
          <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-6 w-full max-w-lg" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-5">{edit.isNew ? '添加新模型' : `编辑: ${edit.displayName}`}</h3>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">供应商</label>
                  <select value={edit.provider} onChange={e => setEdit({ ...edit, provider: e.target.value })} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none">
                    <option value="google">Google</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="grok">Grok (xAI)</option><option value="other">其他</option>
                  </select>
                </div>
                <div><label className="block text-xs text-zinc-400 mb-1.5">模型ID</label><input type="text" value={edit.modelId} onChange={e => setEdit({ ...edit, modelId: e.target.value })} placeholder="gemini-2.5-pro" disabled={!edit.isNew} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none disabled:opacity-50" /></div>
              </div>
              <div><label className="block text-xs text-zinc-400 mb-1.5">显示名称</label><input type="text" value={edit.displayName} onChange={e => setEdit({ ...edit, displayName: e.target.value })} placeholder="Gemini 2.5 Pro" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none" /></div>
              <div><label className="block text-xs text-zinc-400 mb-1.5">API Key (留空=使用全局 .env Key)</label><input type="password" value={edit.apiKey} onChange={e => setEdit({ ...edit, apiKey: e.target.value })} placeholder={edit.isNew ? '可选' : '留空=不修改'} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none placeholder:text-zinc-600" /></div>
              <div>
                <label className="block text-xs text-zinc-400 mb-2">能力</label>
                <div className="flex gap-2">
                  {['text', 'image', 'image_gen', 'video'].map(cap => (
                    <button key={cap} onClick={() => setEdit({ ...edit, capabilities: edit.capabilities.includes(cap) ? edit.capabilities.filter((c: string) => c !== cap) : [...edit.capabilities, cap] })}
                      className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${edit.capabilities.includes(cap) ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'bg-white/5 text-zinc-400 border border-white/5'}`}>{cap === 'text' ? '文本分析' : cap === 'image' ? '图片分析' : cap === 'image_gen' ? '图像生成' : '视频生成'}</button>
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
