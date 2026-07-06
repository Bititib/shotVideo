import React, { useEffect, useState } from 'react';
import { adminApi } from '../../api/admin';
import { Plus, Key, Trash2, Pencil, Copy, Power, PowerOff, Check } from 'lucide-react';

export default function TokensPage() {
  const [data, setData] = useState<{ items: any[]; total: number }>({ items: [], total: 0 });
  const [userList, setUserList] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [newTokenKey, setNewTokenKey] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const tokensData = await adminApi.getTokens();
      const usersData = await adminApi.getUsers({ pageSize: 1000 });
      setData(tokensData);
      setUserList(usersData.items || []);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const openNew = () => setEdit({
    name: '', allowedModels: [], balance: -1, rateLimit: -1, expiresAt: '', isNew: true,
    modelsText: '', userId: '',
  });

  const openEdit = (t: any) => setEdit({
    ...t, isNew: false,
    modelsText: (t.allowedModels || []).join('\n'),
    userId: t.userId || '',
  });

  const handleSave = async () => {
    if (!edit) return;
    try {
      const allowedModels = edit.modelsText.split('\n').map((s: string) => s.trim()).filter(Boolean);
      const payload: any = {
        name: edit.name,
        allowedModels,
        balance: parseFloat(edit.balance) || -1,
        rateLimit: parseInt(edit.rateLimit) || -1,
        expiresAt: edit.expiresAt || null,
        userId: edit.userId ? parseInt(edit.userId) : null,
      };

      if (edit.isNew) {
        const result = await adminApi.createToken(payload);
        setNewTokenKey(result.tokenKey);
      } else {
        if (edit.status !== undefined) payload.status = edit.status;
        await adminApi.updateToken(edit.id, payload);
      }
      setEdit(null); load();
    } catch (e: any) { alert(e.message); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('确定删除此 Token？')) return;
    try { await adminApi.deleteToken(id); load(); } catch (e: any) { alert(e.message); }
  };

  const toggleStatus = async (t: any) => {
    try { await adminApi.updateToken(t.id, { status: t.status ? 0 : 1 }); load(); }
    catch (e: any) { alert(e.message); }
  };

  const copyToken = (tokenKey: string, id: number) => {
    navigator.clipboard.writeText(tokenKey);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-2 border-white/10 border-t-white rounded-full animate-spin" /></div>;

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">🔑 Token 管理</h1>
        <button onClick={openNew} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-medium transition-colors">
          <Plus className="w-4 h-4" /> 新建 Token
        </button>
      </div>

      {/* 新创建 Token 提示 */}
      {newTokenKey && (
        <div className="mb-6 bg-green-500/10 border border-green-500/30 rounded-2xl p-4">
          <p className="text-sm text-green-400 mb-2">✅ Token 创建成功！请立即复制保存，此 Token 仅展示一次：</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-black/30 rounded-lg px-4 py-2 text-sm text-green-300 font-mono break-all">{newTokenKey}</code>
            <button onClick={() => { navigator.clipboard.writeText(newTokenKey); }} className="px-3 py-2 bg-green-600 hover:bg-green-500 rounded-lg text-sm">
              <Copy className="w-4 h-4" />
            </button>
          </div>
          <button onClick={() => setNewTokenKey(null)} className="mt-2 text-xs text-zinc-400 hover:text-zinc-300">我已保存，关闭提示</button>
        </div>
      )}

      <div className="space-y-4">
        {data.items.map(t => (
          <div key={t.id} className={`bg-white/[0.02] border rounded-2xl p-5 ${t.status ? 'border-white/5' : 'border-red-500/20 opacity-60'}`}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500/20 to-orange-500/20 flex items-center justify-center border border-white/5">
                  <Key className="w-5 h-5 text-amber-400" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">{t.name || '未命名 Token'}</h3>
                  <div className="flex items-center gap-2">
                    <code className="text-[10px] text-zinc-500 font-mono">{t.tokenKeyMasked}</code>
                    <button onClick={() => copyToken(t.tokenKey, t.id)} className="text-zinc-500 hover:text-zinc-300">
                      {copiedId === t.id ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                    </button>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => toggleStatus(t)} className={`p-1.5 rounded-lg transition-colors ${t.status ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                  {t.status ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
                </button>
                <button onClick={() => openEdit(t)} className="text-[10px] px-3 py-1 bg-white/5 hover:bg-white/10 rounded-lg text-zinc-300"><Pencil className="w-3 h-3 inline mr-1" />编辑</button>
                <button onClick={() => handleDelete(t.id)} className="text-[10px] px-3 py-1 bg-red-500/10 hover:bg-red-500/20 rounded-lg text-red-400"><Trash2 className="w-3 h-3 inline mr-1" />删除</button>
              </div>
            </div>
            <div className="flex flex-wrap gap-4 text-xs text-zinc-400">
              <span>用户: <span className="text-zinc-300">{t.userName || t.userEmail || '系统'}</span></span>
              <span>余额: <span className={t.balance === -1 ? 'text-green-400' : t.balance > 0 ? 'text-zinc-300' : 'text-red-400'}>
                {t.balance === -1 ? '无限' : `¥${t.balance.toFixed(2)}`}
              </span></span>
              <span>已用: <span className="text-zinc-300">¥{t.usedAmount.toFixed(2)}</span></span>
              <span>频率限制: <span className="text-zinc-300">{t.rateLimit === -1 ? '不限' : `${t.rateLimit}/min`}</span></span>
              <span>模型: <span className="text-zinc-300">{t.allowedModels.length === 0 ? '全部' : t.allowedModels.join(', ')}</span></span>
              {t.expiresAt && <span>过期: <span className="text-zinc-300">{t.expiresAt.slice(0, 10)}</span></span>}
            </div>
          </div>
        ))}
        {data.items.length === 0 && <div className="text-center text-zinc-500 py-12">暂无 Token，点击上方按钮创建</div>}
      </div>

      {/* Edit Modal */}
      {edit && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setEdit(null)}>
          <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-6 w-full max-w-lg" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-5">{edit.isNew ? '新建 Token' : `编辑: ${edit.name || 'Token'}`}</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Token 名称（备注）</label>
                <input type="text" value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} placeholder="如：前端测试用"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none" />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">关联用户</label>
                <select value={edit.userId || ''} onChange={e => setEdit({ ...edit, userId: e.target.value })}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none">
                  <option value="" className="bg-[#1a1a1a]">系统级 Token (不关联任何用户)</option>
                  {userList.map(u => (
                    <option key={u.id} value={u.id} className="bg-[#1a1a1a]">
                      {u.username || u.email} ({u.email})
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5 font-medium flex items-center justify-between">
                    <span>额度（元，-1=无限）</span>
                    <span className="text-[10px] text-zinc-500 font-normal">快捷充值</span>
                  </label>
                  <input type="number" value={edit.balance} onChange={e => setEdit({ ...edit, balance: e.target.value })} step="0.01"
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none" />
                  <div className="flex gap-1.5 mt-2">
                    {[50, 100, 500].map(amount => (
                      <button
                        key={amount}
                        type="button"
                        onClick={() => {
                          const current = parseFloat(edit.balance);
                          const base = isNaN(current) || current === -1 ? 0 : current;
                          setEdit({ ...edit, balance: (base + amount).toFixed(2) });
                        }}
                        className="flex-1 py-1 bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 rounded-lg text-[10px] font-medium transition-colors border border-blue-500/15 text-center"
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
                            const current = parseFloat(edit.balance);
                            const base = isNaN(current) || current === -1 ? 0 : current;
                            setEdit({ ...edit, balance: Math.max(-1, base + amount).toFixed(2) });
                          }
                        }
                      }}
                      className="px-2 py-1 bg-zinc-500/10 hover:bg-zinc-500/20 text-zinc-300 rounded-lg text-[10px] font-medium transition-colors border border-zinc-500/15 text-center"
                    >
                      自定义
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">频率限制（次/分，-1=不限）</label>
                  <input type="number" value={edit.rateLimit} onChange={e => setEdit({ ...edit, rateLimit: e.target.value })}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">过期时间（留空=永久）</label>
                <input type="datetime-local" value={edit.expiresAt?.slice(0, 16) || ''} onChange={e => setEdit({ ...edit, expiresAt: e.target.value })}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none" />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">可用模型（每行一个，留空=全部模型）</label>
                <textarea value={edit.modelsText} onChange={e => setEdit({ ...edit, modelsText: e.target.value })} rows={3}
                  placeholder={"grok-4\ngrok-imagine-video"}
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
