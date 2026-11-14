import { useEffect, useState } from 'react';
import { api } from '../api/client';

type Diagnostic = {
  id:string; operation:string; allowsSupplement?:boolean; state:string; providerStatus?:string; upstreamId?:string; relatedTaskId?:string; submissionId:string; error?:string;
  results:{id:string;upstreamId:string;status:string;error?:string;saved:boolean}[];
};
export default function MusicOrderRecovery({id,onChange}:{id:string;onChange:()=>void}) {
  const [info,setInfo]=useState<Diagnostic|null>(null),[error,setError]=useState(''),[note,setNote]=useState('');
  const [receipt,setReceipt]=useState(''),[busy,setBusy]=useState(false);
  const endpoint='/admin/music/'+id;
  async function load() {
    setError('');
    try{setInfo(await api.get<Diagnostic>(endpoint));}catch(e){setError((e as Error).message);}
  }
  useEffect(()=>{setInfo(null);setNote('');setReceipt('');void load();},[id]);
  const songs=Boolean(info&&['cover','sing','voice_cover'].includes(info.operation));
  const needsId=Boolean(info&&!info.upstreamId);
  async function recover() {
    if(!info)return;
    setBusy(true);setError('');
    try {
      const evidence=note.trim();
      const ids=receipt.split(/[,，\s]+/).filter(Boolean);
      const input=info.allowsSupplement&&ids.length?{evidence,songIds:[...info.results.map(item=>item.upstreamId),...ids]}
        :!needsId?{evidence}:songs?{evidence,songIds:ids}:{evidence,upstreamId:receipt.trim()};
      setInfo(await api.post<Diagnostic>(endpoint+'/recover',input));setNote('');onChange();
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <section className="space-y-3 rounded-xl border border-white/10 p-4 text-sm" aria-label="音乐订单恢复">
    <div className="flex items-center justify-between">
      <h4 className="font-semibold">原音乐订单</h4><button disabled={busy} onClick={()=>void load()}>刷新回执</button>
    </div>
    {error&&<p role="alert" className="text-amber-300">{error}</p>}
    {info&&<>
      <p className="break-all">本站订单 {info.id}</p>
      <p className="break-all">追踪号 {info.submissionId}</p>
      {info.upstreamId&&<p className="break-all">上游编号 {info.upstreamId}</p>}
      {info.relatedTaskId&&<p className="break-all">关联的强化任务 {info.relatedTaskId}</p>}
      {info.providerStatus&&<p>上游状态 {info.providerStatus}</p>}
      {info.error&&<p className="break-words text-amber-300">{info.error}</p>}
      {info.results.map(item=><p className="break-all" key={item.id}>{item.upstreamId} · {item.status}{item.saved?' · 已保存':''}{item.error?' · '+item.error:''}</p>)}
      {['review','accepted','submitting'].includes(info.state)&&(!needsId||info.operation!=='upload')&&<>
        {(needsId||info.allowsSupplement)&&<label className="block">{info.allowsSupplement?'已核实的第二首原歌曲 ID（可选）':songs?'已核实的原歌曲 ID（逗号分隔）':'已核实的原受理编号'}
          <input className="mt-1 w-full rounded border p-2 text-zinc-900" value={receipt} onChange={e=>setReceipt(e.target.value)}/>
        </label>}
        <label className="block">原单核对依据<textarea className="mt-1 w-full rounded border p-2 text-zinc-900" value={note} maxLength={1000} onChange={e=>setNote(e.target.value)}/></label>
        <button className="rounded border px-3 py-2 disabled:opacity-40" disabled={busy||note.trim().length<6||needsId&&!receipt.trim()} onClick={()=>void recover()}>恢复原订单查询</button>
      </>}
    </>}
  </section>;
}
