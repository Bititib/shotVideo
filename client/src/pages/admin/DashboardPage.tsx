import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi } from '../../api/admin';
import { Users, Zap, TrendingUp, BarChart, Settings, Save, Check } from 'lucide-react';

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
          { label: '总调用量', value: stats?.totalCalls || 0, icon: BarChart, color: 'from-[#c47750] to-[#97482f]' },
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

      {/* Charts Area */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* 7-day Trend */}
        <div className="bg-white/[0.03] border border-white/5 rounded-2xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4">近7天调用趋势</h3>
          <div className="space-y-2">
            {stats?.trend7Days?.map((d: any, i: number) => {
              const max = Math.max(...(stats.trend7Days?.map((x: any) => x.count) || [1]));
              return (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-[10px] text-zinc-500 w-20">{d.date?.slice(5)}</span>
                  <div className="flex-1 h-5 bg-white/5 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-blue-500 to-purple-500 rounded-full transition-all" style={{ width: `${(d.count / max) * 100}%` }} />
                  </div>
                  <span className="text-xs text-zinc-400 w-8 text-right">{d.count}</span>
                </div>
              );
            })}
            {(!stats?.trend7Days || stats.trend7Days.length === 0) && <p className="text-xs text-zinc-600 text-center py-4">暂无数据</p>}
          </div>
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
          <h3 className="text-sm font-semibold text-white mb-4">功能使用分布</h3>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {stats?.featureDistribution?.map((d: any, i: number) => {
              const names: Record<string, string> = { general: '通用分析', ecommerce: '带货分析', image: '图片逆向', copywriting: '电商文案', account: '账号分析', generate_image: 'AI生图', modify_prompt: '换品' };
              return (
                <div key={i} className="bg-white/[0.02] border border-white/5 rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold text-white">{d.count}</p>
                  <p className="text-[10px] text-zinc-500 mt-1">{names[d.type] || d.type}</p>
                </div>
              );
            })}
            {(!stats?.featureDistribution || stats.featureDistribution.length === 0) && <p className="text-xs text-zinc-600 col-span-5 text-center py-4">暂无数据</p>}
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
