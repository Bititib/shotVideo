import React, { useEffect, useState } from 'react';
import { adminApi } from '../../api/admin';
import { Plus, Radio, Trash2, Pencil, Zap, Loader2, Power, PowerOff, RefreshCw, KeyRound, Activity, CircleCheck, CircleX, Timer } from 'lucide-react';

const HM_STUDIO_BASE_URL = 'https://dnyovzpgyokm.sealosbja.site';

export default function ChannelsPage() {
  const [channels, setChannels] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState<number | null>(null);
  const [syncing, setSyncing] = useState<number | null>(null);
  const [routingPeriod, setRoutingPeriod] = useState<'all' | '24h' | '7d' | '30d'>('all');
  const [routingStats, setRoutingStats] = useState<any[]>([]);

  const newHmKey = () => ({
    clientId: `new-key-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    apiKey: '',
    concurrencyLimit: 10,
    status: 1,
  });

  const loadChannels = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const channelRows = await adminApi.getChannels();
      setChannels(channelRows);
    }
    finally { if (showLoading) setLoading(false); }
  };

  const loadRoutingStats = async () => {
    try {
      const stats = await adminApi.getVideoRoutingStats(routingPeriod);
      setRoutingStats(stats.channels || []);
    } catch (error) {
      console.warn('加载分流渠道统计失败:', error);
    }
  };

  useEffect(() => {
    void loadChannels();
    const timer = window.setInterval(() => { void loadChannels(false); }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void loadRoutingStats();
    const timer = window.setInterval(() => { void loadRoutingStats(); }, 60000);
    return () => window.clearInterval(timer);
  }, [routingPeriod]);

  const openNew = () => setEdit({
    name: '', type: 'openai', baseUrl: '', apiKey: '',
    apiKeys: [],
    modelMapping: {}, supportedModels: [],
    priority: 0, weight: 1, maxRetries: 3, timeout: 120000,
    isNew: true,
    // 临时 UI 字段
    mappingText: '',
    modelsText: '',
  });

  const openEdit = (ch: any) => setEdit({
    ...ch,
    apiKeys: (ch.apiKeys || []).map((key: any) => ({ ...key })),
    apiKey: '', isNew: false,
    mappingText: Object.entries(ch.modelMapping || {}).map(([k, v]) => `${k}:${v}`).join('\n'),
    modelsText: (ch.supportedModels || []).join('\n'),
  });

  const openAddHmKey = (channel: any) => setEdit({
    ...channel,
    apiKeys: [...(channel.apiKeys || []).map((key: any) => ({ ...key })), newHmKey()],
    apiKey: '',
    isNew: false,
    mappingText: Object.entries(channel.modelMapping || {}).map(([key, value]) => `${key}:${value}`).join('\n'),
    modelsText: (channel.supportedModels || []).join('\n'),
  });

  const updateHmKey = (index: number, changes: Record<string, any>) => {
    setEdit((current: any) => ({
      ...current,
      apiKeys: current.apiKeys.map((key: any, keyIndex: number) => keyIndex === index ? { ...key, ...changes } : key),
    }));
  };

  const removeHmKey = (index: number) => {
    const key = edit?.apiKeys?.[index];
    if (key?.id && !confirm(`确定从该渠道移除 ${key.maskedKey}？保存后生效。`)) return;
    setEdit((current: any) => ({
      ...current,
      apiKeys: current.apiKeys.filter((_: any, keyIndex: number) => keyIndex !== index),
    }));
  };

  const handleSave = async () => {
    if (!edit) return;
    try {
      const hmKeys = edit.type === 'hmstudio'
        ? (edit.apiKeys || []).filter((key: any) => key.id || String(key.apiKey || '').trim())
        : [];
      if (edit.isNew && edit.type === 'hmstudio' && hmKeys.length === 0) {
        alert('创建 HM Studio 渠道时请至少添加一个 API Key');
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
      if (edit.type === 'hmstudio') {
        data.apiKeys = hmKeys.map((key: any) => ({
          ...(key.id ? { id: key.id } : { apiKey: String(key.apiKey || '').trim() }),
          concurrencyLimit: Math.max(1, Number.parseInt(key.concurrencyLimit, 10) || 1),
          status: key.status === 0 ? 0 : 1,
        }));
      } else if (edit.apiKey) {
        data.apiKey = edit.apiKey;
      }
      if (edit.status !== undefined) data.status = edit.status;

      if (edit.isNew) await adminApi.createChannel(data);
      else await adminApi.updateChannel(edit.id, data);
      setEdit(null); loadChannels();
    } catch (e: any) { alert(e.message); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('确定删除此渠道？')) return;
    try { await adminApi.deleteChannel(id); loadChannels(); } catch (e: any) { alert(e.message); }
  };

  const handleTest = async (id: number) => {
    setTesting(id);
    try {
      const result = await adminApi.testChannel(id);
      alert(result.success ? `✅ 测试成功，耗时 ${result.durationMs}ms` : `❌ 测试失败：${result.message}`);
      loadChannels();
    } catch (e: any) { alert('测试出错: ' + e.message); }
    finally { setTesting(null); }
  };

  const toggleStatus = async (ch: any) => {
    try { await adminApi.updateChannel(ch.id, { status: ch.status ? 0 : 1 }); loadChannels(); }
    catch (e: any) { alert(e.message); }
  };

  const syncModels = async (ch: any) => {
    setSyncing(ch.id);
    try {
      const result = await adminApi.syncChannelModels(ch.id);
      alert(`同步完成：上游 ${result.count} 个模型，新增 ${result.added} 个模型配置`);
      loadChannels();
    } catch (e: any) { alert('同步失败: ' + e.message); }
    finally { setSyncing(null); }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-2 border-white/10 border-t-white rounded-full animate-spin" /></div>;

  const hmChannels = channels.filter(channel => channel.type === 'hmstudio' && channel.status);
  const hmTotalCapacity = hmChannels.reduce((sum, channel) => sum + Number(channel.concurrencyLimit || 0), 0);
  const hmTotalRunning = hmChannels.reduce((sum, channel) => sum + Number(channel.concurrencyRunning || 0), 0);
  const hmTotalQueued = hmChannels.reduce((sum, channel) => sum + Number(channel.concurrencyQueued || 0), 0);
  const formatDuration = (durationMs: number) => {
    if (!durationMs) return '—';
    const totalSeconds = Math.round(durationMs / 1000);
    if (totalSeconds < 60) return `${totalSeconds}秒`;
    return `${Math.floor(totalSeconds / 60)}分${totalSeconds % 60}秒`;
  };

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-bold text-white">📡 渠道管理</h1>
        <div className="flex flex-wrap items-center gap-2">
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

      <section className="mb-6 rounded-2xl border border-cyan-500/20 bg-cyan-500/[0.04] p-4" aria-labelledby="routing-stats-title">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 id="routing-stats-title" className="text-sm font-semibold text-cyan-100">视频分流渠道统计</h2>
            <p className="mt-1 text-xs text-zinc-500">仅管理员可见；运行数每 5 秒刷新，成功率不包含运行中任务。</p>
          </div>
          <select
            value={routingPeriod}
            onChange={event => setRoutingPeriod(event.target.value as typeof routingPeriod)}
            className="rounded-lg border border-white/10 bg-[#151515] px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-cyan-400/40"
            aria-label="分流统计时间范围"
          >
            <option value="all">全部</option>
            <option value="24h">近24小时</option>
            <option value="7d">近7天</option>
            <option value="30d">近30天</option>
          </select>
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {routingStats.map(stat => (
            <article key={stat.channelType} className="rounded-xl border border-white/[0.07] bg-black/20 p-4">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-white">{stat.channelName}</h3>
                  <code className="mt-1 block text-[10px] text-cyan-300/70">{stat.modelId}</code>
                </div>
                <div className={`rounded-full border px-2 py-1 text-[10px] ${Number(stat.running) > 0
                  ? 'border-amber-400/25 bg-amber-500/10 text-amber-300'
                  : 'border-white/10 bg-white/5 text-zinc-500'}`}>
                  {Number(stat.running) > 0 ? '正在承载任务' : '当前空闲'}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <div className="rounded-lg bg-white/[0.03] px-2 py-2 text-center">
                  <Activity className="mx-auto mb-1 h-3.5 w-3.5 text-amber-300" />
                  <div className="text-lg font-bold tabular-nums text-amber-200">{stat.running}</div>
                  <div className="text-[9px] text-zinc-500">运行中</div>
                </div>
                <div className="rounded-lg bg-white/[0.03] px-2 py-2 text-center">
                  <CircleCheck className="mx-auto mb-1 h-3.5 w-3.5 text-emerald-400" />
                  <div className="text-lg font-bold tabular-nums text-emerald-300">{stat.succeeded}</div>
                  <div className="text-[9px] text-zinc-500">成功</div>
                </div>
                <div className="rounded-lg bg-white/[0.03] px-2 py-2 text-center">
                  <CircleX className="mx-auto mb-1 h-3.5 w-3.5 text-red-400" />
                  <div className="text-lg font-bold tabular-nums text-red-300">{stat.failed}</div>
                  <div className="text-[9px] text-zinc-500">失败</div>
                </div>
                <div className="rounded-lg bg-white/[0.03] px-2 py-2 text-center">
                  <div className="mb-1 text-[11px] font-semibold text-cyan-300">%</div>
                  <div className="text-lg font-bold tabular-nums text-cyan-200">{Number(stat.successRate).toFixed(1)}</div>
                  <div className="text-[9px] text-zinc-500">成功率</div>
                </div>
                <div className="rounded-lg bg-white/[0.03] px-2 py-2 text-center">
                  <Timer className="mx-auto mb-1 h-3.5 w-3.5 text-violet-300" />
                  <div className="truncate text-sm font-bold tabular-nums text-violet-200">{formatDuration(stat.averageDurationMs)}</div>
                  <div className="text-[9px] text-zinc-500">平均耗时</div>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-white/[0.06] pt-3 text-[10px] text-zinc-500">
                <span>任务总数 <b className="font-medium text-zinc-300">{stat.total}</b></span>
                <span>HM 池满分流 <b className="font-medium text-cyan-300">{stat.capacityOverflowCount}</b></span>
                <span>HM 上游并发错误 <b className="font-medium text-cyan-300">{stat.upstreamConcurrencyCount}</b></span>
              </div>
            </article>
          ))}
          {routingStats.length === 0 && (
            <div className="col-span-full rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-xs text-zinc-500" role="status">
              暂无分流渠道统计数据
            </div>
          )}
        </div>
      </section>

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
                {ch.type === 'hmstudio' && (
                  <button onClick={() => openAddHmKey(ch)}
                    className="flex items-center gap-1 text-[10px] px-3 py-1 bg-amber-500/10 hover:bg-amber-500/20 rounded-lg text-amber-300">
                    <KeyRound className="w-3 h-3" /> 添加 Key
                  </button>
                )}
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
              {ch.type === 'hmstudio' && <span>Keys: <span className="text-amber-200 tabular-nums">{ch.apiKeyCount || 0}</span></span>}
              {ch.type === 'hmstudio' && <span>运行: <span className="text-emerald-300 tabular-nums">{ch.concurrencyRunning || 0}/{ch.concurrencyLimit ?? 0}</span></span>}
              {ch.type === 'hmstudio' && <span>排队: <span className="text-amber-300 tabular-nums">{ch.concurrencyQueued || 0}</span></span>}
              {ch.lastTestResult && <span>最后测试: <span className={ch.lastTestResult?.startsWith('success') ? 'text-green-400' : 'text-red-400'}>{ch.lastTestResult}</span></span>}
            </div>
          </div>
        ))}
        {channels.length === 0 && <div className="text-center text-zinc-500 py-12">暂无渠道，点击上方按钮添加</div>}
      </div>

      {/* Edit Modal */}
      {edit && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={() => setEdit(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="channel-dialog-title" className="bg-[#1a1a1a] border border-white/10 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <h3 id="channel-dialog-title" className="shrink-0 px-5 pt-5 pb-4 md:px-6 md:pt-6 text-lg font-semibold text-white">{edit.isNew ? '添加渠道' : `编辑: ${edit.name}`}</h3>
            <div className="flex-1 overflow-y-auto px-5 pb-5 md:px-6">
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                      apiKeys: e.target.value === 'hmstudio' && (!edit.apiKeys || edit.apiKeys.length === 0)
                        ? [newHmKey()]
                        : edit.apiKeys,
                      baseUrl: e.target.value === 'hmstudio' && !edit.baseUrl
                        ? HM_STUDIO_BASE_URL
                        : e.target.value === 'snumom' && !edit.baseUrl
                          ? 'https://snumom.com'
                          : edit.baseUrl,
                    })}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none">
                      <option value="openai">OpenAI 兼容（Chat 代理）</option>
                      <option value="hmstudio">HM Studio（图片/视频异步任务）</option>
                      <option value="wx-haidiyue">wx-海底月（仅 sd2.5 分流）</option>
                      <option value="snumom">snumom（WAN3.0 视频异步任务）</option>
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
              {edit.type !== 'hmstudio' && (
                <div>
                  <label htmlFor="channel-api-key" className="block text-xs text-zinc-400 mb-1.5">API Key（上游密钥）</label>
                  <input id="channel-api-key" type="password" value={edit.apiKey} onChange={e => setEdit({ ...edit, apiKey: e.target.value })} placeholder={edit.isNew ? '可选' : '留空=不修改'}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none" />
                </div>
              )}
              {edit.type === 'hmstudio' && (
                <section aria-labelledby="hm-api-keys-title" className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.04] p-3.5 sm:p-4">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <div>
                      <h4 id="hm-api-keys-title" className="flex items-center gap-2 text-sm font-semibold text-amber-100">
                        <KeyRound className="w-4 h-4 text-amber-300" /> API Keys
                        <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300">{edit.apiKeys?.length || 0}</span>
                      </h4>
                      <p id="hm-key-description" className="mt-1 text-[11px] text-zinc-500">同一渠道可添加多个 Key，每个 Key 独立设置并发数和启用状态。</p>
                    </div>
                    <button type="button" onClick={() => setEdit({ ...edit, apiKeys: [...(edit.apiKeys || []), newHmKey()] })}
                      className="shrink-0 flex items-center gap-1.5 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-300 hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70">
                      <Plus className="w-3.5 h-3.5" /> 添加 API Key
                    </button>
                  </div>

                  <div className="space-y-2.5">
                    {(edit.apiKeys || []).map((key: any, index: number) => (
                      <div key={key.id || key.clientId || index} className="rounded-xl border border-white/[0.07] bg-black/20 p-3">
                        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[minmax(0,1fr)_7.5rem_auto_auto] sm:items-end">
                          <div>
                            <label htmlFor={`hm-api-key-${index}`} className="block text-[11px] text-zinc-400 mb-1.5">
                              API Key {index + 1}{key.id ? <span className="ml-1.5 text-[10px] text-emerald-400">已保存</span> : null}
                            </label>
                            <input id={`hm-api-key-${index}`} type={key.id ? 'text' : 'password'} readOnly={Boolean(key.id)}
                              value={key.id ? key.maskedKey : (key.apiKey || '')}
                              onChange={event => updateHmKey(index, { apiKey: event.target.value })}
                              placeholder="请输入新的 HM Studio API Key" aria-describedby="hm-key-description"
                              className={`w-full rounded-lg border px-3 py-2 text-sm font-mono focus:outline-none ${key.id ? 'border-white/[0.06] bg-white/[0.03] text-zinc-400' : 'border-amber-500/20 bg-white/5 text-white focus:border-amber-400'}`} />
                          </div>
                          <div>
                            <label htmlFor={`hm-key-limit-${index}`} className="block text-[11px] text-zinc-400 mb-1.5">并发数</label>
                            <input id={`hm-key-limit-${index}`} type="number" min={1} max={1000} step={1} value={key.concurrencyLimit || 10}
                              onChange={event => updateHmKey(index, { concurrencyLimit: Math.max(1, parseInt(event.target.value, 10) || 1) })}
                              className="w-full rounded-lg border border-amber-500/20 bg-white/5 px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-400" />
                          </div>
                          <button type="button" onClick={() => updateHmKey(index, { status: key.status === 0 ? 1 : 0 })}
                            aria-label={`${key.status === 0 ? '启用' : '停用'} API Key ${index + 1}`}
                            className={`h-9 rounded-lg px-3 text-xs font-medium transition-colors ${key.status === 0 ? 'bg-white/5 text-zinc-400 hover:bg-white/10' : 'bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'}`}>
                            {key.status === 0 ? '已停用' : '已启用'}
                          </button>
                          <button type="button" onClick={() => removeHmKey(index)} aria-label={`移除 API Key ${index + 1}`}
                            className="h-9 w-full rounded-lg bg-red-500/10 px-3 text-red-400 hover:bg-red-500/20 sm:w-9 sm:px-0">
                            <Trash2 className="w-3.5 h-3.5 mx-auto" />
                          </button>
                        </div>
                        {key.id && (
                          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-zinc-500">
                            <span>运行 <b className="font-medium text-emerald-300">{key.concurrencyRunning || 0}/{key.concurrencyLimit}</b></span>
                            <span>排队 <b className="font-medium text-amber-300">{key.concurrencyQueued || 0}</b></span>
                          </div>
                        )}
                      </div>
                    ))}
                    {(edit.apiKeys || []).length === 0 && (
                      <button type="button" onClick={() => setEdit({ ...edit, apiKeys: [newHmKey()] })}
                        className="w-full rounded-xl border border-dashed border-amber-500/25 py-5 text-xs text-amber-300 hover:bg-amber-500/[0.06]">
                        + 添加第一个 API Key
                      </button>
                    )}
                  </div>

                  <div className="mt-3 flex items-center justify-between rounded-lg bg-black/20 px-3 py-2 text-[11px]">
                    <span className="text-zinc-500">保存后立即生效，无需重启服务</span>
                    <span className="font-medium text-amber-200">总并发 {(edit.apiKeys || []).filter((key: any) => key.status !== 0).reduce((sum: number, key: any) => sum + Number(key.concurrencyLimit || 0), 0)}</span>
                  </div>
                </section>
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
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div><label className="block text-xs text-zinc-400 mb-1.5">优先级</label><input type="number" value={edit.priority} onChange={e => setEdit({ ...edit, priority: parseInt(e.target.value) || 0 })} className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none" /></div>
                <div><label className="block text-xs text-zinc-400 mb-1.5">权重</label><input type="number" value={edit.weight} onChange={e => setEdit({ ...edit, weight: parseInt(e.target.value) || 1 })} className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none" /></div>
                <div><label className="block text-xs text-zinc-400 mb-1.5">重试次数</label><input type="number" value={edit.maxRetries} onChange={e => setEdit({ ...edit, maxRetries: parseInt(e.target.value) || 3 })} className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none" /></div>
                <div><label className="block text-xs text-zinc-400 mb-1.5">超时(ms)</label><input type="number" value={edit.timeout} onChange={e => setEdit({ ...edit, timeout: parseInt(e.target.value) || 120000 })} className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none" /></div>
              </div>
              </div>
            </div>
            <div className="shrink-0 flex gap-3 border-t border-[#e2ccb1] bg-[#fffaf2] px-5 py-4 md:px-6">
              <button onClick={() => setEdit(null)} className="flex-1 py-2.5 bg-white/5 hover:bg-white/10 rounded-xl text-sm transition-colors">取消</button>
              <button onClick={handleSave} className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-medium transition-colors">保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
