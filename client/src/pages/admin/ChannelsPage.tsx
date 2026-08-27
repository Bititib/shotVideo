import React, { useEffect, useState } from 'react';
import { adminApi } from '../../api/admin';
import { Plus, Radio, Trash2, Pencil, Zap, Loader2, Power, PowerOff, RefreshCw } from 'lucide-react';

export default function ChannelsPage() {
  const [channels, setChannels] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState<number | null>(null);
  const [syncing, setSyncing] = useState<number | null>(null);

  const load = async () => { setLoading(true); setChannels(await adminApi.getChannels()); setLoading(false); };
  useEffect(() => { load(); }, []);

  const openNew = () => setEdit({
    name: '', type: 'openai', baseUrl: '', apiKey: '',
    modelMapping: {}, supportedModels: [],
    priority: 0, weight: 1, maxRetries: 3, timeout: 120000,
    isNew: true,
    // 临时 UI 字段
    mappingText: '',
    modelsText: '',
  });

  const openEdit = (ch: any) => setEdit({
    ...ch, apiKey: '', isNew: false,
    mappingText: Object.entries(ch.modelMapping || {}).map(([k, v]) => `${k}:${v}`).join('\n'),
    modelsText: (ch.supportedModels || []).join('\n'),
  });

  const handleSave = async () => {
    if (!edit) return;
    try {
      // 解析 mapping 和 models
      const modelMapping: Record<string, string> = {};
      edit.mappingText.split('\n').filter(Boolean).forEach((line: string) => {
        const [from, to] = line.split(':').map((s: string) => s.trim());
        if (from && to) modelMapping[from] = to;
      });
      const supportedModels = edit.modelsText.split('\n').map((s: string) => s.trim()).filter(Boolean);

      const data: any = {
        name: edit.name, type: edit.type, baseUrl: edit.baseUrl,
        modelMapping, supportedModels,
        priority: edit.priority, weight: edit.weight,
        maxRetries: edit.maxRetries, timeout: edit.timeout,
      };
      if (edit.apiKey) data.apiKey = edit.apiKey;
      if (edit.status !== undefined) data.status = edit.status;

      if (edit.isNew) await adminApi.createChannel(data);
      else await adminApi.updateChannel(edit.id, data);
      setEdit(null); load();
    } catch (e: any) { alert(e.message); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('确定删除此渠道？')) return;
    try { await adminApi.deleteChannel(id); load(); } catch (e: any) { alert(e.message); }
  };

  const handleTest = async (id: number) => {
    setTesting(id);
    try {
      const result = await adminApi.testChannel(id);
      alert(result.success ? `✅ 测试成功，耗时 ${result.durationMs}ms` : `❌ 测试失败：${result.message}`);
      load();
    } catch (e: any) { alert('测试出错: ' + e.message); }
    finally { setTesting(null); }
  };

  const toggleStatus = async (ch: any) => {
    try { await adminApi.updateChannel(ch.id, { status: ch.status ? 0 : 1 }); load(); }
    catch (e: any) { alert(e.message); }
  };

  const syncModels = async (ch: any) => {
    setSyncing(ch.id);
    try {
      const result = await adminApi.syncChannelModels(ch.id);
      alert(`同步完成：上游 ${result.count} 个模型，新增 ${result.added} 个模型配置`);
      load();
    } catch (e: any) { alert('同步失败: ' + e.message); }
    finally { setSyncing(null); }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-2 border-white/10 border-t-white rounded-full animate-spin" /></div>;

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">📡 渠道管理</h1>
        <button onClick={openNew} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-medium transition-colors">
          <Plus className="w-4 h-4" /> 添加渠道
        </button>
      </div>

      <div className="space-y-4">
        {channels.map(ch => (
          <div key={ch.id} className={`bg-white/[0.02] border rounded-2xl p-5 ${ch.status ? 'border-white/5' : 'border-red-500/20 opacity-60'}`}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center border border-white/5 ${ch.status ? 'bg-gradient-to-br from-green-500/20 to-emerald-500/20' : 'bg-gradient-to-br from-red-500/20 to-orange-500/20'}`}>
                  <Radio className={`w-5 h-5 ${ch.status ? 'text-green-400' : 'text-red-400'}`} />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">{ch.name}</h3>
                  <p className="text-[10px] text-zinc-500 font-mono"><span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold mr-1.5 ${ch.type === 'gemini' ? 'bg-emerald-500/15 text-emerald-400' : ch.type === 'grok2api' ? 'bg-orange-500/15 text-orange-400' : ch.type === 'hmstudio' ? 'bg-amber-500/15 text-amber-300' : 'bg-blue-500/15 text-blue-400'}`}>{ch.type === 'openai' ? 'OpenAI' : ch.type === 'gemini' ? 'Gemini' : ch.type === 'grok2api' ? 'Grok2API' : ch.type === 'hmstudio' ? 'HM Studio' : ch.type}</span>{ch.baseUrl}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => syncModels(ch)} disabled={syncing === ch.id}
                  className="flex items-center gap-1 text-[10px] px-3 py-1 bg-amber-500/10 hover:bg-amber-500/20 rounded-lg text-amber-300 disabled:opacity-50">
                  <RefreshCw className={`w-3 h-3 ${syncing === ch.id ? 'animate-spin' : ''}`} /> 同步模型
                </button>
                <button onClick={() => handleTest(ch.id)} disabled={testing === ch.id}
                  className="flex items-center gap-1 text-[10px] px-3 py-1 bg-yellow-500/10 hover:bg-yellow-500/20 rounded-lg text-yellow-400 disabled:opacity-50">
                  {testing === ch.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />} 测试
                </button>
                <button onClick={() => toggleStatus(ch)} className={`p-1.5 rounded-lg transition-colors ${ch.status ? 'bg-green-500/10 text-green-400 hover:bg-green-500/20' : 'bg-red-500/10 text-red-400 hover:bg-red-500/20'}`}>
                  {ch.status ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
                </button>
                <button onClick={() => openEdit(ch)} className="text-[10px] px-3 py-1 bg-white/5 hover:bg-white/10 rounded-lg text-zinc-300"><Pencil className="w-3 h-3 inline mr-1" />编辑</button>
                <button onClick={() => handleDelete(ch.id)} className="text-[10px] px-3 py-1 bg-red-500/10 hover:bg-red-500/20 rounded-lg text-red-400"><Trash2 className="w-3 h-3 inline mr-1" />删除</button>
              </div>
            </div>
            <div className="flex flex-wrap gap-4 text-xs text-zinc-400">
              <span>模型数: <span className="text-zinc-300">{ch.supportedModels?.length || 0}</span></span>
              <span>优先级: <span className="text-zinc-300">{ch.priority}</span></span>
              <span>权重: <span className="text-zinc-300">{ch.weight}</span></span>
              <span>超时: <span className="text-zinc-300">{(ch.timeout / 1000).toFixed(0)}s</span></span>
              {ch.lastTestResult && <span>最后测试: <span className={ch.lastTestResult?.startsWith('success') ? 'text-green-400' : 'text-red-400'}>{ch.lastTestResult}</span></span>}
            </div>
          </div>
        ))}
        {channels.length === 0 && <div className="text-center text-zinc-500 py-12">暂无渠道，点击上方按钮添加</div>}
      </div>

      {/* Edit Modal */}
      {edit && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setEdit(null)}>
          <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-5">{edit.isNew ? '添加渠道' : `编辑: ${edit.name}`}</h3>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">渠道名称</label>
                  <input type="text" value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} placeholder="如：Grok 主力渠道"
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">渠道类型</label>
                  <select value={edit.type} onChange={e => setEdit({ ...edit, type: e.target.value })}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none">
                    <option value="openai">OpenAI 兼容（Chat 代理）</option>
                    <option value="hmstudio">HM Studio（图片/视频异步任务）</option>
                    <option value="gemini">Gemini（分析服务）</option>
                    <option value="grok2api">Grok2API（视频/图片生成）</option>
                    <option value="custom">自定义</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Base URL（上游接口地址）</label>
                <input type="text" value={edit.baseUrl} onChange={e => setEdit({ ...edit, baseUrl: e.target.value })} placeholder="http://vps-ip:8080"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none font-mono" />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">API Key（上游密钥）</label>
                <input type="password" value={edit.apiKey} onChange={e => setEdit({ ...edit, apiKey: e.target.value })} placeholder={edit.isNew ? '可选' : '留空=不修改'}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none" />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">支持的模型名（每行一个，对外暴露的名字）</label>
                <textarea value={edit.modelsText} onChange={e => setEdit({ ...edit, modelsText: e.target.value })} rows={3}
                  placeholder={"grok-4\ngrok-imagine-video\ngrok-imagine-image"}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none font-mono resize-none" />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">模型名映射（每行一条，格式: 对外名:上游名）</label>
                <textarea value={edit.mappingText} onChange={e => setEdit({ ...edit, mappingText: e.target.value })} rows={3}
                  placeholder={"grok-4:grok-4.20-0309-super\ngrok-video:grok-imagine-video"}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none font-mono resize-none" />
              </div>
              <div className="grid grid-cols-4 gap-3">
                <div><label className="block text-xs text-zinc-400 mb-1.5">优先级</label><input type="number" value={edit.priority} onChange={e => setEdit({ ...edit, priority: parseInt(e.target.value) || 0 })} className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none" /></div>
                <div><label className="block text-xs text-zinc-400 mb-1.5">权重</label><input type="number" value={edit.weight} onChange={e => setEdit({ ...edit, weight: parseInt(e.target.value) || 1 })} className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none" /></div>
                <div><label className="block text-xs text-zinc-400 mb-1.5">重试次数</label><input type="number" value={edit.maxRetries} onChange={e => setEdit({ ...edit, maxRetries: parseInt(e.target.value) || 3 })} className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none" /></div>
                <div><label className="block text-xs text-zinc-400 mb-1.5">超时(ms)</label><input type="number" value={edit.timeout} onChange={e => setEdit({ ...edit, timeout: parseInt(e.target.value) || 120000 })} className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none" /></div>
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
