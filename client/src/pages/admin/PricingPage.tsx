import React, { useEffect, useState } from 'react';
import { adminApi } from '../../api/admin';
import { Plus, Coins, Trash2, Pencil } from 'lucide-react';

export default function PricingPage() {
  const [rules, setRules] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => { setLoading(true); setRules(await adminApi.getPricing()); setLoading(false); };
  useEffect(() => { load(); }, []);

  const openNew = () => setEdit({
    modelPattern: '', billingType: 'per_call', inputPrice: 0, outputPrice: 0, extraParams: {}, isNew: true,
    extraText: '',
  });

  const openEdit = (r: any) => setEdit({
    ...r, isNew: false,
    extraText: Object.entries(r.extraParams || {}).map(([k, v]) => `${k}:${v}`).join('\n'),
  });

  const handleSave = async () => {
    if (!edit) return;
    try {
      const extraParams: Record<string, number> = {};
      edit.extraText.split('\n').filter(Boolean).forEach((line: string) => {
        const [k, v] = line.split(':').map((s: string) => s.trim());
        if (k && v) extraParams[k] = parseFloat(v);
      });

      const data = {
        modelPattern: edit.modelPattern,
        billingType: edit.billingType,
        inputPrice: parseFloat(edit.inputPrice) || 0,
        outputPrice: parseFloat(edit.outputPrice) || 0,
        extraParams,
      };

      if (edit.isNew) await adminApi.createPricing(data);
      else await adminApi.updatePricing(edit.id, data);
      setEdit(null); load();
    } catch (e: any) { alert(e.message); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('确定删除此计费规则？')) return;
    try { await adminApi.deletePricing(id); load(); } catch (e: any) { alert(e.message); }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-2 border-white/10 border-t-white rounded-full animate-spin" /></div>;

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">💰 计费设置</h1>
        <button onClick={openNew} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-medium transition-colors">
          <Plus className="w-4 h-4" /> 添加规则
        </button>
      </div>

      <div className="space-y-4">
        {rules.map(r => (
          <div key={r.id} className="bg-white/[0.02] border border-white/5 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-yellow-500/20 to-amber-500/20 flex items-center justify-center border border-white/5">
                  <Coins className="w-5 h-5 text-yellow-400" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white font-mono">{r.modelPattern}</h3>
                  <p className="text-[10px] text-zinc-500">
                    {r.billingType === 'per_call' ? '按次计费' : '按 Token 计费'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => openEdit(r)} className="text-[10px] px-3 py-1 bg-white/5 hover:bg-white/10 rounded-lg text-zinc-300"><Pencil className="w-3 h-3 inline mr-1" />编辑</button>
                <button onClick={() => handleDelete(r.id)} className="text-[10px] px-3 py-1 bg-red-500/10 hover:bg-red-500/20 rounded-lg text-red-400"><Trash2 className="w-3 h-3 inline mr-1" />删除</button>
              </div>
            </div>
            <div className="flex flex-wrap gap-4 text-xs text-zinc-400">
              {r.billingType === 'per_call' ? (
                <span>单次价格: <span className="text-yellow-400">¥{r.inputPrice}</span></span>
              ) : (
                <>
                  <span>输入: <span className="text-yellow-400">¥{r.inputPrice}/1M tokens</span></span>
                  <span>输出: <span className="text-yellow-400">¥{r.outputPrice}/1M tokens</span></span>
                </>
              )}
              {Object.keys(r.extraParams || {}).length > 0 && (
                <span>额外: <span className="text-zinc-300">{Object.entries(r.extraParams).map(([k, v]) => `${k}=¥${v}`).join(', ')}</span></span>
              )}
            </div>
          </div>
        ))}
        {rules.length === 0 && <div className="text-center text-zinc-500 py-12">暂无计费规则</div>}
      </div>

      {/* Edit Modal */}
      {edit && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setEdit(null)}>
          <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-5">{edit.isNew ? '添加计费规则' : '编辑计费规则'}</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">模型匹配（* = 全局默认）</label>
                <input type="text" value={edit.modelPattern} onChange={e => setEdit({ ...edit, modelPattern: e.target.value })} placeholder="grok-imagine-video 或 *"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none font-mono" />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">计费类型</label>
                <select value={edit.billingType} onChange={e => setEdit({ ...edit, billingType: e.target.value })}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none">
                  <option value="per_call">按次计费 (per_call)</option>
                  <option value="per_token">按 Token 计费 (per_token)</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">
                    {edit.billingType === 'per_call' ? '每次价格 (¥)' : '输入价格 (¥/1M tokens)'}
                  </label>
                  <input type="number" value={edit.inputPrice} onChange={e => setEdit({ ...edit, inputPrice: e.target.value })} step="0.001"
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">
                    {edit.billingType === 'per_call' ? '（不适用）' : '输出价格 (¥/1M tokens)'}
                  </label>
                  <input type="number" value={edit.outputPrice} onChange={e => setEdit({ ...edit, outputPrice: e.target.value })} step="0.001"
                    disabled={edit.billingType === 'per_call'}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none disabled:opacity-30" />
                </div>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">额外计费参数（如 20s:0.2 表示20秒视频每次¥0.2）</label>
                <textarea value={edit.extraText} onChange={e => setEdit({ ...edit, extraText: e.target.value })} rows={2}
                  placeholder="20s:0.2"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none font-mono resize-none" />
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
