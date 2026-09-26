import { useEffect, useRef, useState } from 'react';
import { Layers3, Plus, Trash2, Upload, Loader2, Download, RotateCcw } from 'lucide-react';
import { api } from '../../api/client';
import { fetchVideoModels, type VideoModel } from '../../api/video';
import { useAuthStore } from '../../stores/authStore';
import { useAuthGuard } from '../../hooks/useAuthGuard';
import { formatBeijingTime, parseUtcTimestamp } from '../../../../shared/time';
import type { VideoBatchInput, VideoBatchDetail, VideoBatchItem, BatchItemStatus } from '../../../../shared/videoBatch';
import './VideoBatchPage.css';

const emptyCreative = () => ({ prompt: '', count: 10, reference_images: [] as string[], reference_videos: [] as string[], audio_urls: [] as string[] });
const statusLabels: Record<BatchItemStatus, string> = { queued: '等待排队', dispatching: '提交中', running: '生成中', retry_wait: '等待重试', completed: '已完成', failed: '失败已退款', cancelled: '取消已退款', review: '结果待核实' };
const money = (value: number) => `¥${Number(value || 0).toFixed(2)}`;
function elapsed(item: VideoBatchItem) {
  const from = parseUtcTimestamp(item.started_at);
  const to = item.finished_at ? parseUtcTimestamp(item.finished_at) : Date.now();
  if (!Number.isFinite(from)) return '—';
  const seconds = Math.max(0, Math.floor((to - from) / 1000));
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}
type Quote = { unitCost: number; total: number; totalCost: number };
type Summary = Pick<VideoBatchDetail, 'id' | 'name' | 'model' | 'total' | 'created_at'>;

