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
  const content = useRef<HTMLDivElement>(null);

  useEffect(() => { if (content.current) content.current.scrollTop = 0; }, [tab, selected?.modelId]);

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
  const config = (): V6kModelDraft => {
    const values = split(seconds).map(Number);
    const rule = limits.duration;
    const duration = rule.mode === 'options' && values.length
      ? { ...rule, min: Math.min(...values), max: Math.max(...values), step: 1, values }
      : { ...rule, max: rule.mode === 'fixed' ? rule.min : rule.max, values: [] };
    return { modelId: draft.modelId.trim(), displayName: draft.displayName.trim(), upstreamModel: draft.upstreamModel.trim(),
      enabled: draft.enabled, routeEnabled: draft.routeEnabled,
      limits: { ...limits, duration, resolutions: split(resolutions), ratios: split(ratios) } };
  };
  const disabled = busy || !loaded || selected?.editable === false;

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
      setModels(rows => [...rows.filter(row => row.modelId !== result.modelId), result]);
      choose(result);
      setNotice(selected ? '配置已保存。后续提交使用新配置。' : '模型已保存为停用。请在关联模型列表配置售价并启用。');
      onSaved();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return <AdminDrawer modal panelClassName="v6k-model-dialog" title="纵横 V6K · 模型与参数" blocked={busy} onClose={onClose}>
    <div className="v6k-model-toolbar">
      <div className="v6k-model-picker">
        <label><span>本站模型</span>
          <select className={field} value={selected?.modelId || ''} disabled={busy || !loaded}
            onChange={event => choose(models.find(row => row.modelId === event.target.value) ?? null)}>
            <option value="">添加模型</option>
            {models.map(row => <option key={row.modelId} value={row.modelId}>{row.displayName && row.displayName !== row.modelId ? `${row.displayName} · ${row.modelId}` : row.modelId}</option>)}
          </select>
        </label>
        <button type="button" className={button} disabled={busy || !loaded} onClick={() => choose(null)}>添加模型</button>
      </div>
      <nav aria-label="模型配置内容" className="v6k-model-tabs">
        {tabs.map(item => <button type="button" key={item} disabled={busy} aria-pressed={tab === item}
          onClick={() => setTab(item)}>{item}</button>)}
      </nav>
    </div>
    <div className="v6k-model-content" ref={content}>
      {selected?.reason && <p className="v6k-message" role="status">{selected.reason}</p>}
      {error && <p className="v6k-message is-error" role="alert">{error}</p>}
      {notice && <p className="v6k-message is-success" role="status">{notice}</p>}
      {tab === '参数与媒体' && <fieldset disabled={disabled} className="v6k-model-form">
        <section className="v6k-section" aria-labelledby="v6k-model-identity">
        <div className="v6k-section-heading"><h3 id="v6k-model-identity">模型映射</h3><p>本站 ID 用于 API 调用，上游 ID 对应实际提交型号。</p></div>
        <div className="v6k-identity-grid">
          <label><span>本站 API 模型 ID</span><input className={field} value={draft.modelId}
            readOnly={Boolean(selected)} onChange={e => update({ modelId: e.target.value })} /></label>
          <label><span>显示名称</span><input className={field} value={draft.displayName}
            onChange={e => update({ displayName: e.target.value })} /></label>
          <label><span>上游模型 ID</span><input className={field} value={draft.upstreamModel}
            onChange={e => update({ upstreamModel: e.target.value })} /></label>
        </div>
        <div className="v6k-model-switches">
          <label className="flex items-center gap-2"><input type="checkbox" checked={draft.enabled}
            onChange={e => update({ enabled: e.target.checked })} />启用规格</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={draft.routeEnabled}
            onChange={e => update({ routeEnabled: e.target.checked })} />启用线路</label>
          <span>模型总开关与售价在关联模型列表设置。</span>
        </div>
        </section>
        <section className="v6k-section" aria-labelledby="v6k-standard-parameters">
          <div className="v6k-section-heading"><h3 id="v6k-standard-parameters">标准参数</h3><p>设置可选规格；多个选项用逗号分隔。</p></div>
        <div className="v6k-table-scroll" role="region" aria-label="标准参数表格" tabIndex={0}>
          <table className="v6k-parameter-table">
            <caption className="sr-only">标准参数</caption>
            <colgroup><col /><col /><col /><col /><col /></colgroup>
            <thead><tr>{['标准参数', '映射字段', '值类型', '可选值', '默认值'].map(label =>
              <th key={label} scope="col" className="px-3 py-2">{label}</th>)}</tr></thead>
            <tbody className="divide-y">
              <tr>
                <th scope="row" className="px-3 py-2">时长</th><td className="px-3">seconds</td><td className="px-3">整数</td>
                <td className="space-y-2 px-3 py-2">
                  <select aria-label="时长规则" className={field} value={limits.duration.mode}
                    onChange={e => changeDuration({ mode: e.target.value as DurationRule['mode'] })}>
                    <option value="range">范围</option><option value="options">指定选项</option><option value="fixed">固定时长</option>
                  </select>
                  {limits.duration.mode === 'options' ? <input aria-label="可选时长" className={field} value={seconds} placeholder="5,10,15"
                    onChange={e => { setSeconds(e.target.value); setPreview(null); }} />
                    : <div className="v6k-duration-range">
                      {(['min', 'max', 'step'] as const).filter(key => limits.duration.mode === 'range' || key === 'min').map(key =>
                        <label key={key}>{({ min: '最短', max: '最长', step: '步长' })[key]}
                          <input className={field} type="number" min="1" value={limits.duration[key] || ''}
                            onChange={e => changeDuration({ [key]: Number(e.target.value) })} />
                        </label>)}
                    </div>}
                </td>
                <td className="px-3"><input aria-label="默认时长" className={field} type="number" min="1"
                  placeholder="首个选项" value={limits.defaultSeconds ?? ''}
                  onChange={e => changeLimits({ defaultSeconds: e.target.value ? Number(e.target.value) : undefined })} /></td>
              </tr>
              <tr><th scope="row" className="px-3 py-2">分辨率</th><td className="px-3">resolution</td><td className="px-3">文本</td>
                <td className="px-3 py-2"><input aria-label="可选分辨率" className={field} value={resolutions}
                  onChange={e => { setResolutions(e.target.value); setPreview(null); }} /></td><td className="px-3">首个选项</td></tr>
              <tr><th scope="row" className="px-3 py-2">比例</th><td className="px-3">ratio</td><td className="px-3">文本</td>
                <td className="px-3 py-2"><input aria-label="可选比例" className={field} value={ratios}
                  onChange={e => { setRatios(e.target.value); setPreview(null); }} /></td><td className="px-3">首个选项</td></tr>
              <tr><th scope="row" className="px-3 py-2">生成数量</th><td className="px-3">协议固定</td><td className="px-3">整数</td>
                <td className="px-3">1</td><td className="px-3">1</td></tr>
            </tbody>
          </table>
        </div>
        <p className="v6k-table-hint">左右滑动可查看和编辑完整参数。</p>
        </section>
        <fieldset className="v6k-section v6k-media-section"><legend>参考媒体</legend>
          <p className="v6k-section-help">上限设为 0 即不支持该类素材。</p>
          <div className="v6k-media-grid">
          {([['minImages', '最少参考图'], ['maxImages', '最多参考图 · images'], ['maxVideos', '最多参考视频 · videos'],
            ['maxAudios', '最多参考音频 · audios'], ['maxReferences', '素材合计上限']] as const).map(([key, label]) =>
            <label key={key}>{label}
              <input className={field} type="number" min="0" value={limits[key] ?? ''} placeholder={key === 'maxReferences' ? '按各类型上限' : '0'}
                onChange={e => changeLimits({ [key]: key === 'maxReferences' && !e.target.value ? undefined : Number(e.target.value) })} />
            </label>)}
          </div>
        </fieldset>
      </fieldset>}
      {tab === '请求体样例' && <div className="v6k-preview-layout">
        <section className="v6k-section">
        <div className="v6k-section-heading"><h3>示例素材</h3><p>按当前草稿和默认规格构造请求，素材使用示例地址。</p></div>
        <fieldset disabled={disabled} className="v6k-sample-grid">
          {([['images', '示例图片数量'], ['videos', '示例视频数量'], ['audios', '示例音频数量']] as const).map(([key, label]) =>
            <label key={key}>{label}
              <input className={field} type="number" min="0" value={sample[key] ?? (key === 'images' ? limits.minImages : 0)}
                onChange={e => { setSample(value => ({ ...value, [key]: Number(e.target.value) })); setPreview(null); }} />
            </label>)}
        </fieldset>
        <button type="button" className={button} disabled={disabled} onClick={() => void generatePreview()}>预览实际请求体</button>
        </section>
        {preview ? <section className="v6k-code-panel"><div className="v6k-code-heading"><span>{preview.method}</span><code>{preview.path}</code></div>
          <pre>{JSON.stringify(preview.body, null, 2)}</pre></section>
          : <div className="v6k-preview-empty"><span aria-hidden="true">{'{ }'}</span><strong>请求体预览</strong><p>选择示例素材数量，点击预览查看实际提交字段。</p></div>}
      </div>}
      {tab === '线路配置 JSON' && <section className="v6k-code-panel"><div className="v6k-code-heading"><span>JSON</span><code>当前线路配置</code></div><pre>
        {JSON.stringify({ channelId, protocol: 'zongheng-v6k', ...config() }, null, 2)}
      </pre></section>}
    </div>
      <footer className="v6k-model-footer">
        <p>保存前会核对渠道 Key 的模型授权。<br />现有售价和已提交任务沿用原记录。</p>
        <button type="button" className={button + ' v6k-button-primary'} disabled={disabled} onClick={() => void save()}>
          {busy ? '正在处理…' : '校验授权并保存'}
        </button>
      </footer>
  </AdminDrawer>;
}
