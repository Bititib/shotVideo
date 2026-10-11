import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Save, Radio, Play, RefreshCw, ArrowLeft, ArrowUpRight, ChevronDown, ChevronRight, Search, Image, Video, Layers3, CheckCircle2, AlertCircle, SlidersHorizontal, Copy, Check } from 'lucide-react';
import { adminApi } from '../../api/admin';
import { defaultRoutingLimits, imageSpecificationId, canShareImageAliases, type ModelInputLimits, type ModelSpecification, type ModelRoute } from '../../../../shared/modelRouting';
import './ModelRoutingPage.css';
const inputClass = 'routing-input', buttonClass = 'routing-button';
const tokens = (value: string) => value.split(/[,，\s]+/).filter(Boolean);
type EditorTab = 'routes' | 'settings' | 'simulation';
const tabs: {
    id: EditorTab;
    label: string;
    icon: typeof Radio;
}[] = [{ id: 'routes', label: '关联线路', icon: Radio }, { id: 'settings', label: '规格设置', icon: SlidersHorizontal }, { id: 'simulation', label: '模拟选路', icon: Play }];
const snapshot = (s: ModelSpecification, name: string) => JSON.stringify({ modelId: s.modelId, imageFamily: s.imageFamily, kind: s.kind, enabled: s.enabled, aliases: s.aliases, limits: s.limits, routes: s.routes, displayName: name });
const money = (cost: number | null | undefined) => cost == null ? '成本未填写' : '¥' + cost.toLocaleString('zh-CN', { maximumFractionDigits: 6 });
const costUnit = (unit: string, kind?: string) => unit === 'unknown' ? '单位待确认' : unit === 'per_second' ? '/ 秒' : unit === 'per_image' || kind === 'image' ? '/ 张' : '/ 条';
const saleSummary = (price: any, kind: string, resolutions: string[]) => !price?.configured ? '用户售价未配置' : resolutions.map(r => r + ' ¥' + Number(price.resolutionPrices?.[r] ?? price.rate).toLocaleString('zh-CN', { maximumFractionDigits: 6 }) + costUnit(price.billingType, kind)).join(' · ');
const durationLabel = (l: ModelInputLimits) => l.duration.mode === 'options' ? l.duration.values.join(' / ') + ' 秒' : l.duration.min === l.duration.max ? l.duration.min + ' 秒' : l.duration.min + '–' + l.duration.max + ' 秒';
function LimitsEditor({ value, onChange, kind, singleResolution = false, resolutionLocked = false }: {
    key?: string;
    singleResolution?: boolean;
    resolutionLocked?: boolean;
    value: ModelInputLimits;
    onChange: (v: ModelInputLimits) => void;
    kind: 'image' | 'video';
}) {
    const set = (key: keyof ModelInputLimits, next: any) => onChange({ ...value, [key]: next });
    return <fieldset className="routing-limits-grid"><legend>{kind === 'image' ? '参考图与输出限制' : '输入能力与数量限制'}</legend>
 {([['minImages', '最少图片'], ['maxImages', '最多图片'], ...(kind === 'video' ? [['maxVideos', '最多视频'], ['maxAudios', '最多音频']] : [['maxOutputs', '最多输出图片']])] as const).map(([key, label]) => <label key={key}>{label}<input className={inputClass} type="number" min={key === 'maxOutputs' ? 1 : 0} max={key === 'maxOutputs' ? 4 : 100} value={value[key]} onChange={e => set(key as keyof ModelInputLimits, Number(e.target.value))}/></label>)}
 {singleResolution ? <label>输出分辨率（此入口固定）<select className={inputClass} disabled={resolutionLocked} value={value.resolutions[0] || '1K'} onChange={e => set('resolutions', [e.target.value])}>{[...new Set(['1K', '2K', '4K', ...value.resolutions])].map(r => <option key={r}>{r}</option>)}</select></label> : <label>分辨率（逗号分隔）<input className={inputClass} defaultValue={value.resolutions.join(',')} onBlur={e => set('resolutions', tokens(e.target.value))} placeholder="720p,1080p"/></label>}
 <label>比例（逗号分隔）<input className={inputClass} defaultValue={value.ratios.join(',')} onBlur={e => set('ratios', tokens(e.target.value))} placeholder="16:9,9:16,1:1"/></label><label>质量档位（留空不限）<input className={inputClass} defaultValue={value.qualities.join(',')} onBlur={e => set('qualities', tokens(e.target.value))} placeholder="low,medium,high"/></label>
 {kind === 'video' && <><label>时长类型<select className={inputClass} value={value.duration.mode} onChange={e => set('duration', { ...value.duration, mode: e.target.value })}><option value="range">范围任选</option><option value="fixed">固定时长</option><option value="options">指定档位</option></select></label>
 {value.duration.mode === 'options' ? <label>秒数档位<input className={inputClass} defaultValue={value.duration.values.join(',')} onBlur={e => set('duration', { ...value.duration, values: tokens(e.target.value).map(Number) })} placeholder="5,10,15,30"/></label> : <><label>{value.duration.mode === 'fixed' ? '固定秒数' : '最短秒数'}<input className={inputClass} type="number" min="1" value={value.duration.min} onChange={e => set('duration', { ...value.duration, min: Number(e.target.value), ...(value.duration.mode === 'fixed' ? { max: Number(e.target.value) } : {}) })}/></label>{value.duration.mode === 'range' && <><label>最长秒数<input className={inputClass} type="number" min="1" value={value.duration.max} onChange={e => set('duration', { ...value.duration, max: Number(e.target.value) })}/></label><label>秒数步长<input className={inputClass} type="number" min="0.1" step="0.1" value={value.duration.step} onChange={e => set('duration', { ...value.duration, step: Number(e.target.value) })}/></label></>}</>}
 <div className="routing-checkbox-group"><label><input type="checkbox" checked={value.firstFrame} onChange={e => set('firstFrame', e.target.checked)}/> 独立首帧</label><label><input type="checkbox" checked={value.lastFrame} onChange={e => set('lastFrame', e.target.checked)}/> 独立尾帧</label></div></>}
 </fieldset>;
}
export default function ModelRoutingPage() {
    const [prices, setPrices] = useState<any[]>([]);
    const [specs, setSpecs] = useState<any[]>([]), [models, setModels] = useState<any[]>([]), [channels, setChannels] = useState<any[]>([]), [suggestions, setSuggestions] = useState<any[]>([]);
    const [edit, setEdit] = useState<ModelSpecification | null>(null), [displayName, setDisplayName] = useState(''), [baseline, setBaseline] = useState('');
    const [tab, setTab] = useState<EditorTab>('routes'), [expandedRoute, setExpandedRoute] = useState<string | null>(null), [exitWarning, setExitWarning] = useState(false), [copied, setCopied] = useState(false);
    const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
    const [simulation, setSimulation] = useState({ images: 0, videos: 0, audios: 0, seconds: 15, resolution: '720p', ratio: '16:9', n: 1, firstFrame: false, lastFrame: false, quality: '' });
    const [result, setResult] = useState<any>(null), [filter, setFilter] = useState('all'), [search, setSearch] = useState(''), [kindFilter, setKindFilter] = useState('all'), [statusFilter, setStatusFilter] = useState('all');
    const resultRef = useRef<HTMLDivElement>(null);
    const topRef = useRef<HTMLDivElement>(null), dirty = Boolean(edit && snapshot(edit, displayName) !== baseline), saved = edit ? specs.find(s => s.modelId === edit.modelId) : undefined;
    const load = async () => { try {
        const [a, b, c, d, e] = await Promise.all([adminApi.getModelSpecifications(), adminApi.getModels(), adminApi.getChannels(), adminApi.getModelSpecificationSuggestions(), adminApi.getPricing({ scope: 'models' })]);
        setSpecs(a);
        setModels(b);
        setChannels(c);
        setSuggestions(d);
        setPrices(e);
        setError('');
        return a;
    }
    catch (e: any) {
        setError(e.message);
        return null;
    }
    finally {
        setLoading(false);
    } };
    useEffect(() => { void load(); }, []);
    useEffect(() => { if (!dirty)
        return; const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent); }, [dirty]);
    const simulationLimits = saved?.limits || edit?.limits;
    useEffect(() => {
        if (!simulationLimits) return;
        setSimulation(current => ({ ...current,
            resolution: simulationLimits.resolutions.includes(current.resolution) ? current.resolution : simulationLimits.resolutions[0],
            ratio: simulationLimits.ratios.includes(current.ratio) ? current.ratio : simulationLimits.ratios[0],
        }));
    }, [simulationLimits?.resolutions, simulationLimits?.ratios]);
    useEffect(() => {
        if (result) resultRef.current?.scrollIntoView?.({ block: 'nearest', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth' });
    }, [result]);
    const mediaModels = models.filter(m => m.capabilities?.some((c: string) => ['video', 'image', 'image_gen'].includes(c)));
    const open = (s: any) => { const name = s.displayName || models.find(m => m.modelId === s.modelId)?.displayName || s.modelId; setEdit(structuredClone(s)); setDisplayName(name); setBaseline(snapshot(s, name)); setTab(specs.some(item => item.modelId === s.modelId) ? 'routes' : 'settings'); setResult(null); setNotice(''); setError(''); setExpandedRoute(null); setExitWarning(false); setCopied(false); setSimulation({ images: 0, videos: 0, audios: 0, n: 1, seconds: s.limits.duration.mode === 'options' ? s.limits.duration.values[0] : s.limits.duration.min, resolution: s.limits.resolutions[0] || '', ratio: s.limits.ratios[0] || '16:9', firstFrame: false, lastFrame: false, quality: '' }); topRef.current?.scrollIntoView?.({ block: 'start' }); };
    const close = () => { if (dirty) {
        setExitWarning(true);
        return;
    } setEdit(null); setError(''); setNotice(''); };
    const create = () => { if (suggestions.length) {
        open(suggestions[0]);
        return;
    } const model = mediaModels.find(m => !specs.some(s => s.modelId === m.modelId || !s.imageFamily && s.aliases.includes(m.modelId)) && (!m.capabilities.includes('image') || ['1K', '2K', '4K'].some(r => !specs.some(s => s.imageFamily === m.modelId && s.limits.resolutions[0] === r)))); if (!model) {
        setError('请先在模型管理中添加图片或视频模型');
        return;
    } const kind = model.capabilities.includes('video') ? 'video' : 'image', limits = defaultRoutingLimits(), resolution = ['1K', '2K', '4K'].find(r => !specs.some(s => s.imageFamily === model.modelId && s.limits.resolutions[0] === r)) || '1K'; if (kind === 'image')
        Object.assign(limits, { resolutions: [resolution], maxOutputs: 4, ratios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] }); open({ modelId: kind === 'image' ? imageSpecificationId(model.modelId, resolution) : model.modelId, ...(kind === 'image' ? { imageFamily: model.modelId } : {}), displayName: model.displayName + (kind === 'image' ? ' · ' + resolution : ''), kind, enabled: Boolean(model.isActive), aliases: kind === 'image' ? [model.modelId] : [], limits, routes: [] }); };
    const save = async () => { if (!edit || busy)
        return; setBusy(true); setError(''); try {
        await adminApi.saveModelSpecification({ ...edit, displayName });
        setBaseline(snapshot(edit, displayName));
        setExitWarning(false);
        await load();
        setNotice('规格与线路已保存。新建的 API ID 还需在“模型与用户售价”中配置售价。');
    }
    catch (e: any) {
        setError(e.message);
    }
    finally {
        setBusy(false);
    } };
    const routePatch = (id: string, values: Partial<ModelRoute>) => setEdit(current => current && ({ ...current, routes: current.routes.map(r => r.id === id ? { ...r, ...values } : r) }));
    const addRoute = () => { if (!edit || !channels.length)
        return; const channel = channels[0], modelId = channel.supportedModels?.[0] || edit.modelId, id = crypto.randomUUID(); setEdit({ ...edit, routes: [...edit.routes, { id, channelId: channel.id, executionModel: modelId, upstreamModel: channel.modelMapping?.[modelId] || modelId, enabled: true, limits: structuredClone(edit.limits), cost: null, costUnit: edit.kind === 'image' ? 'per_image' : 'unknown', resolutionCosts: {}, priority: 0 }] }); setExpandedRoute(id); };
    const simulate = async () => { if (!edit)
        return; setBusy(true); setError(''); try {
        if (dirty)
            setNotice('模拟使用后台已保存的配置；修改后请先保存。');
        setResult(await adminApi.simulateModelRoutes(edit.modelId, { reference_images: Array(simulation.images).fill('https://simulation.invalid/image.jpg'), reference_videos: Array(simulation.videos).fill('https://simulation.invalid/video.mp4'), audio_urls: Array(simulation.audios).fill('https://simulation.invalid/audio.mp3'), first_frame: simulation.firstFrame ? 'https://simulation.invalid/first.jpg' : undefined, last_frame: simulation.lastFrame ? 'https://simulation.invalid/last.jpg' : undefined, quality: simulation.quality || undefined, video_length: simulation.seconds, resolution: simulation.resolution, aspect_ratio: simulation.ratio, n: simulation.n }));
    }
    catch (e: any) {
        setError(e.message);
    }
    finally {
        setBusy(false);
    } };
    const available = (s: any) => s.enabled && (s.availableRouteCount || 0) > 0, attention = specs.filter(s => s.enabled && !available(s)).length;
    const visible = specs.filter(s => (filter === 'all' || s.routes.some((r: ModelRoute) => String(r.channelId) === filter)) && (kindFilter === 'all' || s.kind === kindFilter) && (statusFilter === 'all' || (statusFilter === 'attention' ? s.enabled && !available(s) : statusFilter === 'disabled' ? !s.enabled : available(s))) && (!search || (s.displayName + ' ' + s.modelId).toLowerCase().includes(search.toLowerCase())));
    const saleFor = (id: string) => {
        const rule = prices.find(p => p.modelPattern === id && p.configured && !p.inherited);
        return rule ? { configured: true, billingType: rule.billingType, rate: rule.inputPrice, resolutionPrices: rule.extraParams } : specs.find(s => s.modelId === id)?.salePrice || suggestions.find(s => s.modelId === id)?.salePrice;
    };
    const aliasProblem = (id: string) => {
        if (!edit || edit.kind !== 'video') return '';
        const known = saved?.aliasIssues?.find((issue: any) => issue.modelId === id)?.reason;
        if (known) return known;
        const a = saleFor(edit.modelId), b = saleFor(id);
        if (!a?.configured || !b?.configured) return '售价待配置，暂不能合并';
        if (a.billingType !== b.billingType) return '用户计费单位不同，保留独立入口';
        if (a.rate !== b.rate || edit.limits.resolutions.some(r => (a.resolutionPrices?.[r] ?? a.rate) !== (b.resolutionPrices?.[r] ?? b.rate))) return '用户售价不同，保留独立入口';
        return '';
    };
    const aliasIssues = edit?.aliases.flatMap(modelId => { const reason = aliasProblem(modelId); return reason ? [{ modelId, reason }] : []; }) || [];
    const channelNames = (routes: ModelRoute[]) => [...new Set(routes.map(r => channels.find(c => c.id === r.channelId)?.name || '已删除渠道'))];
    const changeTab = (id: EditorTab) => { setTab(id); setExitWarning(false); topRef.current?.closest('main')?.scrollTo?.({ top: 0, behavior: 'instant' }); };
    const tabKeys = (event: React.KeyboardEvent<HTMLDivElement>) => { const index = tabs.findIndex(t => t.id === tab), next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1; if (next < 0)
        return; event.preventDefault(); changeTab(tabs[next].id); document.getElementById('routing-tab-' + tabs[next].id)?.focus(); };
    return <div className="model-routing-page" ref={topRef}>
 {!edit ? <>
 <header className="routing-page-header"><div><span className="routing-eyebrow"><Radio size={15}/>模型服务管理</span><h1>模型规格与线路</h1><p>保留清楚的售卖入口，为可替代渠道配置能力、成本与自动分流。</p></div><div className="routing-header-actions"><button className={buttonClass} onClick={() => void load()} disabled={busy || loading}><RefreshCw size={16}/>刷新状态</button><button className={buttonClass + ' is-primary'} onClick={create} disabled={busy || loading}><Plus size={17}/>添加规格</button></div></header>
 {error && <div role="alert" className="routing-message is-error"><AlertCircle size={18}/><span>{error}</span></div>}
 <section className="routing-overview" aria-label="规格概况">
 <div><span>全部规格</span><strong>{loading ? '—' : specs.length}<small>个</small></strong><p>图片 {specs.filter(s => s.kind === 'image').length} · 视频 {specs.filter(s => s.kind === 'video').length}</p></div>
 <div><span><CheckCircle2 size={15}/>可用规格</span><strong>{loading ? '—' : specs.filter(available).length}<small>个</small></strong><p>已开放且有可用线路</p></div>
 <button className={attention ? 'is-attention' : ''} onClick={() => setStatusFilter(statusFilter === 'attention' ? 'all' : 'attention')} aria-pressed={statusFilter === 'attention'}><span><AlertCircle size={15}/>待处理规格</span><strong>{loading ? '—' : attention}<small>个</small></strong><p>{attention ? '点击查看暂无可用线路的规格' : '已开放规格均有线路可用'}</p></button>
 <div><span>关联渠道</span><strong>{loading ? '—' : new Set(specs.flatMap(s => s.routes.map((r: ModelRoute) => r.channelId))).size}<small>个</small></strong><p>能力匹配后按成本优先分流</p></div>
 </section>
 <section className="routing-catalog" aria-label="规格列表">
 <div className="routing-catalog-heading"><div className="routing-type-filters" aria-label="生成类型筛选">{[{ id: 'all', label: '全部规格', icon: Layers3 }, { id: 'image', label: '图片', icon: Image }, { id: 'video', label: '视频', icon: Video }].map(t => <button key={t.id} aria-pressed={kindFilter === t.id} onClick={() => setKindFilter(t.id)}><t.icon size={16}/>{t.label}<small>{t.id === 'all' ? specs.length : specs.filter(s => s.kind === t.id).length}</small></button>)}</div><Link className="routing-text-link" to="/admin/models">模型与用户售价<ArrowUpRight size={15}/></Link></div>
 <div className="routing-toolbar"><label className="routing-search"><Search size={17}/><input className={inputClass} aria-label="搜索规格" placeholder="搜索模型名称或 API ID" value={search} onChange={e => setSearch(e.target.value)}/></label><label><span className="sr-only">按关联渠道筛选</span><select className={inputClass} value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部渠道</option>{channels.map(c => <option key={c.id} value={c.id}>{c.name}{c.status ? '' : '（已禁用）'}</option>)}</select></label><label><span className="sr-only">按规格状态筛选</span><select className={inputClass} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="all">全部状态</option><option value="available">可用</option><option value="attention">待处理</option><option value="disabled">已关闭</option></select></label></div>
 {loading ? <div className="routing-skeleton" role="status">正在加载规格…</div> : visible.length ? <div className="routing-spec-list">{visible.map(s => <article className="routing-spec-row" key={s.modelId}>
 <div className={'routing-kind-icon ' + (s.kind === 'video' ? 'is-video' : '')}>{s.kind === 'image' ? <Image size={21}/> : <Video size={21}/>}</div>
 <div className="routing-spec-info"><div><h2>{s.displayName}</h2><span className={'routing-status ' + (!s.enabled ? 'is-neutral' : available(s) ? 'is-good' : 'is-warning')}>{!s.enabled ? '已关闭' : available(s) ? '可用' : '待处理'}</span></div><code>{s.modelId}</code><div className="routing-spec-meta"><span>{s.limits.resolutions.join(' / ')}</span><span>{s.kind === 'image' ? '参考图 ≤ ' + s.limits.maxImages + ' 张' : s.limits.maxImages + ' 图 · ' + s.limits.maxVideos + ' 视频 · ' + s.limits.maxAudios + ' 音频'}</span>{s.kind === 'video' && <span>{durationLabel(s.limits)}</span>}</div><p className="routing-sale-inline">{saleSummary(saleFor(s.modelId), s.kind, s.limits.resolutions)}{s.aliasIssues?.length ? ' · 旧入口合并待核对' : ''}</p></div>
 <div className="routing-spec-channels"><strong>{s.availableRouteCount || 0}<span> / {s.routes.length} 条线路可用</span></strong><p title={channelNames(s.routes).join('、')}>{channelNames(s.routes).join(' · ') || '尚未关联渠道'}</p></div><button className={buttonClass + ' routing-manage'} onClick={() => open(s)}>管理线路<ChevronRight size={16}/></button>
 </article>)}</div> : <div className="routing-empty"><Layers3 size={30}/><h2>{specs.length ? '没有匹配的规格' : '开始管理模型线路'}</h2><p>{specs.length ? '调整搜索词或筛选条件，查看其他规格。' : '从已接入模型创建规格，再关联可用渠道。'}</p><button className={buttonClass} onClick={() => specs.length ? (setSearch(''), setFilter('all'), setKindFilter('all'), setStatusFilter('all')) : create()}>{specs.length ? '清除筛选' : '添加第一个规格'}</button></div>}
 {!loading && visible.length > 0 && <footer className="routing-catalog-footer"><span>显示 {visible.length} / {specs.length} 个规格</span><span><CheckCircle2 size={14}/>先匹配能力，再优先选择低成本健康线路</span></footer>}
 </section>
 </> : <section className="routing-editor" aria-label="规格编辑">
 <div className="routing-editor-breadcrumb"><button className="routing-back" onClick={close} disabled={busy}><ArrowLeft size={16}/>返回规格列表</button><span>/</span><span>{saved ? '管理规格' : '新建规格'}</span><button className="routing-detail-refresh" disabled={busy} onClick={() => void load()}><RefreshCw size={15}/>刷新状态</button></div>
 <header className="routing-detail-header"><div className={'routing-kind-icon ' + (edit.kind === 'video' ? 'is-video' : '')}>{edit.kind === 'image' ? <Image size={23}/> : <Video size={23}/>}</div><div><div className="routing-detail-title"><h1>{displayName || '未命名规格'}</h1><span className={'routing-status ' + (edit.enabled ? 'is-good' : 'is-neutral')}>{saved ? edit.enabled ? '对用户开放' : '已关闭' : '未保存草稿'}</span></div><div className="routing-api-id"><code>{edit.modelId}</code><button aria-label="复制 API 模型 ID" className="routing-copy" onClick={async () => { try {
            await navigator.clipboard.writeText(edit.modelId);
            setCopied(true);
        }
        catch {
            setError('复制失败，请选择 API ID 后手动复制');
        } }}>{copied ? <Check size={14}/> : <Copy size={14}/>}</button><span>{edit.limits.resolutions.join(' / ')}<i>·</i>{edit.routes.length} 条关联线路</span></div></div></header>
 <section className="routing-sale-summary" aria-label="用户售价"><div><span>用户售价 · 此入口的收费规则</span><strong>{saleSummary(saleFor(edit.modelId), edit.kind, edit.limits.resolutions)}</strong><small>仅绑定当前 API ID；修改关联渠道和上游成本不会修改用户售价。</small></div><Link className="routing-text-link" to={'/admin/models?priceModel=' + encodeURIComponent(edit.modelId)}>管理用户售价<ArrowUpRight size={15}/></Link></section>
 {aliasIssues.length > 0 && <div className="routing-message is-warning" role="alert"><AlertCircle size={18}/><div><strong>旧入口合并需要核对</strong>{aliasIssues.map(issue => <p key={issue.modelId}>{issue.modelId}：{issue.reason}</p>)}<p>这些旧 API 调用保留原入口与售价。请在规格设置中解除不兼容的旧入口关联。</p></div></div>}
 {exitWarning && <div className="routing-message is-warning" role="alert"><AlertCircle size={18}/><span>有未保存的更改，返回列表会丢失这些修改。</span><div><button className={buttonClass} onClick={() => setExitWarning(false)}>继续编辑</button><button className={buttonClass} onClick={() => { setEdit(null); setExitWarning(false); setError(''); setNotice(''); }}>放弃更改并返回</button></div></div>}
 {error && <div role="alert" className="routing-message is-error"><AlertCircle size={18}/><span>{error}</span></div>}{notice && <div role="status" className="routing-message"><CheckCircle2 size={18}/><span>{notice}</span></div>}
 <div className="routing-editor-tabs" role="tablist" aria-label="规格管理" onKeyDown={tabKeys}>{tabs.map(t => <button key={t.id} role="tab" id={'routing-tab-' + t.id} aria-selected={tab === t.id} aria-controls={'routing-panel-' + t.id} tabIndex={tab === t.id ? 0 : -1} onClick={() => changeTab(t.id)}><t.icon size={17}/>{t.label}{t.id === 'routes' && <small>{edit.routes.length}</small>}</button>)}</div>
 <div className="routing-editor-content" role="tabpanel" id={'routing-panel-' + tab} aria-labelledby={'routing-tab-' + tab}>
 {tab === 'routes' && <><div className="routing-section-heading"><div><h2>这个规格可以走哪些渠道</h2><p>匹配参考素材与输出参数后，优先使用成本低的健康线路。</p></div><button className={buttonClass} onClick={addRoute} disabled={busy || !channels.length}><Plus size={16}/>关联渠道</button></div>
 {!edit.routes.length && <div className="routing-empty"><Radio size={30}/><h3>还没有关联线路</h3><p>添加一个支持此规格的渠道，填写能力与实际成本。</p></div>}
 <div className="routing-route-list">{edit.routes.map(route => {
                    const channel = channels.find(c => c.id === route.channelId), status = saved?.routeStatus?.find((s: any) => s.id === route.id), expanded = expandedRoute === route.id;
                    const state = !route.enabled ? '已停用' : !channel?.status ? '渠道已禁用' : status?.reasons?.length ? '暂不可用' : '参与分流', effectiveCost = route.costUnit === 'unknown' ? null : route.resolutionCosts[edit.limits.resolutions[0]] ?? route.cost;
                    return <article key={route.id} className={'routing-route-card ' + (expanded ? 'is-expanded' : '')}>
 <div className="routing-route-summary"><div className="routing-route-icon"><Radio size={19}/></div><div className="routing-route-info"><h3>{channel?.name || '已删除渠道'}</h3><div className="routing-route-facts"><span>参考图 ≤ {route.limits.maxImages} 张</span>{edit.kind === 'video' && <><span>视频 ≤ {route.limits.maxVideos}</span><span>音频 ≤ {route.limits.maxAudios}</span><span>{durationLabel(route.limits)}</span></>}<span>{route.limits.resolutions.join(' / ')}</span></div></div><div className="routing-route-price"><strong className={effectiveCost == null ? 'is-unknown' : ''}>{effectiveCost == null ? '成本待配置' : money(effectiveCost)}</strong><span>{effectiveCost == null ? route.costUnit === 'unknown' ? '上游计费单位待确认' : '上游金额待填写' : '上游 ' + costUnit(route.costUnit, edit.kind) + ' · 备用顺序 ' + route.priority}</span></div></div>
 <div className="routing-route-actions"><span className={'routing-status ' + (state === '参与分流' ? 'is-good' : state === '暂不可用' ? 'is-warning' : 'is-neutral')}>{state}</span><div><label className="routing-switch"><input type="checkbox" aria-label="启用这条模型线路" checked={route.enabled} disabled={busy} onChange={e => routePatch(route.id, { enabled: e.target.checked })}/><span aria-hidden="true"/><em>{route.enabled ? '已启用' : '已停用'}</em></label><button className="routing-button is-quiet" aria-expanded={expanded} aria-controls={'routing-route-form-' + route.id} onClick={() => setExpandedRoute(expanded ? null : route.id)}>{expanded ? '收起配置' : '配置线路'}<ChevronDown size={15} className={expanded ? 'is-rotated' : ''}/></button></div></div>
 {Boolean(status?.reasons?.length) && <p className="routing-route-warning"><AlertCircle size={15}/>{status.reasons.join('；')}</p>}
 {status?.health?.filter((h: any) => h.state !== 'healthy').map((health: any) => <div className="routing-health" key={health.key}><div><AlertCircle size={16}/><span>{health.state === 'blocked' ? '请处理 Key 或余额后恢复检测' : health.retryAt > Date.now() ? '线路冷却中' : '等待恢复试用'}{health.lastError ? ' · ' + health.lastError : ''}<small>完成 {health.successes || 0} 次 · 连续失败 {health.failures || 0} 次</small></span></div><button className={buttonClass} disabled={busy} onClick={async () => { setBusy(true); try {
                        await adminApi.resetModelRouteHealth(edit.modelId, health.key);
                        await load();
                    }
                    catch (e: any) {
                        setError(e.message);
                    }
                    finally {
                        setBusy(false);
                    } }}>恢复检测</button></div>)}
 {expanded && <div className="routing-route-form" id={'routing-route-form-' + route.id}>
 <fieldset className="routing-fields"><legend>渠道与模型</legend><label>渠道<select className={inputClass} value={route.channelId} onChange={e => { const next = channels.find(c => c.id === Number(e.target.value)), exec = next?.supportedModels?.[0] || edit.modelId; routePatch(route.id, { channelId: Number(e.target.value), executionModel: exec, upstreamModel: next?.modelMapping?.[exec] || exec }); }}>{channels.map(c => <option key={c.id} value={c.id}>{c.name}{c.status ? '' : '（已禁用）'}</option>)}</select></label><label>渠道执行模型<input className={inputClass} list={'execution-' + route.id} value={route.executionModel} onChange={e => routePatch(route.id, { executionModel: e.target.value, upstreamModel: channel?.modelMapping?.[e.target.value] || e.target.value })}/><datalist id={'execution-' + route.id}>{channel?.supportedModels?.filter((id: string) => id !== '*').map((id: string) => <option key={id} value={id}/>)}</datalist></label><label>实际上游模型 ID<input className={inputClass} value={route.upstreamModel} onChange={e => routePatch(route.id, { upstreamModel: e.target.value })}/></label></fieldset>
 <fieldset className="routing-fields"><legend>成本与排序</legend><label>基础上游成本（元，未知留空）<input className={inputClass} type="number" min="0" step="0.000001" disabled={route.costUnit === 'unknown'} value={route.cost ?? ''} onChange={e => routePatch(route.id, { cost: e.target.value === '' ? null : Number(e.target.value) })}/></label><label>上游成本单位<select className={inputClass} value={route.costUnit} onChange={e => routePatch(route.id, { costUnit: e.target.value as any, ...(e.target.value === 'unknown' ? { cost: null, resolutionCosts: {} } : {}) })}><option value="unknown">待确认</option>{edit.kind === 'video' ? <><option value="per_call">按条 · 每条视频</option><option value="per_second">按秒 · 每秒视频</option></> : <><option value="per_image">每张图片</option><option value="per_call">每次请求</option></>}</select></label><label>同成本备用顺序（小值优先）<input className={inputClass} type="number" value={route.priority} onChange={e => routePatch(route.id, { priority: Number(e.target.value) })}/></label><p className="routing-field-help">填写第三方真实结算单位和成本，不从用户售价推测。成本待配置的线路排在已知成本之后。同一渠道不同时长成本不同，可添加多条关联，分别设置时长与成本。</p></fieldset>
 <details className="routing-advanced"><summary>分辨率单独成本<span>留空沿用基础成本<ChevronDown size={15}/></span></summary><div className="routing-fields">{route.limits.resolutions.map(resolution => <label key={resolution}>{resolution} 成本<input className={inputClass} type="number" min="0" step="0.000001" disabled={route.costUnit === 'unknown'} value={route.resolutionCosts[resolution] ?? ''} onChange={e => { const costs = { ...route.resolutionCosts }; if (!e.target.value)
                            delete costs[resolution];
                        else
                            costs[resolution] = Number(e.target.value); routePatch(route.id, { resolutionCosts: costs }); }}/></label>)}</div></details>
 <LimitsEditor value={route.limits} onChange={limits => routePatch(route.id, { limits })} kind={edit.kind}/>
 <div className="routing-route-form-footer"><span>禁用线路后不再参与新请求分流，已受理任务继续查询。</span><button className="routing-button is-danger" onClick={() => { setEdit({ ...edit, routes: edit.routes.filter(r => r.id !== route.id) }); setExpandedRoute(null); }}>移除关联</button></div>
 </div>}
 </article>;
                })}</div>
 <div className="routing-policy-note"><SlidersHorizontal size={18}/><p><strong>自动选路规则</strong>满足素材数量、分辨率、比例和时长 → 比较本次请求成本 → 优先使用健康线路。手动禁用的模型、渠道及 Key 不参与分流。</p></div>
 </>}
 {tab === 'settings' && <div className="routing-settings">
 {!saved && <div className="routing-form-section"><div className="routing-section-heading"><div><h2>从已有接入开始</h2><p>载入已确认的能力和渠道作为草稿，核对后保存。</p></div></div><label>从现有已接入模型载入能力和线路<select className={inputClass} value={suggestions.some(s => s.modelId === edit.modelId) ? edit.modelId : ''} onChange={e => { const draft = suggestions.find(s => s.modelId === e.target.value); if (draft)
                open(draft); }}><option value="">自定义规格</option>{suggestions.map(s => <option key={s.modelId} value={s.modelId}>{s.displayName} · {s.modelId}</option>)}</select></label></div>}
 <div className="routing-form-section"><div className="routing-section-heading"><div><h2>用户看到的入口</h2><p>{edit.kind === 'image' ? '图片按模型与输出分辨率区分；参考图数量用于后台匹配渠道。' : '保留原售卖名称、计费方式和时长规则；可替代渠道在此入口内分流。'}</p></div></div>
 <div className="routing-fields"><label>用户看到的名称<input className={inputClass} value={displayName} onChange={e => setDisplayName(e.target.value)}/></label><label>API 模型 ID（保存后保持稳定）<input className={inputClass} value={edit.modelId} disabled={Boolean(saved)} onChange={e => setEdit({ ...edit, modelId: e.target.value.trim() })}/></label><label>生成类型<select className={inputClass} disabled={Boolean(saved)} value={edit.kind} onChange={e => setEdit({ ...edit, kind: e.target.value as any, imageFamily: undefined })}><option value="video">视频</option><option value="image">图片</option></select></label>{edit.kind === 'image' && <label>所属图片模型<input className={inputClass} value={edit.imageFamily || ''} disabled={Boolean(saved)} placeholder="gpt-image-2" onChange={e => setEdit({ ...edit, imageFamily: e.target.value.trim() || undefined })}/></label>}</div>
 <label className="routing-availability-toggle"><span><strong>对用户开放此规格</strong><small>还需模型本身启用，并至少有一条可用线路。</small></span><span className="routing-switch"><input aria-label="对用户开放此规格" type="checkbox" checked={edit.enabled} onChange={e => setEdit({ ...edit, enabled: e.target.checked })}/><span aria-hidden="true"/></span></label></div>
 <div className="routing-form-section"><LimitsEditor key={edit.modelId} singleResolution={edit.kind === 'image'} resolutionLocked={edit.kind === 'image' && Boolean(saved)} value={edit.limits} onChange={limits => { if (edit.kind === 'image' && edit.imageFamily && !saved && limits.resolutions[0] !== edit.limits.resolutions[0]) {
                setDisplayName(displayName.replace(/ · [124]K$/i, '') + ' · ' + limits.resolutions[0]);
                setEdit({ ...edit, modelId: imageSpecificationId(edit.imageFamily, limits.resolutions[0]), limits });
            }
            else
                setEdit({ ...edit, limits }); }} kind={edit.kind}/></div>
 <details className="routing-aliases"><summary>合并已有重复入口（{edit.aliases.length} 个）<ChevronDown size={16}/></summary><p>{edit.kind === 'image' ? '同一模型的不同分辨率可关联相同旧入口。旧调用按 resolution 匹配规格。' : '只合并用户售价、计费单位和服务能力一致的重复入口。不同售价或按条／按秒的入口分别保留。'}</p><div>{mediaModels.filter(m => m.capabilities.includes(edit.kind) && m.modelId !== edit.modelId && !specs.some(s => s.modelId !== edit.modelId && (s.modelId === m.modelId || s.aliases.includes(m.modelId) && !canShareImageAliases(s, edit)))).map(m => <label key={m.modelId}><input type="checkbox" disabled={!edit.aliases.includes(m.modelId) && Boolean(aliasProblem(m.modelId))} checked={edit.aliases.includes(m.modelId)} onChange={e => setEdit({ ...edit, aliases: e.target.checked ? [...edit.aliases, m.modelId] : edit.aliases.filter(id => id !== m.modelId) })}/><span>{m.displayName} · {m.modelId}{m.isActive ? '' : '（已停用）'}{aliasProblem(m.modelId) && <small className="routing-alias-reason">{aliasProblem(m.modelId)}</small>}</span></label>)}</div></details>
 </div>}
 {tab === 'simulation' && <section className="routing-simulator" aria-label="模拟选路"><div className="routing-section-heading"><div><h2>验证一组参数会走哪条线路</h2><p>使用已保存配置进行匹配，不调用第三方、不产生生成费用。</p></div><span className="routing-status is-neutral">仅模拟</span></div>{!saved && <div className="routing-message is-warning"><AlertCircle size={17}/><span>请先保存此规格，再进行模拟。</span></div>}
 <div className="routing-simulation-layout"><div className="routing-form-section"><h3>请求参数</h3><div className="routing-limits-grid">
 {([['images', '图片数'], ['videos', '视频数'], ['audios', '音频数'], ['seconds', '秒数'], ['n', '输出数']] as const).filter(([key]) => edit.kind === 'video' || !['videos', 'audios', 'seconds'].includes(key)).map(([key, label]) => <label key={key}>{label}<input className={inputClass} type="number" min="0" max={key === 'seconds' ? 3600 : 100} value={simulation[key]} onChange={e => setSimulation({ ...simulation, [key]: Math.min(key === 'seconds' ? 3600 : 100, Math.max(0, Number(e.target.value))) })}/></label>)}
 <label>分辨率<select className={inputClass} value={simulation.resolution} onChange={e => setSimulation({ ...simulation, resolution: e.target.value })}>{(saved || edit).limits.resolutions.map((r: string) => <option key={r}>{r}</option>)}</select></label><label>比例<select className={inputClass} value={simulation.ratio} onChange={e => setSimulation({ ...simulation, ratio: e.target.value })}>{(saved || edit).limits.ratios.map((r: string) => <option key={r}>{r}</option>)}</select></label><label>质量档位<input className={inputClass} value={simulation.quality} placeholder="默认" onChange={e => setSimulation({ ...simulation, quality: e.target.value })}/></label>
 {edit.kind === 'video' && <div className="routing-checkbox-group"><label><input type="checkbox" checked={simulation.firstFrame} onChange={e => setSimulation({ ...simulation, firstFrame: e.target.checked })}/> 独立首帧</label><label><input type="checkbox" checked={simulation.lastFrame} onChange={e => setSimulation({ ...simulation, lastFrame: e.target.checked })}/> 独立尾帧</label></div>}
 </div><button className={buttonClass + ' is-primary'} disabled={busy || !saved} onClick={() => void simulate()}><Play size={16}/>{busy ? '正在匹配…' : '模拟'}</button></div>
 <div className="routing-simulation-results" aria-live="polite" ref={resultRef}><h3>选路结果</h3>{!result ? <div className="routing-result-placeholder"><Radio size={28}/><strong>等待模拟</strong><p>输入素材数量与输出参数，查看匹配渠道、排除原因和预计成本。</p></div> : <><p className="routing-result-count">{result.items.filter((i: any) => !i.reasons.length).length} 条匹配 · {result.items.filter((i: any) => i.reasons.length).length} 条排除</p>{[...result.items].sort((a: any, b: any) => Number(b.routeId === result.selectedRouteId) - Number(a.routeId === result.selectedRouteId)).map((item: any) => <div className={'routing-result-card ' + (item.routeId === result.selectedRouteId ? 'is-selected' : '')} key={item.routeId}><div><strong>{channels.find(c => c.id === item.channelId)?.name || '已删除渠道'}</strong><span className={'routing-status ' + (item.routeId === result.selectedRouteId ? 'is-good' : item.reasons.length ? 'is-warning' : 'is-neutral')}>{item.routeId === result.selectedRouteId ? '优先选择' : item.reasons.length ? '已排除' : '可用备选'}</span></div><p>{item.reasons.length ? item.reasons.join('；') : '符合本次请求参数'}</p><small>预计上游成本 <b>{money(item.estimatedCost)}</b></small></div>)}{!result.selectedRouteId && <p className="routing-route-warning"><AlertCircle size={16}/>没有可用且匹配的线路，请检查参数或线路配置。</p>}</>}</div>
 </div></section>}
 </div>
 <footer className="routing-save-bar"><div><span className={'routing-save-indicator ' + (dirty ? 'is-dirty' : '')}/><span>{dirty ? '有未保存的更改' : saved ? '当前配置已保存' : '新规格草稿，保存后生效'}</span></div><div><Link className="routing-text-link" to="/admin/models">模型与用户售价<ArrowUpRight size={15}/></Link><button className={buttonClass + ' is-primary'} onClick={() => void save()} disabled={busy || Boolean(saved) && !dirty}><Save size={16}/>{busy ? '处理中…' : '保存规格与线路'}</button></div></footer>
 </section>}
 </div>;
}
