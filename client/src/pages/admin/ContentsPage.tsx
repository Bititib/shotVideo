import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Film, Copy, ChevronLeft, ChevronRight, Filter, Image, Video, Music, Eye, X, Play } from 'lucide-react';
import { adminApi } from '../../api/admin';

interface ContentItem {
  id: number;
  userId: number;
  type: string;
  title: string;
  inputText: string | null;
  resultUrl: string | null;
  modelId: string | null;
  cost: number;
  metadata: string;
  status: string;
  createdAt: string;
  userEmail: string | null;
  userName: string | null;
}

export default function ContentsPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<ContentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(12);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('video');
  const [loading, setLoading] = useState(false);
  const [previewItem, setPreviewItem] = useState<ContentItem | null>(null);
  const [previewTab, setPreviewTab] = useState<'video' | 'refs'>('video');

  const fetchContents = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminApi.getContents({
        page,
        pageSize,
        search: search || undefined,
        status: statusFilter || undefined,
        type: typeFilter || undefined
      });
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, search, statusFilter, typeFilter]);

  useEffect(() => { fetchContents(); }, [fetchContents]);

  const totalPages = Math.ceil(total / pageSize);

  const handleReplicate = (item: ContentItem) => {
    // Store the content data in sessionStorage for VideoPage to pick up
    sessionStorage.setItem('replicate_content', JSON.stringify(item));
    navigate('/app/video?replicate=' + item.id);
  };

  const parseMeta = (metaStr: string) => {
    try { return JSON.parse(metaStr || '{}'); } catch { return {}; }
  };

  const getVideoPlayUrl = (url: string | null) => {
    if (!url) return '';
    if (url.startsWith('/') || url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) {
      return url;
    }
    return `/api/video/play?url=${encodeURIComponent(url)}`;
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'completed': case 'success':
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">成功</span>;
      case 'processing':
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20 animate-pulse">生成中</span>;
      case 'failed': case 'error':
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-500/10 text-red-400 border border-red-500/20">失败</span>;
      default:
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-zinc-500/10 text-zinc-400 border border-zinc-500/20">{status}</span>;
    }
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Film className="w-5 h-5 text-indigo-400" />
            内容管理
          </h1>
          <p className="text-xs text-zinc-500 mt-1">查看所有用户生成的内容，支持一键复刻</p>
        </div>
        <div className="text-xs text-zinc-500">共 {total} 条记录</div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-[320px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type="text"
            placeholder="搜索提示词..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="w-full pl-9 pr-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500/50"
          />
        </div>

        <select
          value={typeFilter}
          onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}
          className="px-3 py-2 bg-[#1a1a1a] border border-white/10 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500/50 appearance-none cursor-pointer"
          style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: '28px' }}
        >
          <option value="" className="bg-[#1a1a1a] text-white">全部类型</option>
          <option value="video" className="bg-[#1a1a1a] text-white">视频</option>
          <option value="image" className="bg-[#1a1a1a] text-white">图片</option>
          <option value="analysis" className="bg-[#1a1a1a] text-white">分析</option>
        </select>

        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          className="px-3 py-2 bg-[#1a1a1a] border border-white/10 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500/50 appearance-none cursor-pointer"
          style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: '28px' }}
        >
          <option value="" className="bg-[#1a1a1a] text-white">全部状态</option>
          <option value="completed" className="bg-[#1a1a1a] text-white">成功</option>
          <option value="processing" className="bg-[#1a1a1a] text-white">生成中</option>
          <option value="failed" className="bg-[#1a1a1a] text-white">失败</option>
        </select>
      </div>

      {/* Content Grid */}
      {loading ? (
        <div className="flex items-center justify-center h-64 text-zinc-500">
          <div className="animate-spin w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full" />
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-zinc-500">
          <Film className="w-10 h-10 mb-3 opacity-30" />
          <p className="text-sm">暂无内容</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {items.map(item => {
            const meta = parseMeta(item.metadata);
            const refImgs: string[] = meta.reference_images || [];
            const refVids: string[] = meta.reference_videos || [];
            const refAuds: string[] = meta.audio_urls || [];
            const hasVideo = item.resultUrl && item.resultUrl.trim() !== '';

            return (
              <div key={item.id} className="group bg-white/[0.03] border border-white/5 rounded-xl overflow-hidden hover:border-white/10 transition-all">
                {/* Video Preview / Thumbnail */}
                <div
                  className="relative aspect-video bg-black/50 cursor-pointer"
                  onClick={() => { setPreviewItem(item); setPreviewTab('video'); }}
                >
                  {hasVideo ? (
                    <video
                      src={getVideoPlayUrl(item.resultUrl)}
                      className="w-full h-full object-cover"
                      muted
                      preload="metadata"
                      onMouseEnter={(e) => (e.target as HTMLVideoElement).play().catch(() => {})}
                      onMouseLeave={(e) => { const v = e.target as HTMLVideoElement; v.pause(); v.currentTime = 0; }}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-zinc-600">
                      <Film className="w-8 h-8" />
                    </div>
                  )}
                  {hasVideo && (
                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/30">
                      <Play className="w-8 h-8 text-white/80" />
                    </div>
                  )}
                  {/* Status badge */}
                  <div className="absolute top-2 right-2">
                    {getStatusBadge(item.status)}
                  </div>
                  {/* Duration & resolution */}
                  {meta.seconds && (
                    <div className="absolute bottom-2 left-2 flex items-center gap-1.5">
                      <span className="px-1.5 py-0.5 rounded bg-black/60 text-[10px] text-white/80">{meta.seconds}秒</span>
                      {meta.resolution && <span className="px-1.5 py-0.5 rounded bg-black/60 text-[10px] text-white/80">{meta.resolution}</span>}
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="p-3 space-y-2">
                  {/* User & Model */}
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-indigo-400 truncate max-w-[120px]">{item.userName || item.userEmail || `用户#${item.userId}`}</span>
                    <span className="text-zinc-500 truncate max-w-[120px]">{item.modelId || '未知模型'}</span>
                  </div>

                  {/* Prompt */}
                  <p className="text-xs text-zinc-400 line-clamp-2 leading-relaxed" title={item.title || item.inputText || ''}>
                    {item.title || item.inputText || '(无提示词)'}
                  </p>

                  {/* Reference assets summary */}
                  <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                    {refImgs.length > 0 && (
                      <span className="flex items-center gap-0.5">
                        <Image className="w-3 h-3" />{refImgs.length}图
                      </span>
                    )}
                    {refVids.length > 0 && (
                      <span className="flex items-center gap-0.5">
                        <Video className="w-3 h-3" />{refVids.length}视频
                      </span>
                    )}
                    {refAuds.length > 0 && (
                      <span className="flex items-center gap-0.5">
                        <Music className="w-3 h-3" />{refAuds.length}音频
                      </span>
                    )}
                    <span className="ml-auto text-amber-400/80">¥{item.cost.toFixed(2)}</span>
                  </div>

                  {/* Reference image thumbnails */}
                  {refImgs.length > 0 && (
                    <div className="flex gap-1 overflow-x-auto pb-1">
                      {refImgs.slice(0, 5).map((img, i) => (
                        <img key={i} src={img} alt={`ref_${i}`} className="w-8 h-8 rounded object-cover shrink-0 border border-white/10" />
                      ))}
                      {refImgs.length > 5 && (
                        <div className="w-8 h-8 rounded bg-white/5 flex items-center justify-center text-[10px] text-zinc-500 shrink-0">
                          +{refImgs.length - 5}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={() => { setPreviewItem(item); setPreviewTab('video'); }}
                      className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-zinc-400 hover:text-white transition-colors"
                    >
                      <Eye className="w-3 h-3" /> 查看
                    </button>
                    <button
                      onClick={() => handleReplicate(item)}
                      className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-indigo-500/10 hover:bg-indigo-500/20 text-xs text-indigo-400 hover:text-indigo-300 transition-colors border border-indigo-500/20"
                    >
                      <Copy className="w-3 h-3" /> 复刻
                    </button>
                  </div>

                  {/* Time */}
                  <div className="text-[10px] text-zinc-600 text-right">
                    {new Date(item.createdAt).toLocaleString('zh-CN')}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-4">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="p-2 rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="w-4 h-4 text-zinc-400" />
          </button>
          <span className="text-sm text-zinc-400">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="p-2 rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight className="w-4 h-4 text-zinc-400" />
          </button>
        </div>
      )}

      {/* Preview Modal */}
      {previewItem && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6" onClick={() => setPreviewItem(null)}>
          <div className="bg-[#111] border border-white/10 rounded-2xl max-w-4xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            {/* Modal header */}
            <div className="flex items-center justify-between p-4 border-b border-white/5">
              <div className="flex items-center gap-3">
                <h3 className="text-sm font-medium text-white">内容详情 #{previewItem.id}</h3>
                {getStatusBadge(previewItem.status)}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleReplicate(previewItem)}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-500/10 hover:bg-indigo-500/20 text-xs text-indigo-400 border border-indigo-500/20 transition-colors"
                >
                  <Copy className="w-3 h-3" /> 一键复刻
                </button>
                <button onClick={() => setPreviewItem(null)} className="p-1.5 rounded-lg hover:bg-white/10 transition-colors">
                  <X className="w-4 h-4 text-zinc-400" />
                </button>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 p-2 border-b border-white/5">
              <button
                onClick={() => setPreviewTab('video')}
                className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${previewTab === 'video' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                视频 & 信息
              </button>
              <button
                onClick={() => setPreviewTab('refs')}
                className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${previewTab === 'refs' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                参考素材 ({(() => {
                  const m = parseMeta(previewItem.metadata);
                  return (m.reference_images?.length || 0) + (m.reference_videos?.length || 0) + (m.audio_urls?.length || 0);
                })()})
              </button>
            </div>

            {/* Content */}
            <div className="p-4 space-y-4">
              {previewTab === 'video' ? (
                <>
                  {/* Video */}
                  {previewItem.resultUrl && previewItem.resultUrl.trim() !== '' && (
                    <video src={getVideoPlayUrl(previewItem.resultUrl)} controls className="w-full rounded-xl bg-black" />
                  )}

                  {/* Info grid */}
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div className="bg-white/[0.03] rounded-lg p-3">
                      <div className="text-zinc-500 mb-1">用户</div>
                      <div className="text-white">{previewItem.userName || previewItem.userEmail || `#${previewItem.userId}`}</div>
                    </div>
                    <div className="bg-white/[0.03] rounded-lg p-3">
                      <div className="text-zinc-500 mb-1">模型</div>
                      <div className="text-white truncate">{previewItem.modelId || '未知'}</div>
                    </div>
                    <div className="bg-white/[0.03] rounded-lg p-3">
                      <div className="text-zinc-500 mb-1">费用</div>
                      <div className="text-amber-400">¥{previewItem.cost.toFixed(2)}</div>
                    </div>
                    <div className="bg-white/[0.03] rounded-lg p-3">
                      <div className="text-zinc-500 mb-1">时间</div>
                      <div className="text-white">{new Date(previewItem.createdAt).toLocaleString('zh-CN')}</div>
                    </div>
                    {(() => {
                      const m = parseMeta(previewItem.metadata);
                      return (
                        <>
                          {m.resolution && (
                            <div className="bg-white/[0.03] rounded-lg p-3">
                              <div className="text-zinc-500 mb-1">分辨率</div>
                              <div className="text-white">{m.resolution}</div>
                            </div>
                          )}
                          {m.seconds && (
                            <div className="bg-white/[0.03] rounded-lg p-3">
                              <div className="text-zinc-500 mb-1">时长</div>
                              <div className="text-white">{m.seconds}秒</div>
                            </div>
                          )}
                          {m.aspect_ratio && (
                            <div className="bg-white/[0.03] rounded-lg p-3">
                              <div className="text-zinc-500 mb-1">宽高比</div>
                              <div className="text-white">{m.aspect_ratio}</div>
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>

                  {/* Prompt */}
                  <div className="bg-white/[0.03] rounded-lg p-3">
                    <div className="text-zinc-500 text-xs mb-2">提示词</div>
                    <pre className="text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
                      {previewItem.inputText || previewItem.title || '(无)'}
                    </pre>
                  </div>
                </>
              ) : (
                /* Reference Assets Tab */
                (() => {
                  const m = parseMeta(previewItem.metadata);
                  const refImgs: string[] = m.reference_images || [];
                  const refVids: string[] = m.reference_videos || [];
                  const refAuds: string[] = m.audio_urls || [];
                  return (
                    <div className="space-y-4">
                      {/* Reference Images */}
                      {refImgs.length > 0 && (
                        <div>
                          <h4 className="text-xs text-zinc-400 mb-2 flex items-center gap-1">
                            <Image className="w-3.5 h-3.5" /> 参考图片 ({refImgs.length})
                          </h4>
                          <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2">
                            {refImgs.map((img, i) => (
                              <img key={i} src={img} alt={`ref_${i}`} className="w-full aspect-square rounded-lg object-cover border border-white/10 hover:border-indigo-500/50 transition-colors cursor-pointer" />
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Reference Videos */}
                      {refVids.length > 0 && (
                        <div>
                          <h4 className="text-xs text-zinc-400 mb-2 flex items-center gap-1">
                            <Video className="w-3.5 h-3.5" /> 参考视频 ({refVids.length})
                          </h4>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                            {refVids.map((vid, i) => (
                              <video key={i} src={vid} controls className="w-full rounded-lg border border-white/10" />
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Reference Audios */}
                      {refAuds.length > 0 && (
                        <div>
                          <h4 className="text-xs text-zinc-400 mb-2 flex items-center gap-1">
                            <Music className="w-3.5 h-3.5" /> 参考音频 ({refAuds.length})
                          </h4>
                          <div className="space-y-2">
                            {refAuds.map((aud, i) => (
                              <audio key={i} src={aud} controls className="w-full" />
                            ))}
                          </div>
                        </div>
                      )}

                      {refImgs.length === 0 && refVids.length === 0 && refAuds.length === 0 && (
                        <div className="text-center text-zinc-500 text-sm py-8">该任务没有参考素材</div>
                      )}
                    </div>
                  );
                })()
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
