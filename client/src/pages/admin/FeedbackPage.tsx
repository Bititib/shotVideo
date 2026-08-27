import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Clock3, ExternalLink, MessageSquareWarning, Search, Send, UserRound, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { adminApi } from '../../api/admin';

interface FeedbackItem {
  id: number;
  userId: number;
  userEmail: string | null;
  userName: string | null;
  contentId: number | null;
  contentTitle: string | null;
  contentStatus: string | null;
  modelId: string;
  errorMessage: string;
  description: string;
  status: 'pending' | 'reviewing' | 'resolved' | 'ignored';
  adminNote: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

const statusMeta = {
  pending: { label: '待处理', className: 'border-[#e5b979] bg-[#fff3d9] text-[#9a5e1d]', icon: AlertTriangle },
  reviewing: { label: '处理中', className: 'border-[#c9ad8d] bg-[#f2e4d3] text-[#82543c]', icon: Clock3 },
  resolved: { label: '已解决', className: 'border-[#abd0b6] bg-[#e9f5ec] text-[#3c7750]', icon: CheckCircle2 },
  ignored: { label: '已忽略', className: 'border-[#d4c8bc] bg-[#f2ede7] text-[#786b60]', icon: X },
};

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

export default function FeedbackPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [total, setTotal] = useState(0);
  const [pending, setPending] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(12);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<FeedbackItem | null>(null);
  const [editStatus, setEditStatus] = useState<FeedbackItem['status']>('pending');
  const [adminNote, setAdminNote] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminApi.getFeedback({ page, pageSize, status: status || undefined, search: search || undefined });
      setItems(data.items || []);
      setTotal(data.total || 0);
      setPending(data.pending || 0);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, status, search]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const resolvedCount = useMemo(() => items.filter(item => item.status === 'resolved').length, [items]);

  const openFeedback = (item: FeedbackItem) => {
    setSelected(item);
    setEditStatus(item.status);
    setAdminNote(item.adminNote || '');
  };

  const saveFeedback = async () => {
    if (!selected || saving) return;
    setSaving(true);
    try {
      await adminApi.updateFeedback(selected.id, { status: editStatus, adminNote });
      setSelected(null);
      await load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-full space-y-6 bg-[#f8f1e7] p-5 text-[#4b3428] md:p-7">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#d8b894] bg-[#f0ddc8] text-[#a45736] shadow-sm">
              <MessageSquareWarning className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-xl font-bold text-[#3f2c23]">模型故障反馈</h1>
              <p className="mt-0.5 text-xs text-[#876d5c]">集中查看用户提交的模型失败信息并记录处理结果。</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 text-center sm:min-w-[330px]">
          <div className="rounded-xl border border-[#dcc4a6] bg-[#fffaf2] px-3 py-2.5"><strong className="block text-lg text-[#4b3428]">{total}</strong><span className="text-[10px] text-[#947663]">全部反馈</span></div>
          <div className="rounded-xl border border-[#e5c38f] bg-[#fff4df] px-3 py-2.5"><strong className="block text-lg text-[#a16024]">{pending}</strong><span className="text-[10px] text-[#9a744e]">待处理</span></div>
          <div className="rounded-xl border border-[#bed7c4] bg-[#edf7ef] px-3 py-2.5"><strong className="block text-lg text-[#477a56]">{resolvedCount}</strong><span className="text-[10px] text-[#688a70]">本页解决</span></div>
        </div>
      </header>

      <section className="flex flex-col gap-3 rounded-2xl border border-[#dcc4a6] bg-[#fffaf2] p-4 shadow-[0_10px_30px_rgba(80,52,34,0.06)] sm:flex-row">
        <label className="relative min-w-0 flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#a58a76]" />
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="搜索模型、错误或用户……" className="w-full rounded-xl border border-[#dec5a7] bg-[#fffdf8] py-2.5 pl-9 pr-3 text-sm text-[#4b3428] outline-none transition placeholder:text-[#ae9888] focus:border-[#b86a44] focus:ring-4 focus:ring-[#b86a44]/10" />
        </label>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="rounded-xl border border-[#dec5a7] bg-[#fffdf8] px-3 py-2.5 text-sm text-[#5f4638] outline-none focus:border-[#b86a44]">
          <option value="">全部状态</option>
          <option value="pending">待处理</option>
          <option value="reviewing">处理中</option>
          <option value="resolved">已解决</option>
          <option value="ignored">已忽略</option>
        </select>
      </section>

      {loading ? (
        <div className="flex min-h-72 items-center justify-center text-sm text-[#927663]">正在加载反馈…</div>
      ) : items.length === 0 ? (
        <div className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-[#d8bea0] bg-[#fffaf2]/70 text-[#947663]">
          <CheckCircle2 className="mb-3 h-9 w-9 text-[#79a585]" />
          <p className="text-sm font-medium">当前没有符合条件的反馈</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {items.map(item => {
            const meta = statusMeta[item.status] || statusMeta.pending;
            const StatusIcon = meta.icon;
            return (
              <article key={item.id} className="overflow-hidden rounded-2xl border border-[#dcc4a6] bg-[#fffaf2] shadow-[0_10px_28px_rgba(80,52,34,0.06)] transition hover:-translate-y-0.5 hover:border-[#c58e68] hover:shadow-[0_15px_34px_rgba(80,52,34,0.10)]">
                <div className="flex items-start justify-between gap-3 border-b border-[#ead8c3] px-5 py-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <code className="truncate text-sm font-semibold text-[#6f3e2b]">{item.modelId}</code>
                      <span className="text-[10px] text-[#a58a76]">#{item.id}</span>
                    </div>
                    <p className="mt-1 flex items-center gap-1.5 truncate text-[11px] text-[#8b6f5d]"><UserRound className="h-3 w-3" />{item.userName || item.userEmail || `用户 #${item.userId}`}</p>
                  </div>
                  <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-semibold ${meta.className}`}><StatusIcon className="h-3 w-3" />{meta.label}</span>
                </div>

                <div className="space-y-3 px-5 py-4">
                  <div className="rounded-xl border border-[#ecc8b8] bg-[#fff1eb] p-3">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[#a95a3f]">失败信息</p>
                    <p className="line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-[#8d4232]">{item.errorMessage}</p>
                  </div>
                  {item.description && <p className="line-clamp-2 text-xs leading-relaxed text-[#6f594b]"><span className="font-semibold">用户说明：</span>{item.description}</p>}
                  {item.adminNote && <p className="line-clamp-2 rounded-lg bg-[#f3e7d8] px-3 py-2 text-xs text-[#725442]"><span className="font-semibold">处理备注：</span>{item.adminNote}</p>}
                </div>

                <footer className="flex items-center justify-between gap-3 border-t border-[#ead8c3] bg-[#fcf5eb] px-5 py-3">
                  <div className="text-[10px] text-[#9b806e]">
                    <span>{formatDate(item.createdAt)}</span>
                    {item.contentId && <button onClick={() => navigate(`/admin/contents?search=${encodeURIComponent(String(item.contentId))}`)} className="ml-3 inline-flex items-center gap-1 text-[#a45736] hover:text-[#7c3f29]"><ExternalLink className="h-3 w-3" />任务 #{item.contentId}</button>}
                  </div>
                  <button onClick={() => openFeedback(item)} className="rounded-lg border border-[#c89570] bg-[#f2dfca] px-3 py-1.5 text-[11px] font-semibold text-[#7c432d] transition hover:bg-[#e8ceb3]">查看并处理</button>
                </footer>
              </article>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-[#8d725f]">
        <span>第 {page} / {totalPages} 页</span>
        <div className="flex gap-2">
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="rounded-lg border border-[#dec5a7] bg-[#fffaf2] p-2 transition hover:bg-[#f0e1cf] disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
          <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className="rounded-lg border border-[#dec5a7] bg-[#fffaf2] p-2 transition hover:bg-[#f0e1cf] disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>

      {selected && createPortal(
        <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-[#302721]/60 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) setSelected(null); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="admin-feedback-title" className="w-full max-w-xl overflow-hidden rounded-2xl border border-[#d9bea0] bg-[#fffaf2] shadow-[0_28px_80px_rgba(57,39,27,0.28)]">
            <header className="flex items-start justify-between border-b border-[#e2ccb1] px-6 py-5">
              <div><h2 id="admin-feedback-title" className="font-semibold text-[#4c3328]">处理反馈 #{selected.id}</h2><p className="mt-1 text-xs text-[#876b59]">{selected.modelId} · {selected.userEmail || selected.userName}</p></div>
              <button onClick={() => setSelected(null)} aria-label="关闭" className="rounded-lg p-1.5 text-[#9a7a65] hover:bg-[#ead8c4]"><X className="h-4 w-4" /></button>
            </header>
            <div className="space-y-4 px-6 py-5">
              <div className="rounded-xl border border-[#ecc8b8] bg-[#fff1eb] p-4"><p className="text-[10px] font-semibold uppercase tracking-wider text-[#a95a3f]">错误详情</p><p className="mt-2 max-h-36 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-[#8d4232]">{selected.errorMessage}</p></div>
              {selected.description && <div><p className="mb-1.5 text-xs font-semibold text-[#725442]">用户补充</p><p className="rounded-xl border border-[#dec5a7] bg-[#fbf2e7] p-3 text-xs leading-relaxed text-[#6f594b]">{selected.description}</p></div>}
              <label className="block"><span className="mb-2 block text-xs font-semibold text-[#725442]">处理状态</span><select value={editStatus} onChange={(e) => setEditStatus(e.target.value as FeedbackItem['status'])} className="w-full rounded-xl border border-[#dec5a7] bg-[#fffdf8] px-3 py-2.5 text-sm text-[#4b3428] outline-none focus:border-[#b86a44]"><option value="pending">待处理</option><option value="reviewing">处理中</option><option value="resolved">已解决</option><option value="ignored">已忽略</option></select></label>
              <label className="block"><span className="mb-2 block text-xs font-semibold text-[#725442]">管理员备注</span><textarea value={adminNote} onChange={(e) => setAdminNote(e.target.value.slice(0, 2000))} rows={4} placeholder="记录排查结果、解决方案或后续安排……" className="w-full resize-none rounded-xl border border-[#dec5a7] bg-[#fffdf8] px-3.5 py-3 text-sm text-[#4c3328] outline-none focus:border-[#b86a44] focus:ring-4 focus:ring-[#b86a44]/10 placeholder:text-[#b19a89]" /></label>
            </div>
            <footer className="flex gap-3 border-t border-[#e2ccb1] bg-[#fbf3e8] px-6 py-4"><button onClick={() => setSelected(null)} className="flex-1 rounded-xl border border-[#dec5a7] bg-[#fffaf2] py-2.5 text-xs font-medium text-[#684f40] hover:bg-[#efe0cf]">取消</button><button onClick={saveFeedback} disabled={saving} className="flex-1 rounded-xl border border-[#8f4027] bg-[#a64f30] py-2.5 text-xs font-semibold text-white shadow-[0_6px_16px_rgba(145,65,39,0.2)] hover:bg-[#8f4027] disabled:opacity-60"><span className="flex items-center justify-center gap-1.5"><Send className="h-3.5 w-3.5" />{saving ? '保存中…' : '保存处理结果'}</span></button></footer>
          </section>
        </div>,
        document.body
      )}
    </div>
  );
}
