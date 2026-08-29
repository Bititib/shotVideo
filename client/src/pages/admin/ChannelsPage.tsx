import React, { useEffect, useState } from 'react';
import { adminApi } from '../../api/admin';
import { Plus, Radio, Trash2, Pencil, Zap, Loader2, Power, PowerOff, RefreshCw, KeyRound } from 'lucide-react';

const HM_STUDIO_BASE_URL = 'https://dnyovzpgyokm.sealosbja.site';

export default function ChannelsPage() {
  const [channels, setChannels] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState<number | null>(null);
  const [syncing, setSyncing] = useState<number | null>(null);

  const load = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try { setChannels(await adminApi.getChannels()); }
    finally { if (showLoading) setLoading(false); }
  };
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(false); }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const openNew = () => setEdit({
    name: '', type: 'openai', baseUrl: '', apiKey: '',
    modelMapping: {}, supportedModels: [],
    priority: 0, weight: 1, maxRetries: 3, timeout: 120000,
    isNew: true,
    // 临时 UI 字段
    mappingText: '',
    modelsText: '',
  });

  const openNewHmKey = () => {
    const template = channels.find(channel => channel.type === 'hmstudio');
    const hmCount = channels.filter(channel => channel.type === 'hmstudio').length;
    setEdit({
      name: `HM Studio 渠道 ${hmCount + 1}`,
      type: 'hmstudio',
      baseUrl: template?.baseUrl || HM_STUDIO_BASE_URL,
      apiKey: '',
      modelMapping: template?.modelMapping || {},
      supportedModels: template?.supportedModels || [],
      priority: template?.priority ?? 10,
      weight: template?.weight ?? 1,
      maxRetries: template?.maxRetries ?? 3,
      timeout: template?.timeout ?? 120000,
      status: 1,
      isNew: true,
      mappingText: Object.entries(template?.modelMapping || {}).map(([k, v]) => `${k}:${v}`).join('\n'),
      modelsText: (template?.supportedModels || []).join('\n'),
    });
  };

  const openEdit = (ch: any) => setEdit({
    ...ch, apiKey: '', isNew: false,
    mappingText: Object.entries(ch.modelMapping || {}).map(([k, v]) => `${k}:${v}`).join('\n'),
    modelsText: (ch.supportedModels || []).join('\n'),
  });

  const handleSave = async () => {
    if (!edit) return;
    try {
      if (edit.isNew && edit.type === 'hmstudio' && !edit.apiKey.trim()) {
        alert('添加 HM Studio 并发渠道必须填写一个新的 API Key');
        return;
      }
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

  const activeHmPoolMap = new Map<string, any>();
  channels
    .filter(channel => channel.type === 'hmstudio' && channel.status && channel.apiKey && channel.concurrencyPoolId)
    .forEach(channel => activeHmPoolMap.set(channel.concurrencyPoolId, channel));
  const activeHmPools = Array.from(activeHmPoolMap.values());
  const hmTotalCapacity = activeHmPools.reduce((sum, channel) => sum + Number(channel.concurrencyLimit || 0), 0);
  const hmTotalRunning = activeHmPools.reduce((sum, channel) => sum + Number(channel.concurrencyRunning || 0), 0);
  const hmTotalQueued = activeHmPools.reduce((sum, channel) => sum + Number(channel.concurrencyQueued || 0), 0);

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-bold text-white">📡 渠道管理</h1>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={openNewHmKey} className="h-11 flex items-center gap-2 px-4 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 rounded-xl text-sm font-medium text-amber-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70">
            <KeyRound className="w-4 h-4" /> 添加 HM Key
          </button>
          <button type="button" onClick={openNew} className="h-11 flex items-center gap-2 px-4 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
            <Plus className="w-4 h-4" /> 添加渠道
          </button>
        </div>
      </div>

      <div className="mb-6 rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] p-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-amber-200">HM Studio 并发池</p>
          <p className="text-xs text-zinc-500 mt-1">本服务实例无用户并发限制；所有池满载后，兼容视频自动调度备用线路。每 5 秒刷新。</p>
        </div>
        <div className="grid w-full grid-cols-3 gap-2 sm:w-auto sm:min-w-[300px]" aria-label="HM Studio 当前并发统计">
          <div className="rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2 text-center">
            <p className="text-xl font-bold text-emerald-300 tabular-nums">{hmTotalRunning}</p>
            <p className="text-[10px] text-zinc-500">运行中</p>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2 text-center">
            <p className="text-xl font-bold text-white tabular-nums">{hmTotalCapacity}</p>
            <p className="text-[10px] text-zinc-500">总容量</p>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2 text-center">
            <p className="text-xl font-bold text-amber-300 tabular-nums">{hmTotalQueued}</p>
            <p className="text-[10px] text-zinc-500">排队</p>
          </div>
        </div>
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
              {ch.type === 'hmstudio' && <span>运行: <span className="text-emerald-300 tabular-nums">{ch.concurrencyRunning || 0}/{ch.concurrencyLimit || 10}</span></span>}
              {ch.type === 'hmstudio' && <span>排队: <span className="text-amber-300 tabular-nums">{ch.concurrencyQueued || 0}</span></span>}
              {ch.lastTestResult && <span>最后测试: <span className={ch.lastTestResult?.startsWith('success') ? 'text-green-400' : 'text-red-400'}>{ch.lastTestResult}</span></span>}
            </div>
          </div>
        ))}
        {channels.length === 0 && <div className="text-center text-zinc-500 py-12">暂无渠道，点击上方按钮添加</div>}
      </div>

      {/* Edit Modal */}
      {edit && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setEdit(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="channel-dialog-title" className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-5 md:p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 id="channel-dialog-title" className="text-lg font-semibold text-white mb-5">{edit.isNew ? '添加渠道' : `编辑: ${edit.name}`}</h3>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">渠道名称</label>
                  <input type="text" value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} placeholder="如：Grok 主力渠道"
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">渠道类型</label>
                  <select value={edit.type} onChange={e => setEdit({
                    ...edit,
                    type: e.target.value,
                    baseUrl: e.target.value === 'hmstudio' && !edit.baseUrl ? HM_STUDIO_BASE_URL : edit.baseUrl,
                  })}
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
                <label htmlFor="channel-api-key" className="block text-xs text-zinc-400 mb-1.5">API Key（上游密钥）</label>
                <input id="channel-api-key" type="password" required={edit.isNew && edit.type === 'hmstudio'} aria-describedby={edit.type === 'hmstudio' ? 'hm-key-description' : undefined} value={edit.apiKey} onChange={e => setEdit({ ...edit, apiKey: e.target.value })} placeholder={edit.isNew && edit.type === 'hmstudio' ? '请输入新的 HM Studio API Key' : edit.isNew ? '可选' : '留空=不修改'}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none" />
              </div>
              {edit.type === 'hmstudio' && (
                <div id="hm-key-description" className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 text-xs leading-relaxed text-amber-200/80">
                  每个不同的 HM Studio API Key 对应一个独立的 10 并发池。通过“添加 HM Key”创建第二个渠道时，会自动复制第一个 HM 渠道的模型和映射；保存后两个 Key 总容量为 20。
                </div>
              )}
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
