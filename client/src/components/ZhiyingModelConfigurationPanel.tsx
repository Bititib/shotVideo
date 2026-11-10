import { useEffect, useState } from 'react';
import { defaultRoutingLimits } from '../../../shared/modelRouting';
import { zhiyingVideoDisplayName } from '../../../shared/zhiyingVideo';
import type { ZhiyingCatalogOption, ZhiyingModelConfiguration, ZhiyingModelDraft } from '../../../shared/zhiyingModelConfiguration';
import { adminApi } from '../api/admin';
import AdminDrawer from './AdminDrawer';
import './V6kModelConfigurationPanel.css';

const blank = (): ZhiyingModelDraft => ({ modelId: '', upstreamModel: '', enabled: true, routeEnabled: true, limits: defaultRoutingLimits() });
export default function ZhiyingModelConfigurationPanel({ channelId, onClose, onSaved }: {
  channelId: number; onClose: () => void; onSaved: () => void;
}) {
  const [rows, setRows] = useState<ZhiyingModelConfiguration[]>([]);
  const [options, setOptions] = useState<ZhiyingCatalogOption[]>([]);
  const [selected, setSelected] = useState<ZhiyingModelConfiguration | null>(null);
  const [draft, setDraft] = useState(blank);
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<object | null>(null);
  const [baseline, setBaseline] = useState(JSON.stringify(blank()));
  const [pending, setPending] = useState<{ close?: boolean; row?: ZhiyingModelConfiguration } | null>(null);
  useEffect(() => {
    let active = true;
    Promise.all([adminApi.getZhiyingModelConfigurations(channelId), adminApi.getZhiyingModelCatalog(channelId)])
      .then(([models, catalog]) => { if (active) { setRows(models); setOptions(catalog.options); setNotice(catalog.warnings.join('；')); setLoaded(true); } })
      .catch(err => { if (active) setError(err.message); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [channelId]);
  function choose(row: ZhiyingModelConfiguration | null) {
    const value = row ?? blank();
    setSelected(row); setDraft(value); setBaseline(JSON.stringify(value)); setPreview(null); setNotice(''); setError(''); setPending(null);
  }
  function navigate(next: { close?: boolean; row?: ZhiyingModelConfiguration }) {
    if (busy) return;
    if (JSON.stringify(draft) !== baseline) { setPending(next); return; }
    next.close ? onClose() : choose(next.row ?? null);
  }
  function update(changes: Partial<ZhiyingModelDraft>) { setDraft(d => ({ ...d, ...changes })); setPreview(null); setNotice(''); }
  async function act(save: boolean) {
    setBusy(true); setError(''); setPreview(null);
    try {
      if (save) {
        const saved = await adminApi.saveZhiyingModel(channelId, draft, selected?.version ?? null);
        let refreshed: ZhiyingModelConfiguration[] | undefined;
        try { refreshed = await adminApi.getZhiyingModelConfigurations(channelId); } catch { /* Keep the successful save visible. */ }
        setRows(old => [...(refreshed ?? old).filter(row => row.modelId !== saved.modelId), saved]); choose(saved);
        setNotice(selected ? '配置已保存。后续任务使用新配置。' : '模型已添加，默认停用。请到关联模型列表设置本站售价并启用。');
        onSaved();
      } else setPreview(await adminApi.previewZhiyingModel(channelId, draft));
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  const limits = draft.limits;
  const changeLimits = (changes: Partial<typeof limits>) => update({ limits: { ...limits, ...changes } });
  const disabled = busy || !loaded || selected?.editable === false;
  const profile = options.find(row => row.id === draft.upstreamModel)?.profile;
  return <AdminDrawer modal panelClassName="v6k-model-dialog" title="智赢 · 模型与参数" blocked={busy} onClose={() => navigate({ close: true })}>
    <div className="v6k-workspace">
      <aside className="v6k-model-sidebar" aria-label="模型选择">
        <button className="v6k-button v6k-button-primary" disabled={busy || !loaded} onClick={() => navigate({})}>添加新模型</button>
        <div className="v6k-sidebar-heading"><h3>已有模型</h3><span>{rows.length} 个</span></div>
        <div className="v6k-model-list">{rows.map(row => <button key={row.modelId} className="v6k-model-list-item" disabled={busy}
          aria-current={selected?.modelId === row.modelId} onClick={() => navigate({ row })}>
          <strong>{zhiyingVideoDisplayName(row.modelId) || row.modelId}</strong><small>{row.upstreamModel}</small>
        </button>)}</div>
      </aside>
      <div className="min-w-0 overflow-y-auto p-6 space-y-5">
        <p className="text-sm">选择当前 Key 可用的上游型号，再设置本站名称。前端和本站 API 使用相同名称。</p>
        {busy && <p role="status">正在校验模型配置…</p>}
        {error && <p role="alert" className="text-red-700">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {pending && <div role="alertdialog" aria-label="未保存的修改" className="space-x-3">
          <p>当前修改尚未保存，是否放弃？</p><button className="v6k-button" onClick={() => setPending(null)}>继续编辑</button>
          <button className="v6k-button" onClick={() => pending.close ? onClose() : choose(pending.row ?? null)}>放弃修改</button>
        </div>}
        {selected?.reason && <p>{selected.reason}</p>}
        <fieldset disabled={disabled} className="space-y-5">
          <label className="block">本站名称 / API 模型 ID<input className="v6k-field mt-2 w-full" value={zhiyingVideoDisplayName(draft.modelId) || draft.modelId}
            disabled={Boolean(selected)} placeholder="Lx-Seedance2.5-3" onChange={e => update({ modelId: e.target.value })} /></label>
          <label className="block">智赢上游型号<select className="v6k-field mt-2 w-full" value={draft.upstreamModel} onChange={e => {
            const option = options.find(row => row.id === e.target.value);
            update({ upstreamModel: e.target.value, ...(option?.profile ? { limits: structuredClone(option.profile.limits) } : {}) });
          }}><option value="">请选择上游型号</option>
            {draft.upstreamModel && !options.some(row => row.id === draft.upstreamModel) && <option value={draft.upstreamModel}>{draft.upstreamModel}（当前目录不可用）</option>}
            {options.map(row => <option key={row.id} value={row.id} disabled={!row.profile}>{row.id}{row.reason ? ' · ' + row.reason : ''}</option>)}
          </select></label>
          {profile && <>
            <p className="text-sm">参数来自当前上游目录，可缩小范围。提示词上限 {profile.promptMax} 字符{profile.avDurationMax ? `，参考音视频合计最多 ${profile.avDurationMax} 秒` : ''}。</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <label>清晰度（逗号分隔）<input className="v6k-field w-full" value={limits.resolutions.join(',')} onChange={e => changeLimits({ resolutions: e.target.value.split(',') })} /></label>
              <label>比例（逗号分隔）<input className="v6k-field w-full" value={limits.ratios.join(',')} onChange={e => changeLimits({ ratios: e.target.value.split(',') })} /></label>
              <label>可选秒数（逗号分隔）<input className="v6k-field w-full" value={limits.duration.values.join(',')} onChange={e => {
                const values = e.target.value.split(',').map(Number); changeLimits({ duration: { mode: 'options', min: Math.min(...values), max: Math.max(...values), step: 1, values } });
              }} /></label>
              <label>默认时长<input className="v6k-field w-full" type="number" value={limits.defaultSeconds ?? ''} onChange={e => changeLimits({ defaultSeconds: Number(e.target.value) })} /></label>
              {([['maxImages','图片上限'], ['maxVideos','视频上限'], ['maxAudios','音频上限'], ['maxReferences','素材合计上限']] as const).map(([key,label]) => <label key={key}>{label}<input className="v6k-field w-full" type="number" min="0" value={limits[key] ?? 0} onChange={e => changeLimits({ [key]: Number(e.target.value) })} /></label>)}
            </div>
            <div className="flex gap-6"><label><input type="checkbox" checked={draft.enabled} onChange={e => update({ enabled: e.target.checked })} /> 开放规格</label>
              <label><input type="checkbox" checked={draft.routeEnabled} onChange={e => update({ routeEnabled: e.target.checked })} /> 开放线路</label></div>
          </>}
          <div className="flex gap-3"><button type="button" className="v6k-button" disabled={!profile} onClick={() => void act(false)}>预览上游请求</button>
            <button type="button" className="v6k-button v6k-button-primary" disabled={!profile} onClick={() => void act(true)}>校验并保存</button></div>
        </fieldset>
        {preview && <div><p className="text-sm">以下为本地预览，未提交生成任务。</p><pre className="overflow-auto rounded-lg border p-4 text-xs">{JSON.stringify(preview, null, 2)}</pre></div>}
      </div>
    </div>
  </AdminDrawer>;
}
