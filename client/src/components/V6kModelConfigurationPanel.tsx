import { useEffect, useRef, useState } from 'react';
import { defaultRoutingLimits, type DurationRule } from '../../../shared/modelRouting';
import type { V6kModelConfiguration, V6kModelDraft, V6kRequestSample } from '../../../shared/v6kModelConfiguration';
import { adminApi } from '../api/admin';
import AdminDrawer from './AdminDrawer';
import './V6kModelConfigurationPanel.css';

const field = 'v6k-field';
const button = 'v6k-button';
const tabs = ['参数与媒体', '请求体样例', '线路配置 JSON'] as const;
const split = (value: string) => value.split(/[,，]/).map(item => item.trim()).filter(Boolean);
const blank = (): V6kModelDraft => ({ modelId: '', displayName: '', upstreamModel: '', enabled: true, routeEnabled: true, limits: defaultRoutingLimits() });
type PendingNavigation = { kind: 'model'; model: V6kModelConfiguration | null } | { kind: 'close' };

function formValue(draft: V6kModelDraft, resolutions: string, ratios: string, seconds: string): V6kModelDraft {
  const values = split(seconds).map(Number), rule = draft.limits.duration;
  const duration = rule.mode === 'options' && values.length
    ? { ...rule, min: Math.min(...values), max: Math.max(...values), step: 1, values }
    : { ...rule, max: rule.mode === 'fixed' ? rule.min : rule.max, values: [] };
  return { modelId: draft.modelId.trim(), displayName: draft.displayName.trim(), upstreamModel: draft.upstreamModel.trim(),
    enabled: draft.enabled, routeEnabled: draft.routeEnabled,
    limits: { ...draft.limits, duration, resolutions: split(resolutions), ratios: split(ratios) } };
}

