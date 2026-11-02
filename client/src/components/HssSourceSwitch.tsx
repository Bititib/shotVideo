import React, { useEffect, useState } from 'react';
import { adminApi } from '../api/admin';

export default function HssSourceSwitch({ modelId = 'hss-2.5-301010' }: { modelId?: string }) {
  const [data,setData] = useState<any>(null), [choice,setChoice] = useState('');
  const [busy,setBusy] = useState(true), [error,setError] = useState(''), [notice,setNotice] = useState('');
  const key = (v:any) => v ? v.source + ':' + v.channelId : '';
  useEffect(() => {
    let live = true;
    setBusy(true); setData(null); setError(''); setNotice(''); setChoice('');
    adminApi.getVideoSources(modelId).then(value => { if(live) { setData(value); setChoice(key(value.current)); } })
      .catch(e => { if(live) setError(e.message); }).finally(() => { if(live) setBusy(false); });
    return () => { live = false; };
  }, [modelId]);
  const option = data?.options.find((v:any) => key(v) === choice);
  const current = data?.options.find((v:any) => key(v) === key(data.current));
  return <section aria-label="生成来源切换" className="rounded-xl border border-white/10 bg-zinc-900 p-3 space-y-2 text-zinc-100">
    <strong>新任务生成来源</strong>
    <p className="text-xs">BB、HSS 可独立选择。仅影响新订单；已有任务继续原渠道。售价和启用状态保持不变。</p>
    {data && <p className="text-xs">当前：{current ? current.label + ' · ' + current.channelName : '未绑定单一来源，请选择'}</p>}
    <div className="flex gap-2">
      <select aria-label="选择生成来源和渠道" className="min-w-0 flex-1 rounded-lg border border-white/10 bg-zinc-800 p-2 text-white" value={choice} disabled={busy || !data} onChange={e=>{setChoice(e.target.value);setNotice('');}}>
        <option value="">请选择来源和渠道</option>
        {data?.options.map((v:any)=><option key={key(v)} value={key(v)} disabled={!v.ready}>{v.label} · {v.channelName}{v.ready?'':'（未启用或未配置密钥）'}</option>)}
      </select>
      <button type="button" className="rounded-lg border border-white/10 px-3 py-2 disabled:opacity-40" disabled={busy || !option?.ready || choice===key(data?.current)} onClick={async()=>{
        setBusy(true);setError('');setNotice('');
        try { const saved=await adminApi.switchVideoSource(modelId,option.source,option.channelId);setData(saved);setChoice(key(saved.current));setNotice('已保存，仅对新订单生效'); }
        catch(e:any) {setError(e.message);}
        finally {setBusy(false);}
      }}>切换来源</button>
    </div>
    {option && <p className="text-xs">{option.upstreamModel} · 720P · {option.limits.duration.min}–{option.limits.duration.max} 秒 · 最多30图、10视频、10音频{option.source==='A'?'，素材合计最多30个':''}。切换前会查询该 Key 的模型权限；不可用时保留原来源。</p>}
    {busy && <p role="status">正在读取或核对来源权限…</p>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
