import React, { useEffect, useState } from 'react';
import { adminApi } from '../../api/admin';
import { Plus, Cpu, Power, PowerOff, Search, Filter, Clock, CheckCircle2, XCircle } from 'lucide-react';

export default function ModelsPage() {
  const [models, setModels] = useState<any[]>([]);
  const [channels, setChannels] = useState<any[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string>('all');
  const [selectedCap, setSelectedCap] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [edit, setEdit] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [modelsData, channelsData] = await Promise.all([
        adminApi.getModels(),
        adminApi.getChannels()
      ]);
      setModels(modelsData || []);
      setChannels(channelsData || []);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const openNew = () => setEdit({ provider: 'google', modelId: '', displayName: '', description: '', apiKey: '', capabilities: ['text'], isActive: 1, isNew: true });
  const openEdit = (m: any) => setEdit({ ...m, description: m.description || '', apiKey: '', isNew: false }); // apiKey is masked, user must re-enter

  const handleSave = async () => {
    if (!edit) return;
    try {
      const data: any = { provider: edit.provider, modelId: edit.modelId, displayName: edit.displayName, description: edit.description, capabilities: edit.capabilities, isActive: edit.isActive };
      if (edit.apiKey) data.apiKey = edit.apiKey; // Only send if user entered a new key
      if (edit.isNew) { await adminApi.createModel(data); } else { await adminApi.updateModel(edit.id, data); }
      setEdit(null); load();
    } catch (e: any) { alert(e.message); }
  };

  const handleDelete = async (id: number) => { if (!confirm('确定删除此模型？')) return; try { await adminApi.deleteModel(id); load(); } catch (e: any) { alert(e.message); } };

  const toggleActive = async (m: any) => {
    try { await adminApi.updateModel(m.id, { isActive: m.isActive ? 0 : 1 }); load(); } catch (e: any) { alert(e.message); }
  };

  const getChannelModels = (c: any): string[] => {
    try {
      const arr = typeof c.supportedModels === 'string' ? JSON.parse(c.supportedModels) : c.supportedModels;
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  };

  // 过滤模型
  const filteredModels = models.filter(m => {
    // 1. 搜索过滤
    const matchesSearch = searchQuery
      ? m.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        m.modelId.toLowerCase().includes(searchQuery.toLowerCase()) ||
        m.provider.toLowerCase().includes(searchQuery.toLowerCase())
      : true;

    // 2. 渠道过滤
    let matchesChannel = true;
    if (selectedChannelId !== 'all') {
      const channel = channels.find(c => String(c.id) === selectedChannelId);
      if (channel) {
        const supported = getChannelModels(channel);
        matchesChannel = supported.includes(m.modelId);
      } else {
        matchesChannel = false;
      }
    }

    // 3. 能力过滤
    let matchesCap = true;
    if (selectedCap !== 'all') {
      const caps = Array.isArray(m.capabilities) ? m.capabilities : [];
      matchesCap = caps.includes(selectedCap);
    }

    return matchesSearch && matchesChannel && matchesCap;
  });

  const getCapBadgeStyle = (cap: string) => {
    switch (cap) {
      case 'text':
        return 'bg-blue-500/10 text-blue-400 border border-blue-500/20';
      case 'image':
        return 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
      case 'image_gen':
        return 'bg-pink-500/10 text-pink-400 border border-pink-500/20';
      case 'video':
        return 'bg-purple-500/10 text-purple-400 border border-purple-500/20';
      default:
        return 'bg-zinc-500/10 text-zinc-400 border border-zinc-500/20';
    }
  };

  const getCapLabel = (cap: string) => {
    switch (cap) {
      case 'text': return '文本';
      case 'image': return '识图';
      case 'image_gen': return '画图';
      case 'video': return '视频';
      default: return cap;
    }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-2 border-white/10 border-t-white rounded-full animate-spin" /></div>;

  return (
    <div className="p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">🤖 大模型管理</h1>
          <p className="text-sm text-zinc-400 mt-1">管理系统支持的模型定义、分流测试与独立 API Key 配置</p>
        </div>
        <button onClick={openNew} className="flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-medium transition-colors self-start md:self-auto"><Plus className="w-4 h-4" /> 添加模型</button>
      </div>

      {/* Filter Bar */}
      <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-4 mb-6 flex flex-col md:flex-row gap-4">
        {/* Search */}
        <div className="flex-1 relative">
          <Search className="absolute left-3.5 top-3 w-4.5 h-4.5 text-zinc-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="搜索模型名称、ID 或提供商..."
            className="w-full bg-white/5 border border-white/5 focus:border-white/10 rounded-xl pl-10 pr-4 py-2 text-sm text-white placeholder:text-zinc-500 focus:outline-none transition-colors"
          />
        </div>

        {/* Channel Filter */}
        <div className="flex items-center gap-2 min-w-[200px]">
          <Filter className="w-4 h-4 text-zinc-400 shrink-0" />
          <select
            value={selectedChannelId}
            onChange={e => setSelectedChannelId(e.target.value)}
            className="w-full bg-white/5 border border-white/5 focus:border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none transition-colors cursor-pointer"
          >
            <option value="all">所有渠道</option>
            {channels.map(c => (
              <option key={c.id} value={String(c.id)}>{c.name}</option>
            ))}
          </select>
        </div>

        {/* Capabilities Filter */}
        <div className="min-w-[150px]">
          <select
            value={selectedCap}
            onChange={e => setSelectedCap(e.target.value)}
            className="w-full bg-white/5 border border-white/5 focus:border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none transition-colors cursor-pointer"
          >
            <option value="all">所有能力</option>
            <option value="text">文本分析</option>
            <option value="image">图片分析</option>
            <option value="image_gen">图像生成</option>
            <option value="video">视频生成</option>
          </select>
        </div>
      </div>

      {/* Grid List */}
      {filteredModels.length === 0 ? (
        <div className="text-center py-12 bg-white/[0.01] border border-white/5 rounded-2xl">
          <p className="text-zinc-500 text-sm">没有找到符合筛选条件的模型</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredModels.map(m => (
            <div
              key={m.id}
              className={`bg-white/[0.02] border rounded-2xl p-5 flex flex-col justify-between hover:-translate-y-1 hover:shadow-lg hover:shadow-blue-500/[0.02] transition-all duration-300 ${
                m.isActive ? 'border-white/5' : 'border-red-500/20 opacity-60'
              }`}
            >
              <div>
                {/* Header */}
                <div className="flex items-start justify-between gap-3 mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500/20 to-purple-500/20 flex items-center justify-center border border-white/5">
                      <Cpu className="w-5 h-5 text-blue-400" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-white line-clamp-1">{m.displayName}</h3>
                      <p className="text-[10px] text-zinc-500 font-mono mt-0.5">{m.provider} · {m.modelId}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => toggleActive(m)}
                    className={`p-1.5 rounded-lg transition-colors shrink-0 ${
                      m.isActive ? 'bg-green-500/10 text-green-400 hover:bg-green-500/20' : 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
                    }`}
                  >
                    {m.isActive ? <Power className="w-3.5 h-3.5" /> : <PowerOff className="w-3.5 h-3.5" />}
                  </button>
                </div>

                {/* Description preview */}
                {m.description && (
                  <p className="text-xs text-zinc-400 mb-3 bg-white/[0.02] p-2 rounded-lg border border-white/5 line-clamp-2">
                    {m.description}
                  </p>
                )}

                {/* Capabilities Badges */}
                <div className="flex flex-wrap gap-1.5 mb-4">
                  {Array.isArray(m.capabilities) && m.capabilities.map(cap => (
                    <span key={cap} className={`px-2 py-0.5 rounded text-[10px] font-medium ${getCapBadgeStyle(cap)}`}>
                      {getCapLabel(cap)}
                    </span>
                  ))}
                </div>
              </div>

              {/* Footer Info & Actions */}
              <div className="border-t border-white/5 pt-4 mt-2">
                {/* Metric Cards Grid */}
                <div className="grid grid-cols-2 gap-2 text-[11px] mb-3">
                  <div className="bg-white/[0.02] border border-white/5 rounded-xl p-2 flex flex-col justify-between">
                    <span className="text-zinc-500 flex items-center gap-1"><Clock className="w-3 h-3 text-amber-400" /> 平均耗时</span>
                    <span className="text-zinc-200 font-medium text-xs mt-1">{m.avgDurationMinutes ?? 0} 分钟</span>
                  </div>

                  <div className="bg-white/[0.02] border border-white/5 rounded-xl p-2 flex flex-col justify-between">
                    <span className="text-zinc-500 flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-emerald-400" /> 生成正常率</span>
                    <span className="text-emerald-400 font-medium text-xs mt-1">{m.successRate ?? 100}%</span>
                  </div>

                  <div className="bg-white/[0.02] border border-white/5 rounded-xl p-2 flex flex-col justify-between">
                    <span className="text-zinc-500 flex items-center gap-1"><XCircle className="w-3 h-3 text-red-400" /> 失败率</span>
                    <span className={`${m.failureRate > 0 ? 'text-red-400 font-semibold' : 'text-zinc-400'} text-xs mt-1`}>{m.failureRate ?? 0}%</span>
                  </div>

                  <div className="bg-white/[0.02] border border-white/5 rounded-xl p-2 flex flex-col justify-between">
                    <span className="text-zinc-500">累计调用</span>
                    <span className="text-zinc-200 font-medium text-xs mt-1">{m.totalCalls?.toLocaleString() || 0} 次</span>
                  </div>
                </div>

                <div className="flex items-center justify-between text-[11px] text-zinc-400 mb-3 px-1">
                  <span>状态: <span className={m.isActive ? 'text-green-400' : 'text-red-400'}>{m.isActive ? '启用' : '禁用'}</span></span>
                  <span className="truncate max-w-[180px]">Key: <span className="text-zinc-300 font-mono">{m.apiKey ? '已设独立Key' : '使用全局Key'}</span></span>
                </div>

                <div className="flex gap-2 w-full">
                  <button onClick={() => openEdit(m)} className="flex-1 py-1.5 bg-white/5 hover:bg-white/10 rounded-lg text-xs text-zinc-300 transition-colors">编辑</button>
                  <button onClick={() => handleDelete(m.id)} className="py-1.5 px-3 bg-red-500/10 hover:bg-red-500/20 rounded-lg text-xs text-red-400 transition-colors">删除</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

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
                    <option value="google">Google</option>
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="grok">Grok (xAI)</option>
                    <option value="diwdiw">DiwDiw 渠道</option>
                    <option value="newtoken">NewToken</option>
                    <option value="sudashui">SudaShui</option>
                    <option value="pidoi">Pidoi</option>
                    <option value="hmstudio">HM Studio</option>
                    <option value="other">其他</option>
                  </select>
                </div>
                <div><label className="block text-xs text-zinc-400 mb-1.5">模型ID</label><input type="text" value={edit.modelId} onChange={e => setEdit({ ...edit, modelId: e.target.value })} placeholder="gemini-2.5-pro" disabled={!edit.isNew} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none disabled:opacity-50" /></div>
              </div>
              <div><label className="block text-xs text-zinc-400 mb-1.5">显示名称</label><input type="text" value={edit.displayName} onChange={e => setEdit({ ...edit, displayName: e.target.value })} placeholder="Gemini 2.5 Pro" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none" /></div>
              <div><label className="block text-xs text-zinc-400 mb-1.5">模型描述 / 提示说明 (留空则使用默认提示)</label><textarea rows={2} value={edit.description} onChange={e => setEdit({ ...edit, description: e.target.value })} placeholder="支持最多30张图片、10个视频、10个音频参考，4-30秒，不卡人脸..." className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm text-white focus:outline-none placeholder:text-zinc-600 resize-none" /></div>
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