export default function V6kModelConfigurationPanel({ channelId, onClose, onSaved }: {
  channelId: number; onClose: () => void; onSaved: () => void;
}) {
  const [models, setModels] = useState<V6kModelConfiguration[]>([]);
  const [selected, setSelected] = useState<V6kModelConfiguration | null>(null);
  const [draft, setDraft] = useState(blank);
  const [resolutions, setResolutions] = useState('720p');
  const [ratios, setRatios] = useState('16:9,9:16,1:1');
  const [seconds, setSeconds] = useState('');
  const [tab, setTab] = useState<typeof tabs[number]>('参数与媒体');
  const [sample, setSample] = useState<V6kRequestSample>({});
  const [preview, setPreview] = useState<{ method: string; path: string; body: object } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [pending, setPending] = useState<PendingNavigation | null>(null);
  const [baseline, setBaseline] = useState('');
  const content = useRef<HTMLDivElement>(null);
  const modelIdInput = useRef<HTMLInputElement>(null);
  const activeModel = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (content.current) content.current.scrollTop = 0; }, [tab, selected?.modelId]);
  useEffect(() => { activeModel.current?.scrollIntoView?.({ block: 'nearest' }); }, [selected?.modelId, models]);

  function choose(configuration: V6kModelConfiguration | null) {
    const value = configuration ?? blank();
    setSelected(configuration);
    setDraft(value);
    setResolutions(value.limits.resolutions.join(','));
    setRatios(value.limits.ratios.join(','));
    setSeconds(value.limits.duration.values.join(','));
    setSample({});
    setPreview(null);
    setNotice('');
    setError('');
    setTab('参数与媒体');
    setPending(null);
    setBaseline(JSON.stringify(formValue(value, value.limits.resolutions.join(','), value.limits.ratios.join(','), value.limits.duration.values.join(','))));
  }

  useEffect(() => {
    let active = true;
    adminApi.getV6kModelConfigurations(channelId).then(rows => {
      if (active) { setModels(rows); choose(rows.find(row => row.editable) ?? rows[0] ?? null); setLoaded(true); }
    }).catch((err: Error) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [channelId]);

  const update = (change: Partial<V6kModelDraft>) => { setDraft(value => ({ ...value, ...change })); setPreview(null); setNotice(''); };
  const limits = draft.limits;
  const changeLimits = (changes: Partial<V6kModelDraft['limits']>) => update({ limits: { ...limits, ...changes } });
  const changeDuration = (changes: Partial<DurationRule>) => changeLimits({ duration: { ...limits.duration, ...changes } });
  const config = () => formValue(draft, resolutions, ratios, seconds);
  const dirty = loaded && JSON.stringify(config()) !== baseline;
  const disabled = busy || !loaded || selected?.editable === false;
  const matchingModels = models.filter(row => [row.modelId, row.displayName, row.upstreamModel]
    .some(value => value.toLowerCase().includes(search.trim().toLowerCase())));

  function navigate(next: PendingNavigation) {
    if (busy || next.kind === 'model' && !loaded) return;
    if (next.kind === 'model' && next.model?.modelId === selected?.modelId) {
      setTab('参数与媒体');
      if (content.current) content.current.scrollTop = 0;
      if (!next.model) modelIdInput.current?.focus();
      return;
    }
    if (dirty) { setPending(next); if (content.current) content.current.scrollTop = 0; return; }
    applyNavigation(next);
  }

  function applyNavigation(next: PendingNavigation) {
    if (next.kind === 'close') { onClose(); return; }
    choose(next.model);
    if (!next.model) queueMicrotask(() => modelIdInput.current?.focus());
  }

  async function generatePreview() {
    setBusy(true); setError(''); setPreview(null);
    try { setPreview(await adminApi.previewV6kModel(channelId, config(), sample)); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await adminApi.saveV6kModel(channelId, config(), selected?.version ?? null);
      let refreshed: V6kModelConfiguration[] | null = null;
      try { refreshed = await adminApi.getV6kModelConfigurations(channelId); }
      catch { /* The save succeeded; keep its result even if refreshing the list fails. */ }
      const saved = refreshed?.find(row => row.modelId === result.modelId) ?? result;
      setModels(rows => {
        const current = refreshed ?? rows;
        return current.some(row => row.modelId === saved.modelId)
          ? current.map(row => row.modelId === saved.modelId ? saved : row) : [...current, saved];
      });
      choose(saved);
      setSearch('');
      const success = selected ? '配置已保存。后续提交使用新配置。' : '模型已添加，模型总开关保持停用。下一步：到关联模型列表设置售价并启用。';
      setNotice(success + (refreshed ? '' : ' 模型列表刷新失败，请重新打开后再编辑其他模型。'));
      if (content.current) content.current.scrollTop = 0;
      onSaved();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return <AdminDrawer modal panelClassName="v6k-model-dialog" title="纵横 V6K · 模型与参数" blocked={busy} onClose={() => navigate({ kind: 'close' })}>
    <div className="v6k-workspace">
      <aside className="v6k-model-sidebar" aria-label="模型选择">
        <button type="button" className={button + ' v6k-button-primary v6k-add-model'} disabled={busy || !loaded}
          onClick={() => navigate({ kind: 'model', model: null })}><span aria-hidden="true">＋</span>添加新模型</button>
        <div className="v6k-sidebar-heading"><h3>编辑已有模型</h3><span>{models.length} 个</span></div>
        <input className={field} aria-label="搜索已有模型" placeholder="搜索名称或模型 ID" value={search}
          onChange={event => setSearch(event.target.value)} />
        <label className="v6k-mobile-picker">切换模型
          <select className={field} value={selected?.modelId || ''} disabled={busy || !loaded}
            onChange={event => navigate({ kind: 'model', model: models.find(row => row.modelId === event.target.value) ?? null })}>
            <option value="">添加新模型</option>
            {models.map(row => <option key={row.modelId} value={row.modelId}>{row.displayName || row.modelId}</option>)}
          </select>
        </label>
        <div className="v6k-model-list">
          {!loaded && !error && <p className="v6k-sidebar-empty">正在加载模型…</p>}
          {loaded && !matchingModels.length && <p className="v6k-sidebar-empty">{models.length ? '没有匹配的模型' : '暂无模型，点击上方添加新模型。'}</p>}
          {matchingModels.map(row => <button type="button" key={row.modelId} disabled={busy || !loaded}
            ref={selected?.modelId === row.modelId ? activeModel : null}
            aria-label={'编辑模型 ' + (row.displayName || row.modelId)}
            aria-current={selected?.modelId === row.modelId ? 'true' : undefined}
            onClick={() => navigate({ kind: 'model', model: row })} className="v6k-model-list-item">
            <strong>{row.displayName || row.modelId}</strong>
            <code>{row.modelId}</code>
            <span className="v6k-route-label">上游：{row.upstreamModel}</span>
            <span className={'v6k-model-badge' + (!row.editable ? ' is-managed' : row.enabled && row.routeEnabled ? ' is-enabled' : '')}>
              {!row.editable ? '专用配置' : row.enabled && row.routeEnabled ? '规格与线路已开启' : '规格或线路未开启'}
            </span>
          </button>)}
        </div>
      </aside>
      <div className="v6k-editor">
        <header className="v6k-editor-heading">
          <div><p>{selected ? '编辑已有模型' : '添加新模型'}</p><h3>{selected ? selected.displayName || selected.modelId : '填写新模型配置'}</h3></div>
          {dirty && <span className="v6k-unsaved">有未保存的修改</span>}
        </header>
        <nav aria-label="模型配置内容" className="v6k-model-tabs">
          {tabs.map(item => <button type="button" key={item} disabled={busy} aria-pressed={tab === item}
            onClick={() => setTab(item)}>{item}</button>)}
        </nav>
        <div className="v6k-model-content" ref={content}>
          {pending && <div className="v6k-navigation-prompt" role="alert">
            <div><strong>当前修改尚未保存</strong><p>{pending.kind === 'close' ? '关闭后，这些修改会丢失。' : '切换后，这些修改会丢失。可以继续编辑并保存。'}</p></div>
            <div><button type="button" className={button} onClick={() => setPending(null)}>继续编辑</button>
              <button type="button" className={button} onClick={() => applyNavigation(pending)}>
                {pending.kind === 'close' ? '放弃修改并关闭' : '放弃修改并切换'}</button></div>
          </div>}
          {selected?.reason && <p className="v6k-message" role="status">{selected.reason}</p>}
          {error && <p className="v6k-message is-error" role="alert">{error}</p>}
          {notice && <p className="v6k-message is-success" role="status">{notice}</p>}
          {tab === '参数与媒体' && <fieldset disabled={disabled} className="v6k-model-form">
            {!selected && <ol className="v6k-add-guide" aria-label="添加模型步骤">
              <li><b>1</b>填写模型信息</li><li><b>2</b>设置规格与素材</li><li><b>3</b>校验授权并添加</li>
            </ol>}
            <section className="v6k-section" aria-labelledby="v6k-model-identity">
              <div className="v6k-section-heading"><h4 id="v6k-model-identity">模型信息</h4></div>
              <div className="v6k-identity-grid">
                <label className="v6k-api-id"><span>本站 API 模型 ID</span><input ref={modelIdInput} className={field} value={draft.modelId}
                  readOnly={Boolean(selected)} placeholder="例如 seedance-720"
                  onChange={event => update({ modelId: event.target.value })} /></label>
                <p className="v6k-field-help">{selected ? '本站 API 调用仍使用这个 ID，编辑时保持不变。' : '供用户调用；使用英文、数字或 . _ / -，添加后保持不变。'}</p>
                <label><span>显示名称</span><input className={field} value={draft.displayName} placeholder="填写前台展示名称"
                  onChange={event => update({ displayName: event.target.value })} /></label>
                <label><span>上游模型 ID</span><input className={field} value={draft.upstreamModel} placeholder="粘贴上游复制的完整 ID"
                  onChange={event => update({ upstreamModel: event.target.value })} /></label>
              </div>
            </section>
            <section className="v6k-section" aria-labelledby="v6k-standard-parameters">
              <div className="v6k-section-heading"><h4 id="v6k-standard-parameters">规格参数</h4><p>按上游支持范围填写。</p></div>
              <div className="v6k-duration-toolbar">
                <label>时长规则<select className={field} value={limits.duration.mode}
                  onChange={event => changeDuration({ mode: event.target.value as DurationRule['mode'] })}>
                  <option value="range">连续范围</option><option value="options">指定秒数</option><option value="fixed">固定时长</option>
                </select></label>
                {limits.duration.mode === 'options' ? <label className="v6k-duration-options">可选时长<input className={field}
                  value={seconds} placeholder="例如 5,10,15" onChange={event => { setSeconds(event.target.value); setPreview(null); setNotice(''); }} /></label>
                  : <div className="v6k-duration-range">
                    {(['min', 'max', 'step'] as const).filter(key => limits.duration.mode === 'range' || key === 'min').map(key =>
                      <label key={key}>{({ min: limits.duration.mode === 'fixed' ? '固定秒数' : '最短', max: '最长', step: '步长' })[key]}
                        <input className={field} type="number" min="1" value={limits.duration[key] || ''}
                          onChange={event => changeDuration({ [key]: Number(event.target.value) })} />
                      </label>)}
                  </div>}
              </div>
              <div className="v6k-spec-grid">
                <label>可选分辨率<input className={field} value={resolutions} placeholder="例如 720p"
                  onChange={event => { setResolutions(event.target.value); setPreview(null); setNotice(''); }} /></label>
                <label>可选比例<input className={field} value={ratios} placeholder="例如 16:9,9:16"
                  onChange={event => { setRatios(event.target.value); setPreview(null); setNotice(''); }} /></label>
                <label>默认时长<input className={field} type="number" min="1" placeholder="留空取首个选项"
                  value={limits.defaultSeconds ?? ''} onChange={event => changeLimits({ defaultSeconds: event.target.value ? Number(event.target.value) : undefined })} /></label>
              </div>
              <p className="v6k-field-help">多个分辨率或比例用逗号分隔；每次生成 1 条视频。</p>
            </section>
            <section className="v6k-section" aria-labelledby="v6k-media-limits">
              <div className="v6k-section-heading"><h4 id="v6k-media-limits">素材限制</h4><p>上限为 0 表示不支持。</p></div>
              <div className="v6k-media-grid">
                {([['maxImages', '最多参考图'], ['maxVideos', '最多参考视频'], ['maxAudios', '最多参考音频']] as const).map(([key, label]) =>
                  <label key={key}>{label}<input className={field} type="number" min="0" value={limits[key]}
                    onChange={event => changeLimits({ [key]: Number(event.target.value) })} /></label>)}
              </div>
              <details className="v6k-extra-limits"><summary>更多素材限制</summary><div className="v6k-spec-grid">
                <label>最少参考图<input className={field} type="number" min="0" value={limits.minImages}
                  onChange={event => changeLimits({ minImages: Number(event.target.value) })} /></label>
                <label>素材合计上限<input className={field} type="number" min="0" value={limits.maxReferences ?? ''} placeholder="按各类型上限"
                  onChange={event => changeLimits({ maxReferences: event.target.value ? Number(event.target.value) : undefined })} /></label>
              </div></details>
            </section>
            <div className="v6k-model-switches">
              <label><input type="checkbox" checked={draft.enabled}
                onChange={event => update({ enabled: event.target.checked })} />启用规格</label>
              <label><input type="checkbox" checked={draft.routeEnabled}
                onChange={event => update({ routeEnabled: event.target.checked })} />启用线路</label>
              <span>售价和模型总开关在关联模型列表设置。</span>
            </div>
          </fieldset>}
          {tab === '请求体样例' && <div className="v6k-preview-layout">
            <section className="v6k-section">
              <div className="v6k-section-heading"><h4>预览设置</h4><p>使用当前未保存配置，只构造请求体。</p></div>
              <fieldset disabled={disabled} className="v6k-sample-grid">
                {([['images', '示例图片数量'], ['videos', '示例视频数量'], ['audios', '示例音频数量']] as const).map(([key, label]) =>
                  <label key={key}>{label}<input className={field} type="number" min="0" value={sample[key] ?? (key === 'images' ? limits.minImages : 0)}
                    onChange={event => { setSample(value => ({ ...value, [key]: Number(event.target.value) })); setPreview(null); }} /></label>)}
              </fieldset>
              <button type="button" className={button} disabled={disabled} onClick={() => void generatePreview()}>预览实际请求体</button>
            </section>
            {preview ? <section className="v6k-code-panel"><div className="v6k-code-heading"><span>{preview.method}</span><code>{preview.path}</code></div>
              <pre>{JSON.stringify(preview.body, null, 2)}</pre></section>
              : <div className="v6k-preview-empty"><strong>请求体预览</strong><p>填写模型信息和规格后，点击上方按钮查看实际提交字段。</p></div>}
          </div>}
          {tab === '线路配置 JSON' && <section className="v6k-code-panel"><div className="v6k-code-heading"><span>JSON</span><code>当前线路配置</code></div>
            <pre>{JSON.stringify({ channelId, protocol: 'zongheng-v6k', ...config() }, null, 2)}</pre></section>}
        </div>
        <footer className="v6k-model-footer">
          <p>{selected ? '保存后，新提交使用此配置。' : '添加后先保持停用，再到关联模型列表设置售价并启用。'}</p>
          <button type="button" className={button + ' v6k-button-primary'} disabled={disabled} onClick={() => void save()}>
            {busy ? '正在处理…' : selected ? '校验授权并保存修改' : '校验授权并添加模型'}
          </button>
        </footer>
      </div>
    </div>
  </AdminDrawer>;
}
