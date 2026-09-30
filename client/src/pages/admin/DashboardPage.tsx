import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi } from '../../api/admin';
import { Users, Zap, TrendingUp, BarChart as BarChartIcon, Settings, Save, Check, Video, Image, Mic2, ScanText } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

const USAGE_TYPES = [
  { type: 'video', label: '视频生成', color: '#a95b38', icon: Video },
  { type: 'image', label: '图片生成', color: '#c18a45', icon: Image },
  { type: 'audio', label: '语音生成', color: '#65724a', icon: Mic2 },
  { type: 'analysis', label: '分析工具', color: '#7f6a99', icon: ScanText },
] as const;

const chartTooltipStyle = {
  backgroundColor: '#201d19',
  border: '1px solid rgba(255,255,255,.12)',
  borderRadius: 12,
  color: '#fff',
  fontSize: 12,
};

export default function DashboardPage() {
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [settingsList, setSettingsList] = useState<any[]>([]);
  const [settingsForm, setSettingsForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    adminApi.getDashboard().then(setStats).finally(() => setLoading(false));
    adminApi.getSettings().then(list => {
      setSettingsList(list);
      const form: Record<string, string> = {};
      list.forEach((s: any) => { form[s.key] = s.value; });
      setSettingsForm(form);
    });
  }, []);

  const handleSaveSettings = async () => {
    setSaving(true);
    try {
      const items = Object.entries(settingsForm)
        .filter(([key]) => !key.includes('_rate') && key !== 'image_rate')
        .map(([key, value]) => ({ key, value: value as string }));
      await adminApi.updateSettings(items);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      alert(err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-2 border-white/10 border-t-white rounded-full animate-spin" /></div>;

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold text-white mb-8">📊 系统概览</h1>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {[
          { label: '总用户', value: stats?.totalUsers || 0, icon: Users, color: 'from-[#a95b38] to-[#7f3e25]' },
          { label: '今日活跃', value: stats?.todayActiveUsers || 0, icon: Zap, color: 'from-[#78855b] to-[#596740]' },
          { label: '今日调用', value: stats?.todayCalls || 0, icon: TrendingUp, color: 'from-[#c18a45] to-[#9c682c]' },
          { label: '总调用量', value: stats?.totalCalls || 0, icon: BarChartIcon, color: 'from-[#c47750] to-[#97482f]' },
        ].map((card, i) => (
          <div key={i} className="bg-white/[0.03] border border-white/5 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-zinc-500">{card.label}</span>
              <div className={`w-8 h-8 rounded-lg bg-gradient-to-br ${card.color} flex items-center justify-center`}>
                <card.icon className="w-4 h-4 text-white" />
              </div>
            </div>
            <p className="text-3xl font-bold text-white">{card.value.toLocaleString()}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {USAGE_TYPES.map(item => {
          const count = Number(stats?.usageTypeDistribution?.find((row: any) => row.type === item.type)?.count || 0);
          const Icon = item.icon;
          return (
            <div key={item.type} className="rounded-2xl border border-white/5 bg-white/[0.03] p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs text-zinc-500">{item.label}</span>
                <Icon className="h-4 w-4" style={{ color: item.color }} />
              </div>
              <div className="flex items-end justify-between gap-2">
                <p className="text-2xl font-bold text-white">{count.toLocaleString()}</p>
                <p className="text-[10px] text-zinc-500">
                  {stats?.totalCalls ? `${(count / stats.totalCalls * 100).toFixed(1)}%` : '0%'}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Charts Area */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* 7-day Trend */}
        <div className="bg-white/[0.03] border border-white/5 rounded-2xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4">近7天分类调用趋势</h3>
          {stats?.trend7DaysByType?.length ? (
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.trend7DaysByType} margin={{ top: 8, right: 4, left: -24, bottom: 0 }}>
                  <CartesianGrid stroke="rgba(255,255,255,.06)" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={(value) => String(value).slice(5)} tick={{ fill: '#71717a', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fill: '#71717a', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={chartTooltipStyle} labelFormatter={(value) => `日期 ${value}`} />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                  {USAGE_TYPES.map(item => <Bar key={item.type} dataKey={item.type} name={item.label} stackId="calls" fill={item.color} />)}
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <p className="text-xs text-zinc-600 text-center py-24">暂无数据</p>}
        </div>

        {/* Tier Distribution */}
        <div className="bg-white/[0.03] border border-white/5 rounded-2xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4">用户等级分布</h3>
          <div className="space-y-3">
            {stats?.tierDistribution?.map((d: any, i: number) => {
              const total = stats.tierDistribution.reduce((s: number, x: any) => s + x.count, 0) || 1;
              const colors = ['bg-[#9a4f2f]', 'bg-[#ba7a32]', 'bg-[#65724a]', 'bg-[#c28c62]'];
              return (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-xs text-zinc-400 w-20">{d.tierName || '未知'}</span>
                  <div className="flex-1 h-4 bg-white/5 rounded-full overflow-hidden">
                    <div className={`h-full ${colors[i % colors.length]} rounded-full`} style={{ width: `${(d.count / total) * 100}%` }} />
                  </div>
                  <span className="text-xs text-zinc-400 w-8 text-right">{d.count}</span>
                </div>
              );
            })}
            {(!stats?.tierDistribution || stats.tierDistribution.length === 0) && <p className="text-xs text-zinc-600 text-center py-4">暂无数据</p>}
          </div>
        </div>

        {/* Feature Distribution */}
        <div className="bg-white/[0.03] border border-white/5 rounded-2xl p-5 lg:col-span-2">
          <h3 className="text-sm font-semibold text-white mb-4">调用类型分布</h3>
          <div className="grid items-center gap-6 md:grid-cols-2">
            <div className="relative h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={stats?.usageTypeDistribution || []}
                    dataKey="count"
                    nameKey="type"
                    innerRadius={68}
                    outerRadius={98}
                    paddingAngle={3}
                  >
                    {USAGE_TYPES.map(item => <Cell key={item.type} fill={item.color} stroke="transparent" />)}
                  </Pie>
                  <Tooltip
                    contentStyle={chartTooltipStyle}
                    formatter={(value: any, _name: any, context: any) => [Number(value).toLocaleString(), USAGE_TYPES.find(item => item.type === context?.payload?.type)?.label || context?.payload?.type]}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-3xl font-bold text-white">{Number(stats?.totalCalls || 0).toLocaleString()}</span>
                <span className="text-[10px] text-zinc-500">累计调用</span>
              </div>
            </div>
            <div className="space-y-3">
              {USAGE_TYPES.map(item => {
                const count = Number(stats?.usageTypeDistribution?.find((row: any) => row.type === item.type)?.count || 0);
                const percent = stats?.totalCalls ? count / stats.totalCalls * 100 : 0;
                return (
                  <div key={item.type} className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
                    <div className="mb-2 flex items-center justify-between text-xs">
                      <span className="flex items-center gap-2 text-zinc-300"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />{item.label}</span>
                      <span className="font-medium text-white">{count.toLocaleString()} <span className="ml-1 text-zinc-500">{percent.toFixed(1)}%</span></span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-white/5"><div className="h-full rounded-full" style={{ width: `${percent}%`, backgroundColor: item.color }} /></div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* 系统设置 */}
      <div className="bg-white/[0.03] border border-white/5 rounded-2xl p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-blue-400" />
            <h3 className="text-base font-semibold text-white">系统设置</h3>
          </div>
          <button
            onClick={handleSaveSettings}
            disabled={saving}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium transition-all ${
              saved
                ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                : 'bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20'
            }`}
          >
            {saved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
            {saving ? '保存中...' : saved ? '已保存' : '保存设置'}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {settingsList.filter(s => !s.key.includes('_rate') && s.key !== 'image_rate').map(s => (
            <div key={s.key} className={s.key === 'site_notice' ? 'md:col-span-2' : ''}>
              <label className="block text-xs text-zinc-400 mb-1.5">{s.label}</label>
              {s.key === 'site_notice' ? (
                <textarea
                  value={settingsForm[s.key] || ''}
                  onChange={e => setSettingsForm(prev => ({ ...prev, [s.key]: e.target.value }))}
                  rows={2}
                  className="w-full bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500/50 transition-all placeholder:text-zinc-600 resize-none"
                  placeholder={`请输入${s.label}`}
                />
              ) : (
                <input
                  type="text"
                  value={settingsForm[s.key] || ''}
                  onChange={e => setSettingsForm(prev => ({ ...prev, [s.key]: e.target.value }))}
                  className="w-full bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500/50 transition-all placeholder:text-zinc-600"
                  placeholder={`请输入${s.label}`}
                />
              )}
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3">
          <p className="text-xs text-zinc-500">模型价格已统一迁移，不再在仪表盘中重复维护。</p>
          <Link to="/admin/pricing" className="text-xs font-semibold text-amber-400 hover:underline">前往计费设置 →</Link>
        </div>
      </div>
    </div>
  );
}
