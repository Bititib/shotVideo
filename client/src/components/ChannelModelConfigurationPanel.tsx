import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { channelVideoProtocols, type ChannelModelCatalogEntry, type ChannelModelConfiguration, type ChannelModelConfigurations,
  type ChannelModelDraft, type ChannelModelRequestPreview } from '../../../shared/channelModelConfiguration';
import type { V6kRequestSample } from '../../../shared/v6kModelConfiguration';
import { defaultRoutingLimits, type DurationRule, type MediaKind } from '../../../shared/modelRouting';
import { adminApi } from '../api/admin';
import AdminDrawer from './AdminDrawer';
import './V6kModelConfigurationPanel.css';

const field = 'v6k-field';
const button = 'v6k-button';
const tabs = ['参数与媒体', '请求体样例', '线路配置 JSON'] as const;
const kindLabels: Record<string, string> = {
  video: '视频', image: '图片', image_gen: '图片', music: '音乐', text: '文本', tts: '语音',
};
const blank = (): ChannelModelDraft => ({
  modelId: '', displayName: '', upstreamModel: '', kind: 'video',
  limits: { ...defaultRoutingLimits(), resolutions: [], ratios: [] },
});
const split = (text: string) => [...new Set(text.split(/[,，]/).map(value => value.trim()).filter(Boolean))];
const durationText = (rule: DurationRule) => rule.mode === 'options' ? rule.values.join('、')
  : rule.min === rule.max ? String(rule.min) : `${rule.min}–${rule.max}，步长 ${rule.step}`;

function draftWithFields(draft: ChannelModelDraft, resolutions: string, ratios: string, seconds: string): ChannelModelDraft {
  const rule = draft.limits.duration, values = split(seconds).map(Number);
  const duration = rule.mode === 'options' && values.length
    ? { ...rule, min: Math.min(...values), max: Math.max(...values), step: 1, values }
    : { ...rule, max: rule.mode === 'fixed' ? rule.min : rule.max, values: [] };
  return { ...draft, modelId: draft.modelId.trim(), displayName: draft.displayName.trim(), upstreamModel: draft.upstreamModel.trim(),
    limits: { ...draft.limits, resolutions: split(resolutions), ratios: split(ratios), duration } };
}

