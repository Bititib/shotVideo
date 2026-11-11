import { useEffect, useState } from 'react';
import { blankMinikeyModel, type MinikeyModelDraft, type MinikeyModelConfiguration, type MinikeyCatalogOption } from '../../../shared/minikeyModelConfiguration';
import { adminApi } from '../api/admin';
import AdminDrawer from './AdminDrawer';
import './V6kModelConfigurationPanel.css';

export default function MinikeyModelConfigurationPanel({channelId,onClose,onSaved}:{channelId:number;onClose:()=>void;onSaved:()=>void}) {
  const [rows,setRows]=useState<MinikeyModelConfiguration[]>([]), [options,setOptions]=useState<MinikeyCatalogOption[]>([]);
  const [selected,setSelected]=useState<MinikeyModelConfiguration|null>(null),[draft,setDraft]=useState(blankMinikeyModel);
  const [busy,setBusy]=useState(true),[loaded,setLoaded]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [preview,setPreview]=useState<object|null>(null),[baseline,setBaseline]=useState(JSON.stringify(blankMinikeyModel()));
  const [pending,setPending]=useState<{close?:boolean;row?:MinikeyModelConfiguration}|null>(null),[reload,setReload]=useState(0);
  useEffect(()=>{
    let active=true; setBusy(true);setError('');setLoaded(false);
    Promise.all([adminApi.getMinikeyModelConfigurations(channelId),adminApi.getMinikeyModelCatalog(channelId)])
      .then(([saved,catalog])=>{if(active){setRows(saved);setOptions(catalog);setLoaded(true);}})
      .catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setBusy(false);});
    return ()=>{active=false;};
  },[channelId,reload]);
  function choose(row:MinikeyModelConfiguration|null) { const value=row || blankMinikeyModel();setSelected(row);setDraft(value);setBaseline(JSON.stringify(value));setPending(null);setError('');setNotice('');setPreview(null); }
  function navigate(next:{close?:boolean;row?:MinikeyModelConfiguration}) { if(busy)return;if(JSON.stringify(draft)!==baseline){setPending(next);return;}next.close?onClose():choose(next.row || null); }
  function update(value:Partial<MinikeyModelDraft>) {setDraft(d=>({...d,...value}));setPreview(null);setNotice('');}
  const l=draft.limits, option=options.find(o=>o.model===draft.upstreamModel && o.kind===draft.kind);
  const limits=(value:Partial<typeof l>)=>update({limits:{...l,...value}});
  function selectModel(model:string) {
    const o=options.find(o=>o.model===model && o.kind===draft.kind); if(!o)return;
    const duration=o.durations.length?o.durations:[5];
    update({upstreamModel:model,upstreamChannel:null,imageProtocol:model.startsWith('banana')?'banana':'size',limits:{...l,
      maxImages:o.kind==='video'?1:o.maxImages,minImages:o.kind==='video'?1:0,maxVideos:0,maxAudios:0,maxOutputs:o.kind==='image'?4:1,
      resolutions:o.kind==='image'?[o.resolutions[0] || '1K']:[''],ratios:o.kind==='image'?['1:1']:['16:9','9:16'],
      defaultSeconds:duration[0],duration:{mode:'options',min:Math.min(...duration),max:Math.max(...duration),step:1,values:duration}}});
  }
  async function act(save:boolean) {
    setBusy(true);setError('');setPreview(null);
    try {
      if(save) {
        const row=await adminApi.saveMinikeyModel(channelId,draft,selected?.version ?? null);
        setRows(old=>[...old.filter(r=>r.modelId!==row.modelId),row]);choose(row);onSaved();
        setNotice(selected?'配置已保存，原有售价与启用状态已保留。':'模型已添加，默认停用。请在渠道详情的关联模型中设置售价并启用。');
      } else setPreview(await adminApi.previewMinikeyModel(channelId,draft));
    } catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <AdminDrawer modal panelClassName="v6k-model-dialog" title="miniKey · 模型与参数" blocked={busy} onClose={()=>navigate({close:true})}>
    <div className="v6k-workspace">
      <aside className="v6k-model-sidebar" aria-label="模型选择">
        <label className="v6k-mobile-picker">切换模型<select className="v6k-field" value={selected?.modelId || ''} disabled={busy} onChange={e=>navigate({row:rows.find(r=>r.modelId===e.target.value)})}>
          <option value="">新模型</option>{rows.map(r=><option key={r.modelId} value={r.modelId}>{r.modelId}</option>)}</select></label>
        <button className="v6k-button v6k-button-primary v6k-add-model" disabled={busy || !loaded} onClick={()=>navigate({})}>添加新模型</button>
        <div className="v6k-sidebar-heading"><h3>已有配置</h3><span>{rows.length} 个</span></div>
        <div className="v6k-model-list">{rows.map(row=><button key={row.modelId} className="v6k-model-list-item" disabled={busy} aria-current={selected?.modelId===row.modelId} onClick={()=>navigate({row})}>
          <strong>{row.modelId}</strong><small>{row.upstreamModel}{row.kind==='music'?' · 音乐':''}</small></button>)}</div>
      </aside>
      <div className="min-w-0 overflow-y-auto p-6 space-y-5">
        <p className="text-sm">设置本站模型 ID、上游型号和可用规格。新模型默认停用，售价在关联模型中单独设置。</p>
        {busy && <p role="status">正在读取或校验配置…</p>}
        {error && <p role="alert" className="text-red-700">{error}</p>}
        {!loaded && !busy && <button className="v6k-button" onClick={()=>setReload(n=>n+1)}>重新加载</button>}
        {notice && <p role="status">{notice}</p>}
        {pending && <div role="alertdialog" aria-label="未保存的修改"><p>当前修改尚未保存，是否放弃？</p>
          <button className="v6k-button" onClick={()=>setPending(null)}>继续编辑</button>
          <button className="v6k-button" onClick={()=>pending.close?onClose():choose(pending.row || null)}>放弃修改</button></div>}
        {selected?.reason && <p>{selected.reason}</p>}
        <fieldset disabled={busy || !loaded || selected?.editable===false} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label>本站模型 ID<input className="v6k-field w-full" value={draft.modelId} disabled={Boolean(selected)} placeholder="例如 video-pro" onChange={e=>update({modelId:e.target.value})}/></label>
            <label>生成类型<select className="v6k-field w-full" value={draft.kind} disabled={Boolean(selected)} onChange={e=>update({...blankMinikeyModel(),modelId:draft.modelId,kind:e.target.value as MinikeyModelDraft['kind']})}>
              <option value="video">视频</option><option value="image">图片</option><option value="music">音乐</option></select></label>
          </div>
          <label className="block">上游型号<select className="v6k-field w-full" value={draft.upstreamModel} onChange={e=>selectModel(e.target.value)}><option value="">请选择型号</option>
            {draft.upstreamModel && !option && <option value={draft.upstreamModel}>{draft.upstreamModel}（当前目录不可用）</option>}
            {options.filter(o=>o.kind===draft.kind).map(o=><option key={o.model} value={o.model}>{o.name} · {o.model}</option>)}</select></label>
          {draft.kind!=='image' && <label className="block">上游线路<select className="v6k-field w-full" value={draft.upstreamChannel ?? ''} onChange={e=>{
            const line=option?.channels.find(c=>c.id===Number(e.target.value)), seconds=Object.keys(line?.prices || {}).map(Number).filter(n=>n>0 && Number.isInteger(n));
            update({upstreamChannel:e.target.value?Number(e.target.value):null,...(draft.kind==='video' && seconds.length?{limits:{...l,defaultSeconds:seconds[0],duration:{mode:'options',min:Math.min(...seconds),max:Math.max(...seconds),step:1,values:seconds}}}:{})});
          }}><option value="">{draft.kind==='video'?'请选择固定线路':'默认线路'}</option>{option?.channels.map(c=><option key={c.id} value={c.id}>{c.id} · {c.name}</option>)}</select></label>}
          {draft.kind==='music'?<p className="text-sm">音乐按次计费，支持歌曲和纯音乐。保存后请设置售价、启用模型，并在等级配置中开放音乐功能和模型权限。</p>:<>
            {draft.kind==='image' && <label className="block">图片参数格式<select className="v6k-field w-full" value={draft.imageProtocol} onChange={e=>update({imageProtocol:e.target.value as 'banana'|'size'})}><option value="banana">比例与清晰度（Banana 格式）</option><option value="size">像素尺寸与质量（image-2 格式，仅 1K）</option></select></label>}
            <p className="text-sm">按所选线路填写素材上限和清晰度。上游目录中的模型总上限不一定适用于每条线路。</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <label>输出清晰度<input className="v6k-field w-full" value={l.resolutions[0] || ''} onChange={e=>limits({resolutions:[e.target.value]})}/></label>
              <label>画面比例（逗号分隔）<input className="v6k-field w-full" value={l.ratios.join(',')} onChange={e=>limits({ratios:e.target.value.split(',').map(s=>s.trim())})}/></label>
              {draft.kind==='video' && <><label>可选秒数（逗号分隔）<input className="v6k-field w-full" value={l.duration.values.join(',')} onChange={e=>{const values=e.target.value.split(',').map(Number);limits({duration:{mode:'options',min:Math.min(...values),max:Math.max(...values),step:1,values}});}}/></label>
                <label>默认时长<input className="v6k-field w-full" type="number" value={l.defaultSeconds ?? ''} onChange={e=>limits({defaultSeconds:Number(e.target.value)})}/></label></>}
              {([['maxImages','参考图片上限'],...(draft.kind==='video'?[['maxVideos','参考视频上限'],['maxAudios','参考音频上限']]:[['maxOutputs','输出张数上限']])] as Array<[keyof typeof l,string]>).map(([k,label])=><label key={k}>{label}<input className="v6k-field w-full" type="number" min="0" value={Number(l[k])} onChange={e=>limits({[k]:Number(e.target.value)})}/></label>)}
            </div>
          </>}
            <div className="flex gap-5"><label><input type="checkbox" checked={draft.enabled} onChange={e=>update({enabled:e.target.checked})}/> 开放生成</label><label><input type="checkbox" checked={draft.routeEnabled} onChange={e=>update({routeEnabled:e.target.checked})}/> 开放线路</label></div>
          <div className="flex gap-3"><button type="button" className="v6k-button" onClick={()=>void act(false)} disabled={!option}>预览请求</button>
            <button type="button" className="v6k-button v6k-button-primary" onClick={()=>void act(true)} disabled={!option}>校验并保存</button></div>
        </fieldset>
        {preview && <div><p className="text-sm">本地预览，不会生成或扣费。</p><pre className="overflow-auto rounded-lg border p-4 text-xs">{JSON.stringify(preview,null,2)}</pre></div>}
      </div>
    </div>
  </AdminDrawer>;
}