export default function VideoBatchPage() {
  const guard = useAuthGuard();
  const { isAuthenticated, fetchProfile } = useAuthStore();
  const [models, setModels] = useState<VideoModel[]>([]);
  const [input, setInput] = useState<VideoBatchInput>({ name: '', model: '', aspect_ratio: '9:16', video_length: 6, resolution: '720p', autoRetry: false, maxRetries: 2, creatives: [emptyCreative()] });
  const [quote, setQuote] = useState<Quote | null>(null);
  const [batches, setBatches] = useState<Summary[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<VideoBatchDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState('all');
  const [preview, setPreview] = useState<string | null>(null);
  const requestKey = useRef('');
  const actionKey = useRef<{ batchId: number; kind: string; key: string } | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const total = input.creatives.reduce((n, c) => n + c.count, 0);
  const model = models.find(m => m.id === input.model);

  useEffect(() => {
    fetchVideoModels().then(data => {
      setModels(data);
      setInput(previous => ({ ...previous, model: previous.model || data[0]?.id || '',
        resolution: Object.keys(data[0]?.rates || { '720p': 0 })[0],
        video_length: data[0]?.allowedSeconds?.[0] || 6 }));
    }).catch(e => setError(e.message));
  }, []);
  useEffect(() => {
    if (!isAuthenticated) { setBatches([]); setDetail(null); setSelected(null); setPreview(null); return; }
    let stopped = false;
    const refresh = async () => {
      try {
        const rows = await api.get<Summary[]>('/video-batches');
        if (!stopped) { setBatches(rows); setSelected(id => id || rows[0]?.id || null); }
      } catch (e: any) { if (!stopped) setError(e.message); }
    };
    void refresh();
    return () => { stopped = true; };
  }, [isAuthenticated]);
  useEffect(() => {
    if (!selected || !isAuthenticated) return;
    let stopped = false;
    const refresh = async () => {
      try {
        const result = await api.get<VideoBatchDetail>(`/video-batches/${selected}`);
        if (!stopped) setDetail(result);
      } catch (e: any) { if (!stopped) setError(e.message); }
    };
    setDetail(null);
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, [selected, isAuthenticated]);
  useEffect(() => {
    if (!preview) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setPreview(null); };
    document.addEventListener('keydown', close);
    return () => { document.body.style.overflow = previous; document.removeEventListener('keydown', close); };
  }, [preview]);

  function edit(patch: Partial<VideoBatchInput>) {
    setInput(old => ({ ...old, ...patch })); setQuote(null); requestKey.current = '';
  }
  function creativeEdit(index: number, patch: Partial<VideoBatchInput['creatives'][number]>) {
    edit({ creatives: input.creatives.map((c, i) => i === index ? { ...c, ...patch } : c) });
  }
  async function upload(index: number, files: File[]) {
    if (!files.length) return;
    if (files.some(f => !f.type.startsWith('image/') || f.size > 10 * 1024 * 1024)) { setError('请上传 10 MB 以内的图片'); return; }
    if (input.creatives[index].reference_images.length + files.length > 10) { setError('每组最多 10 张参考图，实际数量以模型限制为准'); return; }
    setBusy(true);
    try {
      const urls = await Promise.all(files.map(f => new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(f);
      })));
      creativeEdit(index, { reference_images: [...input.creatives[index].reference_images, ...urls] });
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  async function estimate() {
    if (!guard()) return;
    setBusy(true); setError(''); setNotice('');
    try { setQuote(await api.post<Quote>('/video-batches/quote', input)); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (!quote || !guard()) return;
    if (!window.confirm(`生成 ${quote.total} 条视频，将预扣 ${money(quote.totalCost)}。自动重试不重复扣费，最终失败退款。是否开始？`)) return;
    setBusy(true); setError('');
    if (!requestKey.current) requestKey.current = crypto.randomUUID();
    try {
      const result = await api.post<VideoBatchDetail>('/video-batches', { ...input, expectedUnitCost: quote.unitCost, requestKey: requestKey.current });
      setBatches(old => [result, ...old.filter(b => b.id !== result.id)]);
      setSelected(result.id); setDetail(result); setQuote(null);
      requestKey.current = '';
      setNotice(`批次 #${result.id} 已开始，关闭页面也会继续执行。`);
      void fetchProfile().catch(() => {});
    } catch (e: any) { setError(`${e.message}。若网络中断，请用相同设置再次提交，系统会防止重复扣费。`); }
    finally { setBusy(false); }
  }
  async function action(kind: string) {
    if (!detail) return;
    const batchId = detail.id;
    const failedCost = detail.items.filter(i => i.status === 'failed').reduce((n, i) => n + i.unit_cost, 0);
    const message = kind === 'retry-failed' ? `重新生成已确认失败的任务，需重新预扣 ${money(failedCost)}。确定继续？`
      : kind === 'cancel-pending' ? '取消所有尚未开始的任务并退款？正在生成的任务会继续，之后不再自动重试。'
        : '关闭这个批次的自动重试？已经进入重试等待的任务将退款。';
    if (!window.confirm(message)) return;
    setBusy(true); setError('');
    try {
      if (actionKey.current?.batchId !== batchId || actionKey.current.kind !== kind) actionKey.current = { batchId, kind, key: crypto.randomUUID() };
      const result = await api.post<VideoBatchDetail>(`/video-batches/${batchId}/${kind}`, { requestKey: actionKey.current.key });
      actionKey.current = null;
      if (selectedRef.current === batchId) setDetail(result);
      void fetchProfile().catch(() => {});
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  async function downloadAll() {
    if (!detail) return;
    setBusy(true); setError('');
    try {
      const result = await api.post<{ url: string }>(`/video-batches/${detail.id}/download`);
      const a = document.createElement('a'); a.href = result.url; a.download = `batch-${detail.id}.zip`; a.click();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  const completed = detail?.items.filter(i => i.status === 'completed').length || 0;
  const ended = detail?.items.filter(i => ['completed', 'failed', 'cancelled'].includes(i.status)).length || 0;
  return <main className="video-batch-page">
    <header className="vb-heading"><div><p className="vb-eyebrow">BATCH WORKSPACE</p><h1><Layers3 size={26} /> 批量视频</h1><p>一组提示词，多条成片。使用你的原始创意，不改写提示词。</p></div><span className="vb-pill">后台排队 · 按条预扣</span></header>
    {error && <div className="vb-alert" role="alert">{error}<button onClick={() => setError('')} aria-label="关闭提示">×</button></div>}
    {notice && <p className="vb-notice" role="status">{notice}</p>}
    <div className="vb-workspace">
      <section className="vb-panel">
        <h2>创建批次</h2>
        <fieldset disabled={busy} className="vb-form">
          <label>批次名称<input value={input.name} maxLength={80} placeholder="例如：秋季新品带货 · 第一批" onChange={e => edit({ name: e.target.value })} /></label>
          <label>视频模型<select value={input.model} onChange={e => {
            const m = models.find(v => v.id === e.target.value);
            edit({ model: e.target.value, resolution: Object.keys(m?.rates || { '720p': 0 })[0], video_length: m?.allowedSeconds?.[0] || Math.min(6, m?.maxSeconds || 6) });
          }}><option value="" disabled>请选择模型</option>{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
          {model && <p className="vb-help">{model.description}</p>}
          <div className="vb-three">
            <label>画面比例<select value={input.aspect_ratio} onChange={e => edit({ aspect_ratio: e.target.value })}>{['9:16', '16:9', '1:1', '4:3', '3:4', '21:9'].map(v => <option key={v}>{v}</option>)}</select></label>
            <label>时长（秒）{model?.allowedSeconds?.length ? <select value={input.video_length} onChange={e => edit({ video_length: Number(e.target.value) })}>{model.allowedSeconds.map(v => <option key={v}>{v}</option>)}</select> : <input type="number" min={1} max={model?.maxSeconds || 120} value={input.video_length} onChange={e => edit({ video_length: Number(e.target.value) })} />}</label>
            <label>分辨率<select value={input.resolution} onChange={e => edit({ resolution: e.target.value })}>{Object.keys(model?.rates || { '720p': 0 }).map(v => <option key={v}>{v}</option>)}</select></label>
          </div>
          {input.creatives.map((c, index) => <article className="vb-creative" key={index}>
            <div className="vb-row"><h3>创意 {String(index + 1).padStart(2, '0')}</h3><button className="vb-icon" aria-label={`删除创意 ${index + 1}`} disabled={input.creatives.length === 1} onClick={() => edit({ creatives: input.creatives.filter((_, i) => i !== index) })}><Trash2 size={16} /></button></div>
            <label>原始提示词<textarea rows={5} maxLength={5000} value={c.prompt} placeholder="粘贴你的完整提示词。该组每一条视频均使用此提示词与参考素材。" onChange={e => creativeEdit(index, { prompt: e.target.value })} /></label>
            <div className="vb-row"><span className="vb-help">{c.prompt.length} / 5000</span><label className="vb-count">生成 <input type="number" min={1} max={100} value={c.count} onChange={e => creativeEdit(index, { count: Number(e.target.value) })} /> 条</label></div>
            <div className="vb-images">{c.reference_images.map((src, i) => <div key={i}><img src={src} alt={`创意 ${index + 1} 参考图 ${i + 1}`} /><button aria-label={`移除参考图 ${i + 1}`} onClick={() => creativeEdit(index, { reference_images: c.reference_images.filter((_, j) => i !== j) })}>×</button></div>)}</div>
            <label className="vb-upload"><Upload size={16} /> 添加参考图片<input type="file" accept="image/*" multiple onChange={e => { void upload(index, Array.from(e.target.files || [])); e.target.value = ''; }} /></label>
            <details><summary>参考视频 / 音频链接（可选）</summary><label>参考视频链接，每行一个<textarea rows={2} value={(c.reference_videos || []).join('\n')} onChange={e => creativeEdit(index, { reference_videos: e.target.value.split('\n') })} /></label><label>参考音频链接，每行一个<textarea rows={2} value={(c.audio_urls || []).join('\n')} onChange={e => creativeEdit(index, { audio_urls: e.target.value.split('\n') })} /></label><p className="vb-help">仅支持模型允许的素材类型；提交前会校验。</p></details>
          </article>)}
          <button className="vb-secondary" disabled={input.creatives.length >= 20} onClick={() => edit({ creatives: [...input.creatives, emptyCreative()] })}><Plus size={16} /> 添加一组创意</button>
          <div className="vb-retry"><label className="vb-check"><input type="checkbox" checked={input.autoRetry} onChange={e => edit({ autoRetry: e.target.checked })} /> 确认失败后自动重新生成</label><p className="vb-help">同提示词、同素材、同参数，不重复扣费。审核或参数错误不重试；查询异常只查原任务。</p>{input.autoRetry && <label>每条最多重试<select value={input.maxRetries} onChange={e => edit({ maxRetries: Number(e.target.value) })}>{[1, 2, 3].map(n => <option value={n} key={n}>{n} 次</option>)}</select></label>}</div>
          <div className="vb-checkout"><div className="vb-row"><span>{input.creatives.length} 组创意 · 共 {total} 条</span><strong>{quote ? money(quote.totalCost) : '待预估'}</strong></div><p className="vb-help">单批最多 100 条。整批预扣，最终失败或取消未开始任务时原路退款。预扣尚未结算的任务会单独列出。</p>
            {quote ? <button className="vb-primary" onClick={submit}>确认预扣 {money(quote.totalCost)} 并开始</button> : <button className="vb-primary" disabled={!input.model || total < 1 || total > 100} onClick={estimate}>{busy ? <Loader2 size={17} className="animate-spin" /> : null} 校验并预估费用</button>}
          </div>
        </fieldset>
      </section>
      <section className="vb-panel vb-results">
        <div className="vb-row"><h2>批次进度</h2><span className="vb-help">每 5 秒更新</span></div>
        <label>历史批次<select value={selected || ''} onChange={e => setSelected(Number(e.target.value))}><option value="" disabled>选择批次</option>{batches.map(b => <option key={b.id} value={b.id}>#{b.id} {b.name} · {b.total}条 · {formatBeijingTime(b.created_at)}</option>)}</select></label>
        {!detail ? <div className="vb-empty"><Layers3 size={40} /><h3>{selected ? '正在读取批次…' : '让重复操作交给队列'}</h3><p>添加提示词与素材，为每组设置生成数量。批次创建后，关闭页面也会继续运行。</p></div> : <>
          <div className="vb-progress"><div className="vb-row"><strong>成功 {completed} / {detail.total} 条</strong><span>已结束 {ended} 条</span></div><progress max={detail.total} value={ended} /><p className="vb-help">{detail.auto_retry ? `自动重试已开启 · 每条最多 ${detail.max_retries} 次` : '自动重试已关闭'} · 时间均为北京时间</p></div>
          <div className="vb-summary"><div><span>预扣待结算</span><strong>{money(detail.reserved)}</strong></div><div><span>成功实扣</span><strong>{money(detail.spent)}</strong></div><div><span>已退回</span><strong>{money(detail.refunded)}</strong></div></div>
          {detail.items.some(i => i.status === 'review') && <p className="vb-alert">部分任务结果待核实，预扣仍保留且不会自动补发。请联系管理员核对原上游任务，避免重复生成。</p>}
          <div className="vb-actions"><button disabled={busy || !completed} onClick={downloadAll}><Download size={15} /> 打包下载成功视频</button><button disabled={busy || !detail.items.some(i => i.status === 'failed')} onClick={() => action('retry-failed')}><RotateCcw size={15} /> 重试失败项（重新预扣）</button><button disabled={busy || !detail.auto_retry} onClick={() => action('stop-retries')}>关闭自动重试</button><button disabled={busy || !detail.items.some(i => ['queued', 'retry_wait'].includes(i.status))} onClick={() => action('cancel-pending')}>取消未开始任务</button></div>
          <div className="vb-row"><span className="vb-help">生成用时包含重试等待，不代表视频时长</span><select aria-label="筛选任务状态" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">所有状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          <div className="vb-table-wrap"><table><thead><tr><th>任务</th><th>状态 / 次数</th><th>用时</th><th>费用</th><th>结果</th></tr></thead><tbody>{detail.items.filter(i => filter === 'all' || filter === i.status).map(i => <tr key={i.id}>
            <td><strong>创意 {i.creative_index + 1} · #{i.ordinal}</strong><small>记录 {i.content_id ? `#${i.content_id}` : '未提交'}</small></td>
            <td><span className={`vb-status vb-status-${i.status}`}>{statusLabels[i.status]}</span><small>已尝试 {i.attempts} 次</small>{i.error && <details className="vb-error-detail"><summary>查看原因</summary><p>{i.error}</p></details>}</td>
            <td>{elapsed(i)}</td><td>{money(i.unit_cost)}<small>{i.billing_state === 'reserved' ? '预扣保留' : i.billing_state === 'refunded' ? '已退款' : '已结算'}</small></td>
            <td>{i.result_url ? <button onClick={() => setPreview(i.result_url)}>预览</button> : '—'}</td>
          </tr>)}</tbody></table></div>
        </>}
      </section>
    </div>
    {preview && <div className="vb-modal" role="dialog" aria-modal="true" aria-label="视频预览" onClick={() => setPreview(null)}><div onClick={e => e.stopPropagation()}><button autoFocus onClick={() => setPreview(null)}>关闭预览</button><video src={preview} controls autoPlay /><a href={`/api/video/download?url=${encodeURIComponent(preview)}`} download>下载这条视频</a></div></div>}
  </main>;
}
