import React, { useEffect, useState } from 'react';
import { orgApi } from '../../api/org';
import { useAuthStore } from '../../stores/authStore';
import { Users, Activity, FolderOpen, Wallet, TrendingUp, Crown, BarChart3, PieChart } from 'lucide-react';

const featureNames: Record<string, string> = {
  general: '通用分析', ecommerce: '带货分析', image: '图片逆向',
  copywriting: '电商文案', account: '账号分析', generate_image: 'AI 生图',
  generate_video: '视频生成', modify_prompt: '换品',
};

const contentTypeNames: Record<string, string> = {
  video: '视频', image: '图片', analysis: '分析', copywriting: '文案',
};

const contentTypeColors: Record<string, string> = {
  video: 'bg-indigo-500', image: 'bg-pink-500', analysis: 'bg-blue-500', copywriting: 'bg-orange-500',
};

export default function OrgDashboard() {
  const { user } = useAuthStore();
  const [orgInfo, setOrgInfo] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      orgApi.getMyOrg(),
      orgApi.getUsage(),
    ]).then(([org, usage]) => {
      setOrgInfo(org);
      setStats(usage);
    }).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-2 border-white/10 border-t-white rounded-full animate-spin" /></div>;
  if (!orgInfo) return <div className="flex items-center justify-center h-full text-zinc-500">您不属于任何组织</div>;

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">📊 {orgInfo.name}</h1>
          <p className="text-xs text-zinc-500 mt-1">团队概览 · {orgInfo.slug}</p>
        </div>
        <span className="px-3 py-1 bg-teal-500/10 text-teal-400 text-xs rounded-lg font-medium">{orgInfo.tierName}</span>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        {[
          { label: '团队成员', value: orgInfo.memberCount || 0, icon: Users, color: 'from-blue-500 to-blue-600' },
          { label: '今日调用', value: stats?.todayCalls || 0, icon: Activity, color: 'from-green-500 to-emerald-600' },
          { label: '总调用量', value: stats?.totalCalls || 0, icon: TrendingUp, color: 'from-purple-500 to-pink-600' },
          { label: '总内容', value: stats?.totalContents || 0, icon: FolderOpen, color: 'from-cyan-500 to-teal-600' },
          { label: '组织余额', value: `¥${(orgInfo.balance || 0).toFixed(2)}`, icon: Wallet, color: 'from-amber-500 to-orange-600', isString: true },
        ].map((card, i) => (
          <div key={i} className="bg-white/[0.03] border border-white/5 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-zinc-500">{card.label}</span>
              <div className={`w-8 h-8 rounded-lg bg-gradient-to-br ${card.color} flex items-center justify-center`}>
                <card.icon className="w-4 h-4 text-white" />
              </div>
            </div>
            <p className={`${(card as any).isString ? 'text-xl' : 'text-2xl'} font-bold text-white`}>
              {(card as any).isString ? card.value : (card.value as number).toLocaleString()}
            </p>
          </div>
        ))}
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* 7-day Trend */}
        <div className="bg-white/[0.03] border border-white/5 rounded-2xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <BarChart3 className="w-4 h-4 text-teal-400" />
            <h3 className="text-sm font-semibold text-white">近 7 天调用趋势</h3>
          </div>
          <div className="space-y-2.5">
            {stats?.trend7Days?.length > 0 ? stats.trend7Days.map((d: any, i: number) => {
              const max = Math.max(...stats.trend7Days.map((x: any) => x.count), 1);
              return (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-[10px] text-zinc-500 w-14 shrink-0">{d.date?.slice(5)}</span>
                  <div className="flex-1 h-5 bg-white/5 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-teal-500 to-cyan-500 rounded-full transition-all duration-500" style={{ width: `${Math.max(2, (d.count / max) * 100)}%` }} />
                  </div>
                  <span className="text-xs text-zinc-400 w-8 text-right shrink-0">{d.count}</span>
                </div>
              );
            }) : <p className="text-xs text-zinc-600 text-center py-4">暂无数据</p>}
          </div>
        </div>

        {/* Feature Distribution */}
        <div className="bg-white/[0.03] border border-white/5 rounded-2xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <PieChart className="w-4 h-4 text-purple-400" />
            <h3 className="text-sm font-semibold text-white">功能使用分布</h3>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {stats?.featureDistribution?.length > 0 ? stats.featureDistribution.map((d: any, i: number) => (
              <div key={i} className="bg-white/[0.02] border border-white/5 rounded-xl p-3 text-center">
                <p className="text-xl font-bold text-white">{d.count}</p>
                <p className="text-[10px] text-zinc-500 mt-1">{featureNames[d.type] || d.type}</p>
              </div>
            )) : <p className="text-xs text-zinc-600 text-center py-4 col-span-2">暂无数据</p>}
          </div>
        </div>
      </div>

      {/* Cost Breakdown */}
      {stats?.costBreakdown?.length > 0 && (
        <div className="bg-white/[0.03] border border-white/5 rounded-2xl p-5 mb-8">
          <div className="flex items-center gap-2 mb-4">
            <Wallet className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-semibold text-white">消费明细</h3>
            <span className="ml-auto text-xs text-amber-400 font-medium">合计 ¥{(stats.totalCost || 0).toFixed(2)}</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {stats.costBreakdown.map((item: any, i: number) => (
              <div key={i} className="bg-white/[0.02] border border-white/5 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <div className={`w-2.5 h-2.5 rounded-full ${contentTypeColors[item.type] || 'bg-zinc-500'}`} />
                  <span className="text-xs text-zinc-400">{contentTypeNames[item.type] || item.type}</span>
                </div>
                <p className="text-lg font-bold text-white">¥{item.totalCost.toFixed(2)}</p>
                <p className="text-[10px] text-zinc-500 mt-1">{item.count} 次生成</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Member Usage Table */}
      <div className="bg-white/[0.03] border border-white/5 rounded-2xl p-5">
        <h3 className="text-sm font-semibold text-white mb-4">成员用量 & 消费排行</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/5">
                <th className="text-left py-3 px-3 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">成员</th>
                <th className="text-right py-3 px-3 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">今日用量</th>
                <th className="text-right py-3 px-3 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">总用量</th>
                <th className="text-right py-3 px-3 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">内容数</th>
                <th className="text-right py-3 px-3 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">消费金额</th>
              </tr>
            </thead>
            <tbody>
              {stats?.memberStats?.length > 0 ? stats.memberStats
                .sort((a: any, b: any) => b.totalCost - a.totalCost)
                .map((m: any) => {
                const maxCost = Math.max(...stats.memberStats.map((x: any) => x.totalCost), 0.01);
                return (
                  <tr key={m.userId} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-teal-500/20 to-cyan-500/20 flex items-center justify-center text-[10px] font-bold text-teal-400">
                          {m.username?.[0]?.toUpperCase() || '?'}
                        </div>
                        <div>
                          <p className="text-xs text-white">{m.username}</p>
                          <p className="text-[10px] text-zinc-500">{m.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-12 h-1.5 bg-white/5 rounded-full overflow-hidden">
                          <div className="h-full bg-gradient-to-r from-teal-500 to-cyan-500 rounded-full" style={{ width: `${Math.max(2, (m.todayUsage / Math.max(...stats.memberStats.map((x: any) => x.todayUsage), 1)) * 100)}%` }} />
                        </div>
                        <span className="text-xs text-zinc-300 w-6 text-right">{m.todayUsage}</span>
                      </div>
                    </td>
                    <td className="py-3 px-3 text-right text-xs text-zinc-400">{m.totalUsage}</td>
                    <td className="py-3 px-3 text-right text-xs text-zinc-400">{m.contentCount}</td>
                    <td className="py-3 px-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-12 h-1.5 bg-white/5 rounded-full overflow-hidden">
                          <div className="h-full bg-gradient-to-r from-amber-500 to-orange-500 rounded-full" style={{ width: `${(m.totalCost / maxCost) * 100}%` }} />
                        </div>
                        <span className="text-xs text-amber-400 w-14 text-right font-medium">¥{m.totalCost.toFixed(2)}</span>
                      </div>
                    </td>
                  </tr>
                );
              }) : (
                <tr><td colSpan={5} className="py-8 text-center text-zinc-500 text-xs">暂无成员用量数据</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
