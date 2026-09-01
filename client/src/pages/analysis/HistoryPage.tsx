import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Film,
  History,
  Image as ImageIcon,
  Loader2,
  Music2,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { contentApi } from '../../api/content';
import { downloadGeneratedImage } from '../../api/imageGen';
import { getContentFailureInfo } from '../../utils/contentFailure';

interface ContentItem {
  id: number;
  type: string;
  title: string;
  inputText: string | null;
  resultUrl: string | null;
  resultText: string | null;
  modelId: string | null;
  cost: number;
  metadata: string;
  status: string;
  createdAt: string;
}

const DEFAULT_PAGE_SIZE = 15;
const VIDEO_PAGE_SIZE = 6;

const typeOptions = [
  { value: '', label: '全部记录' },
  { value: 'video', label: '视频' },
  { value: 'image', label: '图片' },
  { value: 'analysis', label: '分析' },
  { value: 'copywriting', label: '文案' },
  { value: 'audio', label: '语音' },
];

const statusOptions = [
  { value: '', label: '全部状态' },
  { value: 'processing', label: '生成中' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '失败' },
];

function parseMetadata(value: string | null | undefined): Record<string, any> {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function getTypeConfig(type: string) {
  switch (type) {
    case 'video': return { label: '视频', icon: Film, tone: 'is-video' };
    case 'image': return { label: '图片', icon: ImageIcon, tone: 'is-image' };
    case 'copywriting': return { label: '文案', icon: FileText, tone: 'is-copy' };
    case 'audio': case 'tts': return { label: '语音', icon: Music2, tone: 'is-audio' };
    default: return { label: '分析', icon: Sparkles, tone: 'is-analysis' };
  }
}

function normalizeStatus(status: string) {
  if (status === 'completed' || status === 'success') return 'completed';
  if (status === 'processing' || status === 'queued') return 'processing';
  if (status === 'failed' || status === 'error') return 'failed';
  return status;
}

function StatusBadge({ status }: { status: string }) {
  const normalized = normalizeStatus(status);
  if (normalized === 'completed') return <span className="history-status is-completed"><CheckCircle2 />已完成</span>;
  if (normalized === 'processing') return <span className="history-status is-processing"><Loader2 className="animate-spin" />生成中</span>;
  if (normalized === 'failed') return <span className="history-status is-failed"><AlertCircle />失败</span>;
  return <span className="history-status">{status}</span>;
}

function formatDate(value: string) {
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function getMediaUrls(item: ContentItem): string[] {
  const metadata = parseMetadata(item.metadata);
  const urls = [item.resultUrl, ...(Array.isArray(metadata.imageUrls) ? metadata.imageUrls : [])]
    .filter((url): url is string => typeof url === 'string' && Boolean(url.trim()));
  return Array.from(new Set(urls));
}

function getVideoPlayUrl(url: string) {
  if (url.startsWith('/') || url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) return url;
  return `/api/video/play?url=${encodeURIComponent(url)}`;
}

export default function HistoryPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialType = searchParams.get('type') || '';
  const [items, setItems] = useState<ContentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [type, setType] = useState(initialType);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<ContentItem | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const pageSize = type === 'video' ? VIDEO_PAGE_SIZE : DEFAULT_PAGE_SIZE;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (type) next.set('type', type);
    setSearchParams(next, { replace: true });
  }, [type, setSearchParams]);

  const loadContents = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError('');
    try {
      const data = await contentApi.getMyApiHistory({
        page,
        pageSize,
        type: type || undefined,
        status: status || undefined,
        search: debouncedSearch || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      });
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch (err: any) {
      setError(err.message || '生成记录加载失败，请稍后重试');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [page, pageSize, type, status, debouncedSearch, dateFrom, dateTo]);

  useEffect(() => { loadContents(); }, [loadContents]);

  const hasPending = items.some(item => normalizeStatus(item.status) === 'processing');
  useEffect(() => {
    if (!hasPending) return;
    const timer = window.setInterval(() => loadContents(true), 6000);
    return () => window.clearInterval(timer);
  }, [hasPending, loadContents]);

  useEffect(() => {
    if (!selected) return;
    const handleEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelected(null); };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [selected]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pendingCount = useMemo(() => items.filter(item => normalizeStatus(item.status) === 'processing').length, [items]);

  const openDetail = async (item: ContentItem) => {
    setSelected(item);
    setCopied(false);
    setDetailLoading(true);
    try {
      const detail = await contentApi.getMyApiHistoryById(item.id);
      setSelected(detail);
      if (normalizeStatus(detail.status) !== normalizeStatus(item.status)) loadContents(true);
    } catch {
      // The list snapshot is still useful if refreshing the detail fails.
    } finally {
      setDetailLoading(false);
    }
  };

  const handleDelete = async (item: ContentItem) => {
    if (!window.confirm(`确定删除“${item.title || `记录 #${item.id}`}”吗？删除后无法恢复。`)) return;
    setDeletingId(item.id);
    try {
      await contentApi.deleteMyApiHistory(item.id);
      if (selected?.id === item.id) setSelected(null);
      if (items.length === 1 && page > 1) setPage(current => current - 1);
      else await loadContents(true);
    } catch (err: any) {
      setError(err.message || '删除失败，请稍后重试');
    } finally {
      setDeletingId(null);
    }
  };

  const handleCopy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const handleDownload = async (item: ContentItem, url: string, index = 0) => {
    if (item.type === 'image') {
      await downloadGeneratedImage(url, `generated-image-${item.id}-${index + 1}.png`);
      return;
    }
    if (item.type === 'video') {
      const anchor = document.createElement('a');
      anchor.href = `/api/video/download?url=${encodeURIComponent(url)}&filename=generated-video-${item.id}.mp4`;
      anchor.download = '';
      anchor.click();
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const resetFilters = () => {
    setType(''); setStatus(''); setSearch(''); setDateFrom(''); setDateTo(''); setPage(1);
  };

  return (
    <div className="history-page">
      <header className="history-header">
        <div>
          <div className="history-eyebrow"><History /> CREATION ARCHIVE</div>
          <h1>生成记录</h1>
          <p>集中查看每一次创作结果、参数、状态与费用。</p>
        </div>
        <div className="history-summary" aria-label="记录概览">
          <div><strong>{total}</strong><span>条记录</span></div>
          {pendingCount > 0 && <div className="is-pending"><strong>{pendingCount}</strong><span>正在生成</span></div>}
          <button onClick={() => loadContents()} disabled={loading} aria-label="刷新生成记录">
            <RefreshCw className={loading ? 'animate-spin' : ''} />刷新
          </button>
        </div>
      </header>

      <section className="history-filter-panel" aria-label="筛选生成记录">
        <div className="history-search">
          <label htmlFor="history-search">搜索记录</label>
          <div><Search /><input id="history-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索标题、提示词或模型" /></div>
        </div>
        <div className="history-filter-field">
          <label htmlFor="history-status">状态</label>
          <select id="history-status" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}>
            {statusOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        <div className="history-filter-field history-date-field">
          <label htmlFor="history-from">开始日期</label>
          <input id="history-from" type="date" value={dateFrom} max={dateTo || undefined} onChange={event => { setDateFrom(event.target.value); setPage(1); }} />
        </div>
        <div className="history-filter-field history-date-field">
          <label htmlFor="history-to">结束日期</label>
          <input id="history-to" type="date" value={dateTo} min={dateFrom || undefined} onChange={event => { setDateTo(event.target.value); setPage(1); }} />
        </div>
      </section>

      <div className="history-type-tabs" role="tablist" aria-label="记录类型">
        {typeOptions.map(option => (
          <button key={option.value} role="tab" aria-selected={type === option.value} className={type === option.value ? 'is-active' : ''} onClick={() => { setType(option.value); setPage(1); }}>
            {option.label}
          </button>
        ))}
      </div>

      {error && <div className="history-error" role="alert"><AlertCircle /> <span>{error}</span><button onClick={() => loadContents()}>重试</button></div>}

      <section className="history-list" aria-live="polite" aria-busy={loading}>
        {loading ? (
          Array.from({ length: 6 }).map((_, index) => <div key={index} className="history-skeleton"><span /><div><i /><i /><i /></div></div>)
        ) : items.length === 0 ? (
          <div className="history-empty">
            <div><History /></div>
            <h2>{type || status || debouncedSearch || dateFrom || dateTo ? '没有匹配的生成记录' : '还没有生成记录'}</h2>
            <p>{type || status || debouncedSearch || dateFrom || dateTo ? '换一组筛选条件试试，或者清除筛选查看全部记录。' : '完成一次图片或视频生成后，结果会自动保存在这里。'}</p>
            {type || status || debouncedSearch || dateFrom || dateTo
              ? <button onClick={resetFilters}>清除筛选</button>
              : <button onClick={() => navigate('/app/image-gen')}>开始生成图片</button>}
          </div>
        ) : items.map(item => {
          const config = getTypeConfig(item.type);
          const TypeIcon = config.icon;
          const mediaUrls = getMediaUrls(item);
          const firstUrl = mediaUrls[0];
          const isCompleted = normalizeStatus(item.status) === 'completed';
          return (
            <article key={item.id} className="history-item">
              <button className={`history-thumbnail ${config.tone}`} onClick={() => openDetail(item)} aria-label={`查看${item.title || `记录 ${item.id}`}详情`}>
                {item.type === 'image' && firstUrl ? <img src={firstUrl} alt={item.title || '生成图片'} loading="lazy" decoding="async" /> : <TypeIcon />}
                {mediaUrls.length > 1 && <span>+{mediaUrls.length - 1}</span>}
              </button>
              <button className="history-item-main" onClick={() => openDetail(item)}>
                <span className="history-item-heading">
                  <strong>{item.title || item.inputText || `未命名记录 #${item.id}`}</strong>
                  <StatusBadge status={item.status} />
                </span>
                <span className="history-item-meta">
                  <em className={config.tone}><TypeIcon />{config.label}</em>
                  <span><Clock3 />{formatDate(item.createdAt)}</span>
                  <span>{item.modelId || '未记录模型'}</span>
                  {item.cost > 0 && <span className="history-cost">¥{Number(item.cost).toFixed(3)}</span>}
                </span>
                {item.inputText && item.inputText !== item.title && <span className="history-prompt">{item.inputText}</span>}
              </button>
              <div className="history-actions">
                {isCompleted && firstUrl && <button onClick={() => handleDownload(item, firstUrl)}><Download />下载</button>}
                <button onClick={() => openDetail(item)}><ExternalLink />详情</button>
                <button className="is-danger" disabled={deletingId === item.id} onClick={() => handleDelete(item)}>
                  {deletingId === item.id ? <Loader2 className="animate-spin" /> : <Trash2 />}删除
                </button>
              </div>
            </article>
          );
        })}
      </section>

      {!loading && totalPages > 1 && (
        <nav className="history-pagination" aria-label="生成记录分页">
          <button onClick={() => setPage(current => Math.max(1, current - 1))} disabled={page === 1} aria-label="上一页"><ChevronLeft /></button>
          <span>第 <strong>{page}</strong> / {totalPages} 页</span>
          <button onClick={() => setPage(current => Math.min(totalPages, current + 1))} disabled={page === totalPages} aria-label="下一页"><ChevronRight /></button>
        </nav>
      )}

      {selected && (() => {
        const config = getTypeConfig(selected.type);
        const TypeIcon = config.icon;
        const mediaUrls = getMediaUrls(selected);
        const metadata = parseMetadata(selected.metadata);
        const failure = normalizeStatus(selected.status) === 'failed' ? getContentFailureInfo(selected.metadata, selected.resultText) : null;
        return (
          <div className="history-drawer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSelected(null); }}>
            <aside className="history-drawer" role="dialog" aria-modal="true" aria-labelledby="history-detail-title">
              <header>
                <div className={`history-detail-icon ${config.tone}`}><TypeIcon /></div>
                <div><span>记录 #{selected.id}</span><h2 id="history-detail-title">{selected.title || '未命名记录'}</h2></div>
                <button className="history-drawer-close" onClick={() => setSelected(null)} aria-label="关闭详情"><X /></button>
              </header>
              {detailLoading && <div className="history-detail-loading"><Loader2 className="animate-spin" />正在刷新任务状态</div>}
              <div className="history-drawer-body">
                <div className="history-detail-status"><StatusBadge status={selected.status} /><span><CalendarDays />{formatDate(selected.createdAt)}</span></div>

                {mediaUrls.length > 0 && (
                  <section className="history-detail-media">
                    {mediaUrls.map((url, index) => (
                      <div key={url}>
                        {selected.type === 'image'
                          ? <img src={url} alt={`${selected.title || '生成图片'} ${index + 1}`} />
                          : selected.type === 'video'
                            ? <video src={getVideoPlayUrl(url)} controls preload="metadata" />
                            : <audio src={url} controls />}
                        <button onClick={() => handleDownload(selected, url, index)}><Download />下载{mediaUrls.length > 1 ? ` ${index + 1}` : ''}</button>
                      </div>
                    ))}
                  </section>
                )}

                {failure && <section className="history-failure"><h3><AlertCircle />失败原因</h3><p>{failure.message}</p></section>}

                <section className="history-detail-section">
                  <div className="history-detail-section-title"><h3>输入内容</h3>{selected.inputText && <button onClick={() => handleCopy(selected.inputText!)}><Copy />{copied ? '已复制' : '复制'}</button>}</div>
                  <p className="history-detail-copy">{selected.inputText || '未记录输入内容'}</p>
                </section>

                {selected.resultText && normalizeStatus(selected.status) !== 'failed' && (
                  <section className="history-detail-section"><h3>生成结果</h3><pre>{selected.resultText}</pre></section>
                )}

                <section className="history-detail-section">
                  <h3>任务信息</h3>
                  <dl>
                    <div><dt>内容类型</dt><dd>{config.label}</dd></div>
                    <div><dt>使用模型</dt><dd>{selected.modelId || '未记录'}</dd></div>
                    <div><dt>费用</dt><dd>¥{Number(selected.cost || 0).toFixed(3)}</dd></div>
                    <div><dt>调用来源</dt><dd>{metadata.source === 'api' ? 'API' : '网页工作台'}</dd></div>
                    {metadata.seconds && <div><dt>时长</dt><dd>{metadata.seconds} 秒</dd></div>}
                    {metadata.resolution && <div><dt>分辨率</dt><dd>{metadata.resolution}</dd></div>}
                  </dl>
                </section>
              </div>
              <footer>
                {selected.type === 'video' && <button className="history-secondary-action" onClick={() => { sessionStorage.setItem('replicate_content', JSON.stringify(selected)); navigate(`/app/video?replicate=${selected.id}`); }}><Copy />再次创作</button>}
                <button className="history-delete-action" disabled={deletingId === selected.id} onClick={() => handleDelete(selected)}><Trash2 />删除记录</button>
              </footer>
            </aside>
          </div>
        );
      })()}
    </div>
  );
}
