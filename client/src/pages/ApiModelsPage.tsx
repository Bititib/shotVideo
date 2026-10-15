import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, Copy, FileText, KeyRound, Layers3, RefreshCw, Search, X } from 'lucide-react';
import { tokensApi } from '../api/tokens';
import { developerApi } from '../api/developer';
import type { DeveloperEndpoint, DeveloperModel, DeveloperModelCatalog, DeveloperModelKind } from '../../../shared/developerModels';
import { formatModelPrice, modelExample } from '../utils/apiModelExamples';
import './ApiModelsPage.css';

interface KeyOption { id: number; name: string; tokenKeyMasked: string; status: number; expiresAt: string | null }
const labels: Record<DeveloperModelKind, string> = { text: '文本', image: '图片', video: '视频', tts: '语音', other: '其他' };
const healthLabels = { healthy: '近期正常', degraded: '近期有波动', unavailable: '近期异常', unknown: '样本不足' };
const endpointLabels: Record<DeveloperEndpoint, string> = {
  '/v1/chat/completions': '对话补全', '/v1/images/generations': '图片生成', '/v1/images/edits': '图片编辑', '/v1/videos': '视频生成',
};

function ModelDetails({ model, onClose, onCopy, notice }: { model: DeveloperModel; onClose: () => void; onCopy: (value: string) => void; notice: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [endpoint, setEndpoint] = useState<DeveloperEndpoint>(model.endpoints[0]);
  const [language, setLanguage] = useState<'curl' | 'python'>('curl');
  useEffect(() => { const node = dialog.current!; node.showModal(); return () => node.close(); }, []);
  const limits = model.limits;
  const duration = limits?.duration;
  const code = endpoint ? modelExample(model, endpoint, window.location.origin, language) : '';
  return <dialog ref={dialog} className="api-model-dialog" aria-labelledby="model-detail-title" onCancel={onClose}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="api-model-detail">
      <header><div><p className="api-model-eyebrow">MODEL DETAILS</p><h2 id="model-detail-title">{model.name}</h2></div><button className="api-model-icon" aria-label="关闭详情" onClick={onClose}><X size={20} /></button></header>
      <div className="api-model-detail-body">
        <p className="api-model-muted">{model.description || '查看模型规格和调用方式。'}</p>
        <div className="api-model-id"><code>{model.id}</code><button className="api-model-icon" onClick={() => onCopy(model.id)} aria-label="复制调用 ID"><Copy size={16} /></button></div>
        <section><h3>价格</h3><p>{formatModelPrice(model.pricing)}</p>
          {model.pricing && Object.keys(model.pricing.resolution_prices).length > 0 && <dl className="api-model-specs">{Object.entries(model.pricing.resolution_prices).map(([resolution, rate]) => <div key={resolution}><dt>{resolution}</dt><dd>{formatModelPrice({ ...model.pricing!, unit_price: rate })}</dd></div>)}</dl>}
        </section>
        <section><h3>输入与输出规格</h3>{limits ? <dl className="api-model-specs">
          <div><dt>分辨率</dt><dd>{limits.resolutions.join(' / ') || '以接口文档为准'}</dd></div>
          <div><dt>画面比例</dt><dd>{limits.ratios.join(' / ') || '以接口文档为准'}</dd></div>
          {model.kinds.includes('video') && duration && <div><dt>时长</dt><dd>{duration.mode === 'fixed' ? `${duration.min} 秒` : duration.mode === 'options' ? `${duration.values.join(' / ')} 秒` : `${duration.min}–${duration.max} 秒，步长 ${duration.step} 秒`}</dd></div>}
          <div><dt>参考图片</dt><dd>{limits.minImages}–{limits.maxImages} 张{limits.firstFrame ? ' · 支持首帧' : ''}{limits.lastFrame ? ' · 支持尾帧' : ''}</dd></div>
          {model.kinds.includes('video') && <><div><dt>参考视频</dt><dd>最多 {limits.maxVideos} 个</dd></div><div><dt>参考音频</dt><dd>最多 {limits.maxAudios} 段</dd></div></>}
          <div><dt>输出数量</dt><dd>最多 {limits.maxOutputs} 个</dd></div>
          {limits.qualities.length > 0 && <div><dt>质量档位</dt><dd>{limits.qualities.join(' / ')}</dd></div>}
        </dl> : <p className="api-model-muted">暂未提供统一规格，请查阅接口文档确认参数。</p>}</section>
        <section><h3>调用示例</h3>{model.endpoints.length ? <>
          <div className="api-model-example-controls"><label>接口<select value={endpoint} onChange={event => setEndpoint(event.target.value as DeveloperEndpoint)}>{model.endpoints.map(path => <option key={path} value={path}>{endpointLabels[path]}</option>)}</select></label>
            <div className="api-model-language" aria-label="示例语言">{(['curl', 'python'] as const).map(value => <button key={value} aria-pressed={language === value} onClick={() => setLanguage(value)}>{value === 'curl' ? 'cURL' : 'Python'}</button>)}</div>
            <button className="api-model-button" onClick={() => onCopy(code)}><Copy size={14} />复制示例</button></div>
          <code className="api-model-path">POST {endpoint}</code><pre>{code}</pre>
          <p className="api-model-muted api-model-small">将示例中的 Key 和素材路径替换为自己的内容；特殊模型参数请结合接口文档确认。</p>
        </> : <p className="api-model-muted">该模型暂未开放兼容 API 接口。</p>}</section>
        <Link className="api-model-link" to="/app/docs?tab=docs" onClick={onClose}><FileText size={16} />查看完整接口文档<ArrowRight size={14} /></Link>
        <p className="api-model-muted" role="status" aria-live="polite">{notice}</p>
      </div>
    </div>
  </dialog>;
}

export default function ApiModelsPage({ embedded = false }: { embedded?: boolean }) {
  const [keys, setKeys] = useState<KeyOption[]>([]);
  const [tokenId, setTokenId] = useState('');
  const [catalog, setCatalog] = useState<DeveloperModelCatalog | null>(null);
  const [keysLoading, setKeysLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [keysError, setKeysError] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('all');
  const [selected, setSelected] = useState<DeveloperModel | null>(null);
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  useEffect(() => {
    let current = true;
    setKeysLoading(true); setKeysError('');
    (async () => {
      const items: KeyOption[] = [];
      let page = 1;
      do {
        const result = await tokensApi.getTokens({ page, pageSize: 50 });
        if (!current) return;
        items.push(...result.items);
        if (!result.items.length || items.length >= result.total) break;
        page++;
      } while (current);
      if (!current) return;
      setKeys(items);
      setTokenId(previous => items.some(item => String(item.id) === previous) ? previous : String((items.find(item => item.status === 1 && (!item.expiresAt || new Date(item.expiresAt) > new Date())) || items[0])?.id || ''));
    })().catch(err => { if (current) setKeysError(err.message || 'API Key 加载失败'); })
      .finally(() => { if (current) setKeysLoading(false); });
    return () => { current = false; };
  }, [revision]);
  useEffect(() => {
    const controller = new AbortController();
    setCatalog(null); setSelected(null); setError('');
    if (!tokenId || keysLoading || keysError) { setLoading(false); return; }
    setLoading(true);
    developerApi.getModels(Number(tokenId), controller.signal).then(result => { if (!controller.signal.aborted) setCatalog(result); })
      .catch(err => { if (!controller.signal.aborted) setError(err.message || '模型列表加载失败'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [tokenId, keysLoading, keysError, revision]);
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setNotice('已复制'); }
    catch { setNotice('复制失败，请手动选择并复制'); }
    clearTimeout(noticeTimer.current); noticeTimer.current = setTimeout(() => setNotice(''), 2500);
  }
  const activeCatalog = catalog?.token.id === Number(tokenId) && !keysLoading ? catalog : null;
  const items = activeCatalog?.items || [];
  const query = search.trim().toLowerCase();
  const filtered = items.filter(model => (kind === 'all' || model.kinds.includes(kind as DeveloperModelKind))
    && `${model.name} ${model.id} ${model.canonicalId} ${model.description}`.toLowerCase().includes(query));
  const busy = keysLoading || loading;
  return <div className="api-model-page">
    {!embedded && <header className="api-model-heading"><div><p className="api-model-eyebrow">DEVELOPER / MODELS</p><h1>API 模型</h1><p className="api-model-muted">找到当前密钥可访问的模型，查看价格与接入方式。</p></div><Link className="api-model-button" to="/app/docs?tab=docs"><FileText size={16} />接口文档<ArrowRight size={14} /></Link></header>}
    <div className={`api-model-connection ${embedded ? 'is-embedded' : ''}`}>{!embedded && <div><span className="api-model-eyebrow">BASE URL</span><div className="api-model-base"><code>{window.location.origin}/v1</code><button className="api-model-icon" aria-label="复制 Base URL" onClick={() => copy(`${window.location.origin}/v1`)}><Copy size={15} /></button></div></div>}
      <label className="api-model-key"><span><KeyRound size={14} />当前 API Key</span><select aria-label="当前 API Key" value={tokenId} disabled={keysLoading || !keys.length} onChange={event => { setSelected(null); setTokenId(event.target.value); }}>
        {!keys.length && <option value="">{keysLoading ? '正在加载…' : '暂无 API Key'}</option>}{keys.map(key => <option key={key.id} value={key.id}>{key.name || 'API Key'} · {key.tokenKeyMasked}{key.status === 0 ? '（已停用）' : key.expiresAt && new Date(key.expiresAt) < new Date() ? '（已过期）' : ''}</option>)}
      </select></label><button className="api-model-button" disabled={busy} onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} className={busy ? 'animate-spin' : ''} />刷新</button>
    </div>
    <div className="api-model-toolbar"><div className="api-model-filters" aria-label="模型类型">{(['all', 'text', 'image', 'video', 'tts', 'other'] as const).filter(value => value === 'all' || items.some(model => model.kinds.includes(value))).map(value => <button key={value} aria-pressed={kind === value} onClick={() => setKind(value)}>{value === 'all' ? '全部模型' : labels[value]}<span>{value === 'all' ? items.length : items.filter(model => model.kinds.includes(value)).length}</span></button>)}</div>
      <label className="api-model-search"><Search size={16} /><input aria-label="搜索模型" placeholder="搜索模型名称或 ID" value={search} onChange={event => setSearch(event.target.value)} /></label></div>
    {(keysError || error) && <div className="api-model-error" role="alert"><p>{keysError || error}</p><button className="api-model-link" onClick={() => setRevision(value => value + 1)}>重新加载</button><Link to="/app/profile">管理 API Key</Link></div>}
    {busy ? <div className="api-model-empty" role="status"><RefreshCw className="animate-spin" size={24} /><p>正在加载模型目录…</p></div> : !keysError && !error && !keys.length ? <div className="api-model-empty"><KeyRound size={30} /><h2>创建密钥，开始接入</h2><p>在个人中心创建 API Key 后，即可查看可访问模型。</p><Link className="api-model-button api-model-primary" to="/app/profile">前往创建 API Key<ArrowRight size={15} /></Link></div> : !keysError && !error && !filtered.length ? <div className="api-model-empty"><Layers3 size={30} /><h2>{items.length ? '没有匹配的模型' : '当前 Key 暂无可访问模型'}</h2><p>{items.length ? '尝试其他关键词或模型类型。' : '请检查模型是否已启用及密钥授权，或切换 API Key。'}</p>{items.length > 0 && <button className="api-model-button" onClick={() => { setSearch(''); setKind('all'); }}>清除筛选</button>}</div> : !keysError && !error && <div className="api-model-list"><table aria-label="API 模型列表">
      <thead><tr><th scope="col">模型 / 调用 ID</th><th scope="col">类型</th><th scope="col">调用价格</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead>
      <tbody>{filtered.map(model => <tr key={model.canonicalId}>
        <td className="api-model-name-cell"><h2>{model.name}</h2><div className="api-model-row-id"><code>{model.id}</code><button className="api-model-icon" aria-label={`复制 ${model.name} 的调用 ID`} onClick={() => copy(model.id)}><Copy size={14} /></button></div>{model.description && <p className="api-model-row-description">{model.description}</p>}</td>
        <td className="api-model-type-cell"><div className="api-model-badges">{model.kinds.map(value => <span key={value}>{labels[value]}</span>)}</div></td>
        <td className="api-model-price-cell" data-label="调用价格"><strong>{formatModelPrice(model.pricing)}</strong>{model.pricing && Object.keys(model.pricing.resolution_prices).length > 0 && <small>分辨率价格见详情</small>}</td>
        <td className="api-model-state-cell"><span className={`api-model-status ${model.available ? 'is-available' : ''}`}><i />{model.available ? '可用' : model.endpoints.length ? '暂不可用' : 'API 暂未开放'}</span>{model.health && <small>{healthLabels[model.health.state]}</small>}</td>
        <td className="api-model-action-cell"><button className="api-model-link" onClick={() => setSelected(model)}>详情与示例<ArrowRight size={15} /></button></td>
      </tr>)}</tbody>
    </table></div>}
    {activeCatalog && !busy && <footer className="api-model-footer"><span>展示 {filtered.length} / {items.length} 个模型 · 按当前 Key 权限筛选</span><span>更新于 {new Date(activeCatalog.checkedAt).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}（北京时间）</span></footer>}
    <div className="api-model-notice" role="status" aria-live="polite">{notice && <span><Check size={15} />{notice}</span>}</div>
    {selected && <ModelDetails model={selected} onClose={() => setSelected(null)} onCopy={copy} notice={notice} />}
  </div>;
}
