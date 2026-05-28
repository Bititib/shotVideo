import React, { useEffect, useState, useCallback } from 'react';
import { contentApi } from '../../api/content';
import { Video, Image, FileText, Megaphone, Search, ChevronLeft, ChevronRight, Trash2, ExternalLink } from 'lucide-react';

const typeConfig: Record<string, { icon: any; label: string; color: string }> = {
  video: { icon: Video, label: '视频', color: 'text-indigo-400' },
  image: { icon: Image, label: '图片', color: 'text-pink-400' },
  analysis: { icon: FileText, label: '分析', color: 'text-blue-400' },
  copywriting: { icon: Megaphone, label: '文案', color: 'text-orange-400' },
};

export default function OrgContentsPage() {
  const [data, setData] = useState<any>({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [typeFilter, setTypeFilter] = useState('');
  const [search, setSearch] = useState('');
  const pageSize = 20;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await contentApi.getOrgContents({ page, pageSize, type: typeFilter || undefined, search: search || undefined });
      setData(result);
    } finally { setLoading(false); }
  }, [page, typeFilter, search]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.ceil(data.total / pageSize);

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">📁 团队内容</h1>
        <span className="text-xs text-zinc-500">共 {data.total} 条内容</span>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-5">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input type="text" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="搜索标题..." className="w-full bg-white/5 border border-white/10 rounded-xl pl-9 pr-4 py-2 text-sm text-white focus:outline-none focus:border-teal-500/50 placeholder:text-zinc-600" />
        </div>
        <div className="flex gap-1.5">
          <button onClick={() => { setTypeFilter(''); setPage(1); }} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${!typeFilter ? 'bg-white/10 text-white' : 'text-zinc-400 hover:text-white hover:bg-white/5'}`}>全部</button>
          {Object.entries(typeConfig).map(([key, cfg]) => (
            <button key={key} onClick={() => { setTypeFilter(key); setPage(1); }} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${typeFilter === key ? 'bg-white/10 text-white' : 'text-zinc-400 hover:text-white hover:bg-white/5'}`}>
              {cfg.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content Grid */}
      <div className="space-y-2">
        {loading ? (
          <div className="flex justify-center py-12"><div className="w-6 h-6 border-2 border-white/10 border-t-white rounded-full animate-spin" /></div>
        ) : data.items.length === 0 ? (
          <div className="text-center py-12 text-zinc-500 text-sm">暂无内容</div>
        ) : data.items.map((item: any) => {
          const cfg = typeConfig[item.type] || { icon: FileText, label: item.type, color: 'text-zinc-400' };
          const Icon = cfg.icon;
          return (
            <div key={item.id} className="bg-white/[0.02] border border-white/5 rounded-xl p-4 hover:border-white/10 transition-colors flex items-center gap-4">
              <div className={`w-9 h-9 rounded-lg bg-white/5 flex items-center justify-center shrink-0`}>
                <Icon className={`w-4 h-4 ${cfg.color}`} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">{item.title || '未命名'}</p>
                <div className="flex items-center gap-3 mt-1">
                  <span className="text-[10px] text-zinc-500">{item.userName || item.userEmail}</span>
                  <span className="text-[10px] text-zinc-600">•</span>
                  <span className="text-[10px] text-zinc-500">{new Date(item.createdAt).toLocaleString()}</span>
                  {item.cost > 0 && (
                    <>
                      <span className="text-[10px] text-zinc-600">•</span>
                      <span className="text-[10px] text-amber-400">¥{item.cost.toFixed(3)}</span>
                    </>
                  )}
                </div>
              </div>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-md ${cfg.color} bg-white/5`}>{cfg.label}</span>
              {item.resultUrl && (
                <a href={item.resultUrl} target="_blank" rel="noreferrer" className="p-1.5 hover:bg-white/10 rounded-lg transition-colors">
                  <ExternalLink className="w-3.5 h-3.5 text-zinc-400" />
                </a>
              )}
            </div>
          );
        })}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-6">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="p-2 rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-30 transition-colors">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-xs text-zinc-400">{page} / {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="p-2 rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-30 transition-colors">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