export default function ChannelModelConfigurationPanel({ channelId, channelName, onClose, onSaved, onManage }: {
  channelId: number; channelName: string; onClose: () => void; onSaved: () => void; onManage: () => void;
}) {
  const [data, setData] = useState<ChannelModelConfigurations | null>(null);
  const [selected, setSelected] = useState<ChannelModelConfiguration | null>(null);
  const [draft, setDraft] = useState<ChannelModelDraft | null>(null);
  const [catalog, setCatalog] = useState<ChannelModelCatalogEntry[] | null>(null);
  const [resolutions, setResolutions] = useState('');
  const [ratios, setRatios] = useState('');
  const [seconds, setSeconds] = useState('');
  const [tab, setTab] = useState<typeof tabs[number]>('参数与媒体');
  const [sample, setSample] = useState<V6kRequestSample>({});
  const [preview, setPreview] = useState<ChannelModelRequestPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [reload, setReload] = useState(0);
  const [baseline, setBaseline] = useState('');
  const [nextSelection, setNextSelection] = useState<ChannelModelConfiguration | 'new' | 'close' | null>(null);

  const select = useCallback((next: ChannelModelConfiguration | 'new' | null) => {
    const value = next === 'new' ? blank() : next?.editable && next.limits
      ? { modelId: next.modelId, displayName: next.displayName, upstreamModel: next.upstreamModel,
        kind: next.capabilities.includes('video') ? 'video' as const : 'image' as const, limits: next.limits,
        specificationEnabled: next.specificationEnabled, routeEnabled: next.routeEnabled }
      : null;
    setSelected(next === 'new' ? null : next);
    setDraft(value);
    setResolutions(value?.limits.resolutions.join(',') ?? '');
    setRatios(value?.limits.ratios.join(',') ?? '');
    setSeconds(value?.limits.duration.values.join(',') ?? '');
    setTab('参数与媒体');
    setSample({});
    setPreview(null);
    setBaseline(JSON.stringify(value && draftWithFields(value, value.limits.resolutions.join(','), value.limits.ratios.join(','), value.limits.duration.values.join(','))));
  }, []);

  useEffect(() => {
    let active = true;
    adminApi.getChannelModelConfigurations(channelId).then(result => {
      if (active) { setData(result); select(result.models.find(model => model.editable) ?? result.models[0] ?? null); }
    }).catch((err: Error) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [channelId, reload, select]);

  const currentValues = draft && draftWithFields(draft, resolutions, ratios, seconds);
  const serialized = JSON.stringify(currentValues);
  const dirty = currentValues && serialized !== baseline;
  useEffect(() => { setPreview(null); }, [serialized]);
  const matching = data?.models.filter(model => [model.modelId, model.displayName, model.upstreamModel]
    .some(value => value.toLowerCase().includes(search.trim().toLowerCase()))) ?? [];

  function choose(next: ChannelModelConfiguration | 'new' | 'close') {
    if (next === 'close') { onClose(); return; }
    select(next);
    setNextSelection(null);
    setError('');
    setNotice('');
  }

  function navigate(next: ChannelModelConfiguration | 'new' | 'close') {
    if (busy || (typeof next !== 'string' && next.modelId === selected?.modelId)) return;
    if (dirty) setNextSelection(next);
    else choose(next);
  }

  async function loadCatalog() {
    setBusy(true);
    setError('');
    try { setCatalog(await adminApi.getAuthorizedChannelModels(channelId)); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function showPreview() {
    if (!currentValues) return;
    setBusy(true);
    setError('');
    setPreview(null);
    try { setPreview(await adminApi.previewChannelModelRequest(channelId, currentValues, sample)); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function sync() {
    setBusy(true);
    setNotice('');
    setError('');
    try {
      const result = await adminApi.syncChannelModels(channelId);
      onSaved();
      setNotice([`已同步 ${result.count} 个，新增 ${result.added} 个。`, ...(result.warnings || [])].join(' '));
      try {
        const refreshed = await adminApi.getChannelModelConfigurations(channelId);
        setData(refreshed);
        select(refreshed.models.find(model => model.modelId === selected?.modelId) ?? refreshed.models[0] ?? null);
      } catch (err) { setError('同步已完成。刷新模型列表失败：' + (err as Error).message); }
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!currentValues || !data || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await adminApi.saveChannelModelConfiguration(channelId, currentValues, data.version);
      setData(result);
      const saved = result.models.find(model => model.modelId === currentValues.modelId.trim());
      if (saved) choose(saved);
      setNotice(selected ? '模型配置已保存。' : '新模型已添加，默认停用。可以到关联模型中设置售价并启用。');
      onSaved();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  const setLimits = (changes: Partial<ChannelModelDraft['limits']>) => {
    setDraft(value => value && { ...value, limits: { ...value.limits, ...changes } });
  };
  const limits = draft?.limits ?? selected?.limits;
  const duration = limits?.duration;
  const protocol = data?.protocol ? channelVideoProtocols[data.protocol] : null;
  const asyncVideo = data?.protocol === 'async-video';
  const chooseFromCatalog = asyncVideo || data?.protocol === 'megaby';
  const availableModels = catalog?.filter(entry => !data?.models.some(row => row.modelId !== selected?.modelId && row.upstreamModel === entry.id));

  return <AdminDrawer modal panelClassName="v6k-model-dialog" title={channelName + ' · 模型与参数'}
    blocked={busy} onClose={() => navigate('close')}>
    <div className="v6k-workspace">
      <aside className="v6k-model-sidebar" aria-label="渠道模型">
        {data?.canAdd && <button type="button" className={button + ' v6k-button-primary v6k-add-model'} disabled={busy}
          onClick={() => navigate('new')}>添加新模型</button>}
        <div className="v6k-sidebar-heading"><h3>渠道模型</h3>{data && <span>{data.models.length} 个</span>}</div>
        <input className={field} aria-label="搜索渠道模型" placeholder="搜索名称或模型 ID" value={search}
          onChange={event => setSearch(event.target.value)} />
        <label className="v6k-mobile-picker">切换模型
          <select className={field} value={selected?.modelId ?? ''} disabled={busy}
            onChange={event => {
              const found = data?.models.find(model => model.modelId === event.target.value);
              if (found) navigate(found);
            }}>
            <option value="" disabled>选择模型</option>
            {data?.models.map(model => <option key={model.modelId} value={model.modelId}>{model.displayName}</option>)}
          </select>
        </label>
        <div className="v6k-model-list">
          {data && !matching.length && <p className="v6k-sidebar-empty">{data.models.length ? '没有匹配的模型' : '暂无已配置的型号'}</p>}
          {matching.map(model => <button type="button" key={model.modelId} className="v6k-model-list-item" disabled={busy}
            onClick={() => navigate(model)} aria-current={selected?.modelId === model.modelId ? 'true' : undefined}>
            <strong>{model.displayName}</strong><code>{model.modelId}</code><span className="v6k-route-label">上游：{model.upstreamModel}</span>
            <span className={`v6k-model-badge${model.enabled ? ' is-enabled' : ''}`}>{model.enabled ? '已启用' : '已停用'}</span>
          </button>)}
        </div>
      </aside>
      <div className="v6k-editor">
        <header className="v6k-editor-heading"><h3>{selected?.displayName ?? (draft ? '添加新模型' : '渠道模型')}</h3>
          {dirty && <span className="v6k-unsaved">有未保存的修改</span>}
        </header>
        {draft && <nav aria-label="模型配置内容" className="v6k-model-tabs">
          {tabs.map(item => <button type="button" key={item} disabled={busy} aria-pressed={tab === item} onClick={() => setTab(item)}>{item}</button>)}
        </nav>}
        <div className="v6k-model-content">
          {nextSelection && <div className="v6k-navigation-prompt" role="alert">
            <strong>当前修改尚未保存</strong>
            <div><button type="button" className={button} onClick={() => setNextSelection(null)}>继续编辑</button>
              <button type="button" className={button} onClick={() => choose(nextSelection)}>放弃修改</button></div>
          </div>}
          {!data && !error && <p role="status">正在加载模型配置…</p>}
          {error && <p className="v6k-message is-error" role="alert">{error}{!data && <>
            {' '}<button type="button" onClick={() => { setError(''); setReload(value => value + 1); }}>重试</button>
          </>}</p>}
          {notice && <p className="v6k-message is-success" role="status">{notice}</p>}
          {data?.addUnavailableReason && <p className="v6k-message">{data.addUnavailableReason}</p>}
          {draft ? <form id="channel-model-form" className="v6k-model-form" style={tab === '参数与媒体' ? undefined : { display: 'none' }} onSubmit={event => void save(event)}>
            <fieldset disabled={busy} className="v6k-model-form">
              <div className="v6k-identity-grid">
                <label>本站 API 模型 ID<input className={field} value={draft.modelId} required readOnly={Boolean(selected)}
                  onChange={event => setDraft({ ...draft, modelId: event.target.value })} /></label>
                <label>显示名称<input className={field} value={draft.displayName} required
                  onChange={event => setDraft({ ...draft, displayName: event.target.value })} /></label>
                <label>上游模型 ID{chooseFromCatalog ? <select className={field} value={draft.upstreamModel} required
                  onChange={event => {
                    const entry = availableModels?.find(model => model.id === event.target.value);
                    if (!entry?.limits) return;
                    setDraft({ ...draft, upstreamModel: entry.id, limits: entry.limits });
                    setResolutions(entry.limits.resolutions.join(','));
                    setRatios(entry.limits.ratios.join(','));
                    setSeconds(entry.limits.duration.values.join(','));
                  }}>
                  <option value="" disabled>读取授权目录后选择</option>
                  {selected?.upstreamModel && !availableModels?.some(entry => entry.id === selected.upstreamModel) &&
                    <option value={selected.upstreamModel}>{selected.upstreamModel}</option>}
                  {availableModels?.map(entry => <option key={entry.id} value={entry.id}>{entry.id}</option>)}
                </select> : <input className={field} value={draft.upstreamModel} required list={catalog ? 'channel-model-catalog' : undefined}
                  onChange={event => setDraft({ ...draft, upstreamModel: event.target.value })} />}</label>
                {protocol ? <label>接入协议<input className={field} value={protocol.label} readOnly /></label> : <label>生成类型<select className={field} value={draft.kind} disabled={Boolean(selected)}
                  onChange={event => {
                    setDraft({ ...draft, kind: event.target.value as MediaKind });
                    setResolutions(event.target.value === 'image' ? '1K' : '');
                  }}><option value="video">视频</option><option value="image">图片</option></select></label>}
              </div>
              <div>
                <button type="button" className={button} onClick={() => void loadCatalog()}>读取已授权的上游型号</button>
                {catalog && <>
                  {!chooseFromCatalog && <datalist id="channel-model-catalog">{availableModels?.map(({ id }) => <option key={id} value={id} />)}</datalist>}
                  <p className="v6k-field-help" role="status">{availableModels?.length
                    ? `可选 ${availableModels.length} 个型号。请确认所选型号支持当前生成协议。` : '授权目录里暂无可添加的型号。'}</p>
                </>}
              </div>
              <section className="v6k-section">
                <div className="v6k-section-heading"><h4>规格与素材</h4>
                  {asyncVideo && <p>画幅与时长可从授权目录给出的选项中选择，分辨率由上游决定。</p>}</div>
                <div className="v6k-spec-grid">
                  {!asyncVideo && <label>{draft.kind === 'image' ? '固定分辨率' : '可选分辨率'}<input className={field} value={resolutions} required
                    readOnly={draft.kind === 'image'} placeholder={draft.kind === 'image' ? '1K' : '例如 720p,1080p'}
                    onChange={event => setResolutions(event.target.value)} /></label>}
                  <label>可选比例<input className={field} value={ratios} placeholder="例如 16:9,9:16" required onChange={event => setRatios(event.target.value)} /></label>
                  <label>最多参考图<input className={field} type="number" min="0" value={draft.limits.maxImages}
                    onChange={event => setLimits({ maxImages: Number(event.target.value) })} /></label>
                  <label>最少参考图<input className={field} type="number" min="0" max={draft.limits.maxImages} value={draft.limits.minImages}
                    onChange={event => setLimits({ minImages: Number(event.target.value) })} /></label>
                  {protocol?.multimedia && <>
                    <label>最多参考视频<input className={field} type="number" min="0" max="100" value={draft.limits.maxVideos}
                      onChange={event => setLimits({ maxVideos: Number(event.target.value) })} /></label>
                    <label>最多参考音频<input className={field} type="number" min="0" max="100" value={draft.limits.maxAudios}
                      onChange={event => setLimits({ maxAudios: Number(event.target.value) })} /></label>
                    <label>参考素材合计上限<input className={field} type="number" min="0" max="300" value={draft.limits.maxReferences ?? ''}
                      onChange={event => setLimits({ maxReferences: event.target.value ? Number(event.target.value) : undefined })} /></label>
                  </>}
                  {draft.kind === 'image' && <label>最多输出图片<input className={field} type="number" min="1" max="4" value={draft.limits.maxOutputs}
                    onChange={event => setLimits({ maxOutputs: Number(event.target.value) })} /></label>}
                </div>
                {draft.kind === 'video' && <div className="v6k-duration-toolbar">
                  <label>时长规则<select className={field} value={draft.limits.duration.mode}
                    onChange={event => setLimits({ duration: { ...draft.limits.duration, mode: event.target.value as DurationRule['mode'] } })}>
                    <option value="range">连续范围</option><option value="options">指定秒数</option><option value="fixed">固定时长</option>
                  </select></label>
                  {draft.limits.duration.mode === 'options' ? <label>可选时长<input className={field} required value={seconds}
                    placeholder="例如 5,10,15" onChange={event => setSeconds(event.target.value)} /></label>
                    : <div className="v6k-duration-range">
                      {(draft.limits.duration.mode === 'fixed' ? ['min'] as const : ['min', 'max', 'step'] as const).map(key =>
                        <label key={key}>{draft.limits.duration.mode === 'fixed' ? '固定秒数' : ({ min: '最短秒数', max: '最长秒数', step: '秒数步长' })[key]}
                          <input className={field} type="number" min="1" required value={draft.limits.duration[key] || ''}
                            onChange={event => setLimits({ duration: { ...draft.limits.duration, [key]: Number(event.target.value) } })} />
                        </label>)}
                    </div>}
                </div>}
              </section>
              <div className="v6k-model-switches">
                <label><input type="checkbox" checked={draft.specificationEnabled ?? true}
                  onChange={event => setDraft({ ...draft, specificationEnabled: event.target.checked })} />启用规格</label>
                <label><input type="checkbox" checked={draft.routeEnabled ?? true}
                  onChange={event => setDraft({ ...draft, routeEnabled: event.target.checked })} />启用线路</label>
              </div>
            </fieldset>
          </form> : selected ? <dl className="v6k-spec-grid text-sm">
            <div><dt>本站 API 模型 ID</dt><dd className="break-all">{selected.modelId}</dd></div>
            <div><dt>上游模型 ID</dt><dd className="break-all">{selected.upstreamModel}</dd></div>
            <div><dt>生成类型</dt><dd>{selected.capabilities.map(kind => kindLabels[kind] ?? kind).join('、') || '未登记'}</dd></div>
            {limits && <>
              <div><dt>分辨率</dt><dd>{limits.resolutions.join('、')}</dd></div>
              <div><dt>画面比例</dt><dd>{limits.ratios.join('、')}</dd></div>
              {selected.capabilities.includes('video') && duration && <div><dt>时长（秒）</dt><dd>{durationText(duration)}</dd></div>}
              <div><dt>参考素材上限</dt><dd>{limits.maxImages} 图 · {limits.maxVideos} 视频 · {limits.maxAudios} 音频</dd></div>
              {(limits.firstFrame || limits.lastFrame) && <div><dt>独立首尾帧</dt><dd>{[limits.firstFrame && '首帧', limits.lastFrame && '尾帧'].filter(Boolean).join('、')}</dd></div>}
            </>}
            {!limits && <div><dt>规格参数</dt><dd>当前型号没有单独登记的规格</dd></div>}
          </dl> : null}
          {draft && tab === '请求体样例' && <section className="v6k-section">
            <div className="v6k-section-heading"><h4>预览实际请求字段</h4><p>预览使用示例素材链接，无需提交生成任务。</p></div>
            <div className="v6k-sample-grid">
              {draft.kind === 'video' && <label>样例时长<input className={field} type="number" min="1" value={sample.seconds ?? ''}
                onChange={event => { setPreview(null); setSample({ ...sample, seconds: event.target.value ? Number(event.target.value) : undefined }); }} /></label>}
              {(['ratio', 'resolution'] as const).map(key => <label key={key}>{key === 'ratio' ? '样例比例' : '样例分辨率'}
                <select className={field} value={sample[key] ?? ''} onChange={event => { setPreview(null); setSample({ ...sample, [key]: event.target.value || undefined }); }}>
                  <option value="">使用规格默认值</option>
                  {split(key === 'ratio' ? ratios : resolutions).map(value => <option key={value}>{value}</option>)}
                </select></label>)}
              {(['images', 'videos', 'audios'] as const).filter(key => key === 'images' || protocol?.multimedia).map(key =>
                <label key={key}>{{ images: '样例图片数', videos: '样例视频数', audios: '样例音频数' }[key]}
                  <input className={field} type="number" min="0" max="100" value={sample[key] ?? ''}
                    onChange={event => { setPreview(null); setSample({ ...sample, [key]: event.target.value ? Number(event.target.value) : undefined }); }} /></label>)}
            </div>
            <button type="button" className={button} disabled={busy} onClick={() => void showPreview()}>生成请求体样例</button>
            {preview && <div className="v6k-code-panel"><div className="v6k-code-heading"><span>{preview.method}</span>{preview.path}</div>
              <pre>{JSON.stringify(preview.body, null, 2)}</pre></div>}
          </section>}
          {draft && tab === '线路配置 JSON' && <div className="v6k-code-panel"><pre>{JSON.stringify({ ...currentValues, channelId,
            specificationEnabled: draft.specificationEnabled ?? true, routeEnabled: draft.routeEnabled ?? true }, null, 2)}</pre></div>}
        </div>
        {data && <footer className="v6k-model-footer">
          {draft && !selected && <p>{asyncVideo ? '新模型默认停用，添加后可设置售价并启用。' : '新模型默认停用。请按上游协议填写规格。'}</p>}
          {(!draft || selected) && <>
            <button type="button" className={button} disabled={busy || Boolean(dirty)} onClick={onManage}>关联模型与价格</button>
            {data.canSync && <button type="button" className={button + (draft ? '' : ' v6k-button-primary')} disabled={busy || Boolean(dirty)} onClick={() => void sync()}>
              {busy ? '正在同步…' : '同步已接入模型'}</button>}
          </>}
          {draft && <button type="submit" form="channel-model-form" className={button + ' v6k-button-primary'} disabled={busy || !dirty || tab !== '参数与媒体'}>
            {busy ? '正在处理…' : selected ? '保存配置' : '校验授权并添加模型'}</button>}
        </footer>}
      </div>
    </div>
  </AdminDrawer>;
}
