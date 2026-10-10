import React, { lazy, Suspense, useEffect, useState } from 'react';
import AdminCollection from '../../components/AdminCollection';
import AdminDrawer from '../../components/AdminDrawer';
import { useEditDraft } from '../../hooks/useEditDraft';
import { startPolling } from '../../utils/polling';
import { Link } from 'react-router-dom';
import { useAdminFilters, useAdminScroll } from '../../hooks/useAdminView';
import { getAdminCached } from '../../api/adminCache';
import { adminApi } from '../../api/admin';
import { Plus, Radio, Trash2, Pencil, Zap, Loader2, Power, PowerOff, RefreshCw, KeyRound, Activity, CircleCheck, CircleX, Timer, ScanFace } from 'lucide-react';

const HM_STUDIO_BASE_URL = 'https://dnyovzpgyokm.sealosbja.site';
const HAYA_BASE_URL = 'https://hayaai.fun';
const MIAOWU_BASE_URL = 'https://api.miaowuai.store';

const ModelsPage = lazy(() => import('./ModelsPage'));
export default function ChannelsPage() {
  const [detail, setDetail] = useState<any>(null);
  const [detailEditing, setDetailEditing] = useState(false);
  const [detailTab, setDetailTab] = useState('models');
  const [channels, setChannels] = useState<any[]>(() => getAdminCached<any[]>('/admin/channels') || []);
  const { values, setFilter, reset } = useAdminFilters({ search: '', type: 'all', status: 'all', id: '', period: 'all' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const { edit, setEdit, close: closeEdit, restore, available } = useEditDraft('channels', saving);
  const [loading, setLoading] = useState(() => !getAdminCached('/admin/channels'));
  useAdminScroll(!loading);
  const [testing, setTesting] = useState<number | null>(null);
  const [syncing, setSyncing] = useState<number | null>(null);
  const routingPeriod = (['all', '24h', '7d', '30d'].includes(values.period) ? values.period : 'all') as 'all' | '24h' | '7d' | '30d';
  const setRoutingPeriod = (value: string) => setFilter('period', value);
  const [routingStats, setRoutingStats] = useState<any[]>([]);
  const [routingStatsLoading, setRoutingStatsLoading] = useState(false);
  const [siYueTianStrategy, setSiYueTianStrategy] = useState<'failover' | 'round_robin'>('failover');
  const [strategySaving, setStrategySaving] = useState(false);

  const newHmKey = () => ({
    clientId: `new-key-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    apiKey: '',
    concurrencyLimit: 10,
    status: 1,
  });

  const loadChannels = async () => {
    setError('');
    try {
      const channelRows = await adminApi.getChannels();
      setChannels(channelRows);
    }
    catch (e: any) { setError(e.message || '渠道加载失败，请重试'); }
    finally { setLoading(false); }
  };

  const loadRoutingStats = async () => {
    setRoutingStatsLoading(true);
    try {
      const stats = await adminApi.getVideoRoutingStats(routingPeriod);
      setRoutingStats(stats.channels || []);
    } catch (error) {
      console.warn('加载分流渠道统计失败:', error);
    } finally {
      setRoutingStatsLoading(false);
    }
  };

  const loadSiYueTianStrategy = async () => {
    const rows = await adminApi.getSettings();
    const value = rows.find((item: any) => item.key === 'siyuetian_sd25_routing_strategy')?.value;
    setSiYueTianStrategy(value === 'round_robin' ? 'round_robin' : 'failover');
  };

  const saveSiYueTianStrategy = async (value: 'failover' | 'round_robin') => {
    setStrategySaving(true);
    try {
      await adminApi.updateSettings([{ key: 'siyuetian_sd25_routing_strategy', value }]);
      setSiYueTianStrategy(value);
    } finally {
      setStrategySaving(false);
    }
  };

  useEffect(() => {
    void loadChannels();
    void loadSiYueTianStrategy().catch(e => setError(e.message));
  }, []);

  useEffect(() => startPolling(async signal => {
    const rows = await adminApi.getChannelRuntimeStatus(signal);
    if (signal.aborted) return;
    const byId = new Map(rows.map((row: any) => [row.id, row]));
    setChannels(current => current.map(channel => ({ ...channel, ...(byId.get(channel.id) || {}) })));
  }, 5000), []);

  const openNew = () => setEdit({
    name: '', type: 'openai', baseUrl: '', apiKey: '',
    apiKeys: [],
    modelMapping: {}, supportedModels: [],
    priority: 0, weight: 1, maxRetries: 3, timeout: 120000,
    faceSplitEnabled: 1,
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

  const toggleHmKeyStatus = async (index: number, key: any) => {
    const nextStatus = key.status === 0 ? 1 : 0;
    if (!key.id) {
      updateHmKey(index, { status: nextStatus });
      return;
    }
    try {
      await adminApi.setChannelApiKeyStatus(edit.id, key.id, nextStatus);
      updateHmKey(index, { status: nextStatus });
      await loadChannels();
    } catch (e: any) { setError(e.message); }
  };

  const handleSave = async () => {
    if (!edit || saving) return;
    setSaving(true);
    try {
      const hmKeys = edit.type === 'hmstudio'
        ? (edit.apiKeys || []).filter((key: any) => key.id || String(key.apiKey || '').trim())
        : [];
      if (edit.isNew && edit.type === 'hmstudio' && hmKeys.length === 0) {
        setError('创建 HM Studio 渠道时请至少添加一个 API Key');
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
      if (edit.type === 'wx-haidiyue') {
        data.faceSplitEnabled = edit.faceSplitEnabled === 0 ? 0 : 1;
      }
      if (edit.status !== undefined) data.status = edit.status;

      if (edit.isNew) await adminApi.createChannel(data);
      else await adminApi.updateChannel(edit.id, data);
      setEdit(null); await loadChannels();
    } catch (e: any) { setError(e.message); } finally { setSaving(false); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('确定删除此渠道？')) return;
    try { await adminApi.deleteChannel(id); loadChannels(); } catch (e: any) { setError(e.message); }
  };

  const handleTest = async (id: number) => {
    setTesting(id);
    try {
      const result = await adminApi.testChannel(id);
      setNotice(result.success ? `测试成功，耗时 ${result.durationMs}ms` : `测试失败：${result.message}`);
      loadChannels();
    } catch (e: any) { setError('测试出错: ' + e.message); }
    finally { setTesting(null); }
  };

  const toggleStatus = async (ch: any) => {
    if (pendingId !== null) return;
    setPendingId(ch.id);
    try { await adminApi.updateChannel(ch.id, { status: ch.status ? 0 : 1 }); await loadChannels(); }
    catch (e: any) { setError(e.message); } finally { setPendingId(null); }
  };

  const syncModels = async (ch: any) => {
    setSyncing(ch.id);
    try {
      const result = await adminApi.syncChannelModels(ch.id);
      setNotice(`同步完成：上游 ${result.count} 个模型，新增 ${result.added} 个模型配置`);
      loadChannels();
    } catch (e: any) { setError('同步失败: ' + e.message); }
    finally { setSyncing(null); }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-2 border-white/10 border-t-white rounded-full animate-spin" /></div>;

  const filteredChannels = channels.filter(channel => {
    const query = values.search.trim().toLowerCase();
    return (!query || [channel.name, channel.type, ...(channel.supportedModels || [])].some(value => String(value).toLowerCase().includes(query)))
      && (values.type === 'all' || channel.type === values.type)
      && (values.status === 'all' || String(channel.status) === values.status)
      && (!values.id || String(channel.id) === values.id);
  });
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

      {error && <div role="alert" className="mb-4 p-4 rounded-xl bg-red-500/10 text-red-500">{error} <button onClick={() => void loadChannels()}>重试</button></div>}
      {notice && <div role="status" className="mb-4 p-3 rounded-xl bg-blue-500/10">{notice}<button onClick={() => setNotice('')} className="ml-3">关闭</button></div>}
      {available && !edit && <button className="mb-3 underline" onClick={restore}>恢复未保存的渠道草稿（密钥需重新输入）</button>}
      <div className="admin-sticky-filters flex flex-wrap gap-3 mb-6 rounded-xl border p-3">
        <input aria-label="搜索渠道" placeholder="搜索渠道名称、类型或模型" value={values.search} onChange={e => setFilter('search', e.target.value)} className="flex-1 min-w-48 rounded-lg border px-3 py-2 text-sm" />
        <select aria-label="渠道类型" value={values.type} onChange={e => setFilter('type', e.target.value)} className="rounded-lg border px-3 py-2 text-sm"><option value="all">全部类型</option>{Array.from(new Set(channels.map(c => c.type))).map(type => <option key={type} value={type}>{type}</option>)}</select>
        <select aria-label="渠道状态" value={values.status} onChange={e => setFilter('status', e.target.value)} className="rounded-lg border px-3 py-2 text-sm"><option value="all">全部状态</option><option value="1">启用</option><option value="0">停用</option></select>
        <button onClick={reset} className="text-xs">清除筛选</button>
        <span className="text-xs self-center">{filteredChannels.length} / {channels.length} 个渠道{values.id ? ' · 已定位关联渠道' : ''}</span>
      </div>
      <details className="mb-4"><summary className="cursor-pointer py-3 font-medium">运行监控与路由策略</summary>
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

      <section className="mb-6 rounded-2xl border border-violet-500/20 bg-violet-500/[0.05] p-4" aria-labelledby="siyuetian-routing-title">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 id="siyuetian-routing-title" className="text-sm font-semibold text-violet-100">四月天 / Julun sd2.5 路由策略</h2>
            <p className="mt-1 text-xs text-zinc-500">
              {siYueTianStrategy === 'round_robin'
                ? '当前严格按请求交替：四月天 1 条、Julun 1 条；单边停用时全部走另一边。'
                : '当前优先四月天，仅在停用或上游饱和时分流到 Julun。'}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 rounded-xl border border-white/[0.07] bg-black/20 p-1" role="group" aria-label="四月天 sd2.5 路由策略">
            <button type="button" disabled={strategySaving} onClick={() => { void saveSiYueTianStrategy('failover'); }}
              className={`rounded-lg px-4 py-2 text-xs font-medium transition-colors disabled:opacity-50 ${siYueTianStrategy === 'failover'
                ? 'bg-violet-500/25 text-violet-100 ring-1 ring-violet-400/30'
                : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}>
              故障分流
            </button>
            <button type="button" disabled={strategySaving} onClick={() => { void saveSiYueTianStrategy('round_robin'); }}
              className={`rounded-lg px-4 py-2 text-xs font-medium transition-colors disabled:opacity-50 ${siYueTianStrategy === 'round_robin'
                ? 'bg-violet-500/25 text-violet-100 ring-1 ring-violet-400/30'
                : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}>
              请求平分
            </button>
          </div>
        </div>
      </section>

      <section className="mb-6 rounded-2xl border border-cyan-500/20 bg-cyan-500/[0.04] p-4" aria-labelledby="routing-stats-title">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 id="routing-stats-title" className="text-sm font-semibold text-cyan-100">视频分流渠道统计</h2>
            <p className="mt-1 text-xs text-zinc-500">仅管理员可见；运行数每 5 秒刷新，成功率不包含运行中任务。</p>
          </div>
          <div className="flex items-center gap-2">
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
            <button type="button" onClick={() => { void loadRoutingStats(); }} disabled={routingStatsLoading}
              className="flex items-center gap-1 rounded-lg border border-cyan-400/20 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-50">
              <RefreshCw className={`h-3.5 w-3.5 ${routingStatsLoading ? 'animate-spin' : ''}`} />
              查询统计
            </button>
          </div>
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
          {routingStats.length === 0 && !routingStatsLoading && (
            <div className="col-span-full rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-xs text-zinc-500" role="status">
              选择时间范围后点击“查询统计”
            </div>
          )}
        </div>
      </section>

      </details>
      <AdminCollection<any> name="channels" items={filteredChannels} id={ch => String(ch.id)} columns={[
        { title: '渠道', sort: ch => ch.name, render: ch => <><strong>{ch.name}</strong><small className="block">{ch.type}</small></> },
        { title: '状态', sort: ch => ch.status, render: ch => ch.status ? '启用' : '停用' },
        { title: '模型 / 并发', sort: ch => ch.supportedModels?.length || 0, render: ch => <>{ch.supportedModels?.length || 0} 个模型<br />{ch.concurrencyRunning || 0} 运行 / {ch.concurrencyQueued || 0} 排队</> },
        { title: '操作', render: ch => <div className="flex flex-wrap gap-2 text-xs"><button onClick={() => { setDetailEditing(false); setDetail(ch); }}>详情与模型</button><button onClick={() => openEdit(ch)}>编辑</button><button disabled={pendingId !== null} onClick={() => toggleStatus(ch)}>{ch.status ? '停用' : '启用'}</button></div> },
      ]}>{visibleChannels => <div className="space-y-4">
        {visibleChannels.map(ch => (
          <div key={ch.id} className={`bg-white/[0.02] border rounded-2xl p-5 ${ch.status ? 'border-white/5' : 'border-red-500/20 opacity-60'}`}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center border border-white/5 ${ch.status ? 'bg-gradient-to-br from-green-500/20 to-emerald-500/20' : 'bg-gradient-to-br from-red-500/20 to-orange-500/20'}`}>
                  <Radio className={`w-5 h-5 ${ch.status ? 'text-green-400' : 'text-red-400'}`} />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">{ch.name}</h3>
                  <p className="text-[10px] text-zinc-500 font-mono"><span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold mr-1.5 ${ch.type === 'gemini' ? 'bg-emerald-500/15 text-emerald-400' : ch.type === 'grok2api' ? 'bg-orange-500/15 text-orange-400' : ch.type === 'hmstudio' ? 'bg-amber-500/15 text-amber-300' : 'bg-blue-500/15 text-blue-400'}`}>{ch.type === 'zongheng' ? '纵横科技' : ch.type === 'openai' ? 'OpenAI' : ch.type === 'gemini' ? 'Gemini' : ch.type === 'grok2api' ? 'Grok2API' : ch.type === 'hmstudio' ? 'HM Studio' : ch.type === 'haya' ? 'Haya AI' : ch.type === 'miaowu' ? '喵呜 API' : ch.type}</span>{ch.baseUrl}</p>
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
                  <>
                    {(ch.apiKeys || []).some((key: any) => key.status === 0) && (
                      <button onClick={() => openEdit(ch)}
                        className="flex items-center gap-1 text-[10px] px-3 py-1 bg-red-500/10 hover:bg-red-500/20 rounded-lg text-red-400">
                        <Power className="w-3 h-3" /> 启动 Key ({(ch.apiKeys || []).filter((key: any) => key.status === 0).length})
                      </button>
                    )}
                    <button onClick={() => openAddHmKey(ch)}
                      className="flex items-center gap-1 text-[10px] px-3 py-1 bg-amber-500/10 hover:bg-amber-500/20 rounded-lg text-amber-300">
                      <KeyRound className="w-3 h-3" /> 添加 Key
                    </button>
                  </>
                )}
                <button onClick={() => { setDetailEditing(false); setDetail(ch); }} className="text-xs px-3 py-1 rounded-lg bg-blue-500/10">关联模型与价格</button>
                <button disabled={pendingId !== null} onClick={() => toggleStatus(ch)} aria-label={ch.status ? `停止 ${ch.name}` : `启动 ${ch.name}`}
                  className={`flex items-center gap-1 rounded-lg px-3 py-1 text-[10px] font-medium transition-colors ${ch.status ? 'bg-green-500/10 text-green-400 hover:bg-green-500/20' : 'bg-red-500/10 text-red-400 hover:bg-red-500/20'}`}>
                  {ch.status ? <PowerOff className="w-3 h-3" /> : <Power className="w-3 h-3" />}
                  {ch.status ? '停止' : '启动'}
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
              {ch.type === 'wx-haidiyue' && <span>人脸拆分: <span className={ch.faceSplitEnabled === 0 ? 'text-zinc-400' : 'text-emerald-300'}>{ch.faceSplitEnabled === 0 ? '关闭' : '开启'}</span></span>}
              {ch.lastTestResult && <span>{ch.lastTestResult.startsWith('auto_disabled:') ? '自动停止' : '最后测试'}: <span className={ch.lastTestResult?.startsWith('success') ? 'text-green-400' : 'text-red-400'}>{ch.lastTestResult.replace(/^auto_disabled:/, '')}</span></span>}
            </div>
          </div>
        ))}
        {filteredChannels.length === 0 && <div className="text-center text-zinc-500 py-12">{channels.length ? "没有符合筛选条件的渠道" : "暂无渠道，点击上方按钮添加"}</div>}
      </div>}</AdminCollection>

      {detail && <AdminDrawer wide title={detail.name + ' · 渠道详情'} blocked={detailEditing || Boolean(edit)} onClose={() => { setDetail(null); void loadChannels(); }}>
        <div className="p-4 flex gap-4"><button disabled={detailEditing} onClick={() => setDetailTab('models')}>关联模型与价格</button><button disabled={detailEditing} onClick={() => setDetailTab('config')}>配置与运行状态</button></div>
        {detailTab === 'models' ? <Suspense fallback={<p className="p-4" role="status">正在加载关联模型…</p>}><ModelsPage key={detail.id} channelId={String(detail.id)} onEditingChange={setDetailEditing} /></Suspense> : <div className="p-5 space-y-3">{(() => { const current = channels.find(ch => ch.id === detail.id) || detail; return <><p>类型：{current.type}</p><p>地址：{current.baseUrl}</p><p>状态：{current.status ? '启用' : '停用'} · 优先级 {current.priority}</p><p>运行 {current.concurrencyRunning || 0} / 排队 {current.concurrencyQueued || 0}</p><div className="flex flex-wrap gap-4"><button onClick={() => openEdit(current)}>编辑渠道配置</button><button disabled={testing !== null} onClick={() => handleTest(current.id)}>测试连接</button><button disabled={syncing !== null} onClick={() => syncModels(current)}>同步模型</button></div></>; })()}</div>}
      </AdminDrawer>}
      {/* Edit Modal */}
      {edit && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={closeEdit}>
          <div role="dialog" aria-modal="true" aria-labelledby="channel-dialog-title" className="bg-[#1a1a1a] border border-white/10 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <p role="alert" className="px-5 text-red-500">{error}</p><h3 id="channel-dialog-title" className="shrink-0 px-5 pt-5 pb-4 md:px-6 md:pt-6 text-lg font-semibold text-white">{edit.isNew ? '添加渠道' : `编辑: ${edit.name}`}</h3>
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
                      faceSplitEnabled: e.target.value === 'wx-haidiyue' && edit.type !== 'wx-haidiyue'
                        ? 1
                        : edit.faceSplitEnabled,
                      apiKeys: e.target.value === 'hmstudio' && (!edit.apiKeys || edit.apiKeys.length === 0)
                        ? [newHmKey()]
                        : edit.apiKeys,
                      baseUrl: e.target.value === 'zongheng' && !edit.baseUrl
                        ? 'https://cnd-coo-new.pages.dev'
                        : e.target.value === 'hmstudio' && !edit.baseUrl
                        ? HM_STUDIO_BASE_URL
                        : e.target.value === 'haya' && !edit.baseUrl
                          ? HAYA_BASE_URL
                        : e.target.value === 'longxia' && !edit.baseUrl
                          ? 'https://api8.longxiaai.store'
                        : e.target.value === 'snumom' && !edit.baseUrl
                          ? 'https://snumom.com'
                          : e.target.value === 'miaowu' && !edit.baseUrl
                            ? MIAOWU_BASE_URL
                          : e.target.value === 'mingfei' && !edit.baseUrl
                            ? 'https://mingfeikeji.qzz.io'
                          : edit.baseUrl,
                    })}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none">
                      <option value="zongheng">纵横科技（视频／图片／GPT）</option>
                      <option value="openai">OpenAI 兼容（Chat 代理）</option>
                      <option value="hmstudio">HM Studio（图片/视频异步任务）</option>
                      <option value="wx-haidiyue">wx-海底月（sd2.5 人脸拆分）</option>
                      <option value="snumom">snumom（视频异步任务）</option>
                      <option value="longxia">LongXia（视频按秒计费）</option>
                      <option value="haya">Haya AI（素材上传／视频异步任务）</option>
                      <option value="miaowu">喵呜 API（视频异步任务）</option>
                      <option value="mingfei">MingFei（GPT Image 2 异步任务）</option>
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
              {edit.type === 'zongheng' && <p className="text-xs leading-5 text-zinc-400">同步模型会创建带 zongheng- 前缀的停用入口；请核对模型能力、配置价格后启用。视频参考素材提交时上传，图片暂仅支持文生图。</p>}
              {edit.type === 'wx-haidiyue' && (
                <section aria-labelledby="haidi-face-split-title" className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3.5 sm:p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <h4 id="haidi-face-split-title" className="flex items-center gap-2 text-sm font-semibold text-emerald-100">
                        <ScanFace className="h-4 w-4 text-emerald-300" /> 默认人脸拆分
                      </h4>
                      <p id="haidi-face-split-description" className="mt-1 text-[11px] leading-5 text-zinc-500">
                        控制备用分流的默认值；用户端 sd2.5 人脸拆分选项始终开启，不会影响 HM Studio。
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={edit.faceSplitEnabled !== 0}
                      aria-describedby="haidi-face-split-description"
                      onClick={() => setEdit({ ...edit, faceSplitEnabled: edit.faceSplitEnabled === 0 ? 1 : 0 })}
                      className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 ${edit.faceSplitEnabled === 0 ? 'border-white/10 bg-zinc-700' : 'border-emerald-400/30 bg-emerald-500'}`}
                    >
                      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${edit.faceSplitEnabled === 0 ? 'translate-x-0.5' : 'translate-x-6'}`} />
                      <span className="sr-only">{edit.faceSplitEnabled === 0 ? '开启默认人脸拆分' : '关闭默认人脸拆分'}</span>
                    </button>
                  </div>
                </section>
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
                          <button type="button" onClick={() => void toggleHmKeyStatus(index, key)}
                            aria-label={`${key.status === 0 ? '启用' : '停用'} API Key ${index + 1}`}
                            className={`h-9 rounded-lg px-3 text-xs font-medium transition-colors ${key.status === 0 ? 'bg-white/5 text-zinc-400 hover:bg-white/10' : 'bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'}`}>
                            {key.status === 0 ? '启动' : '停止'}
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
              <button onClick={closeEdit} className="flex-1 py-2.5 bg-white/5 hover:bg-white/10 rounded-xl text-sm transition-colors">取消</button>
              <button disabled={saving} onClick={handleSave} className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-medium transition-colors">{saving ? "保存中…" : "保存"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
