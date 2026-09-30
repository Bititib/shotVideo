import { connectionError } from './videoInputs';
import { useEffect, useState } from 'react';
import { contentApi } from '../api/content';
import { useAuthStore } from '../stores/authStore';
import { useAuthGuard } from '../hooks/useAuthGuard';
import { newNode, safeMedia, type CanvasNode } from './model';

export default function AssetBrowser({ onClose, onAdd, acceptKind, referenceTarget, actionLabel, embedded }: { embedded?: boolean; acceptKind?: CanvasNode['kind']; referenceTarget?: CanvasNode; actionLabel?: string; onClose: () => void; onAdd: (nodes: CanvasNode[]) => void }) {
  const user = useAuthStore(s => s.user), guard = useAuthGuard();
  const [search, setSearch] = useState(''), [type, setType] = useState(acceptKind || 'image'), [page, setPage] = useState(1);
  const [items, setItems] = useState<any[]>([]), [total, setTotal] = useState(0), [error, setError] = useState(''), [loading, setLoading] = useState(false), [retry, setRetry] = useState(0);
  useEffect(() => {
    setItems([]); setError(''); setLoading(Boolean(user));
    if (!user) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true); setError('');
      contentApi.getMyContents({ page, pageSize: 18, type, search }, controller.signal).then(data => {
        if (!controller.signal.aborted) { setItems(data.items || []); setTotal(data.total || 0); }
      }).catch(error => { if (!controller.signal.aborted) setError(error.message || '加载失败'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [user?.id, page, type, search, retry]);
  const assets = (item: any): CanvasNode[] => {
    let meta: any = {}; try { meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata || {}; } catch { /* malformed legacy metadata */ }
    if (type === 'audio' && !item.resultUrl) { try { const result=JSON.parse(item.resultText || '{}'); if(result.audioBase64 && result.mimeType) item={...item,resultUrl:`data:${result.mimeType};base64,${result.audioBase64}`}; } catch {} }
    const urls = [...new Set([item.resultUrl, ...(Array.isArray(meta.imageUrls) ? meta.imageUrls : [])].filter(safeMedia))] as string[];
    return urls.map((src, index) => ({ ...newNode(type === 'video' ? 'video' : type === 'audio' ? 'audio' : 'image', { x: 0, y: 0 }), src, title: `${item.title || item.modelId || '历史作品'}${urls.length > 1 ? ` ${index + 1}` : ''}`.slice(0, 120), text: item.inputText || '', model: item.modelId, origin: { projectId: 'history', nodeId: String(item.id), title: '生成历史' } }));
  };
  return <section className="studio-asset-browser" role={embedded ? undefined : "dialog"} aria-modal={embedded ? undefined : true} aria-label="我的生成资产">{!embedded && <header><div><h2>我的生成资产</h2><p>把过去的作品继续接入当前创作</p></div><button onClick={onClose} aria-label="关闭生成资产">✕</button></header>}
    {!user ? <button className="studio-primary-action" onClick={() => guard()}>登录查看生成资产</button> : <><div className="studio-asset-filters"><input aria-label="搜索生成资产" placeholder="搜索提示词、作品名称" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} /><select aria-label="生成资产类型" disabled={Boolean(acceptKind)} value={type} onChange={e => { setType(e.target.value); setPage(1); setItems([]); }}><option value="image">图片</option><option value="video">视频</option><option value="audio">音频</option></select></div>
      {loading && <p role="status">正在读取作品…</p>}{error && <p role="alert">{error} <button onClick={() => setRetry(n => n + 1)}>重试</button></p>}
      <div className="studio-asset-grid">{!loading && items.map(item => { const nodes = assets(item).filter(n=>!referenceTarget || !connectionError(n,referenceTarget)); return <article key={item.id}>{nodes[0]?.kind === 'image' ? <img src={nodes[0].src} alt={item.title || '历史图片'} loading="lazy"/> : <div className="studio-asset-placeholder">{type === 'video' ? '▶ 视频' : '暂无结果'}</div>}<strong>{item.title || item.modelId}</strong><small>{({ completed: '已完成', processing: '生成中', queued: '排队中', failed: '未完成' } as Record<string, string>)[item.status] || '待核实'} · {nodes.length} 个结果</small><button disabled={!nodes.length} onClick={() => onAdd(nodes)}>{actionLabel || '加入画布'}</button></article>; })}</div>
      {!loading && !error && !items.length && <p>还没有符合条件的作品。生成完成后会出现在这里。</p>}
      <footer><button disabled={page === 1 || loading} onClick={() => setPage(p => p - 1)}>上一页</button><span>{page} / {Math.max(1, Math.ceil(total / 18))}</span><button disabled={page * 18 >= total || loading} onClick={() => setPage(p => p + 1)}>下一页</button></footer></>}
  </section>;
}
