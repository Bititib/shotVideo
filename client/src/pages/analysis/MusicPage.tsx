import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useAuthStore } from '../../stores/authStore';

type Task={id:string;model:string;prompt:string;status:string;progress:number;result_url:string|null;cost:number;error:string|null};
type Model={id:string;name:string;cost:number};
const statusName:Record<string,string>={processing:'生成中',review:'正在核实',completed:'已完成',failed:'已失败',resolved:'已人工结算'};
export default function MusicPage() {
  const user=useAuthStore(s=>s.user), storageKey='music-pending-'+user?.id;
  const [models,setModels]=useState<Model[]>([]),[tasks,setTasks]=useState<Task[]>([]),[model,setModel]=useState('');
  const [prompt,setPrompt]=useState(''),[lyrics,setLyrics]=useState(''),[mode,setMode]=useState('song'),[vocal,setVocal]=useState('auto'),[tags,setTags]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const [pending,setPending]=useState<Record<string,unknown>|null>(()=>{try{return JSON.parse(localStorage.getItem(storageKey)||'null');}catch{return null;}});
  const selected=models.find(m=>m.id===model);
  async function refresh(){try{setTasks(await api.get<Task[]>('/music'));}catch(e){setError((e as Error).message);}}
  useEffect(()=>{
    let active=true;
    api.get<Model[]>('/music/models').then(rows=>{if(active){setModels(rows);setModel(rows[0]?.id || '');}}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});
    const poll=()=>api.get<Task[]>('/music').then(rows=>{if(active)setTasks(rows);}).catch(e=>{if(active)setError(e.message);});
    void poll();const timer=setInterval(()=>void poll(),8000);
    return()=>{active=false;clearInterval(timer);};
  },[storageKey]);
  async function submit(){
    setBusy(true);setError('');
    try {
      const body=pending || {model,prompt,lyrics:lyrics || undefined,mode,vocal,tags:tags.split(/[,，]/).map(t=>t.trim()).filter(Boolean),client_request_id:crypto.randomUUID(),expected_cost:selected?.cost};
      // Persist the exact body before any network operation, so timeout/reload retries keep the same key.
      localStorage.setItem(storageKey,JSON.stringify(body));setPending(body);
      await api.post<Task>('/music',body);
      localStorage.removeItem(storageKey);setPending(null);await refresh();
    }catch(e){
      const err=e as Error & {status?:number};setError(err.message);
      if(err.status && [400,401,402,403,404,409].includes(err.status)){localStorage.removeItem(storageKey);setPending(null);}
    }finally{setBusy(false);}
  }
  async function download(task:Task){
    try{const blob=await api.get<Blob>('/music/'+task.id+'/file',{responseType:'blob'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=task.model+'.mp3';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}catch(e){setError((e as Error).message);}
  }
  const field='mt-2 w-full rounded-xl border border-white/10 bg-zinc-900 p-3 text-white';
  return <main className="mx-auto max-w-5xl p-5 sm:p-8 text-zinc-100 space-y-6">
    <header><h1 className="text-2xl font-semibold">音乐生成</h1><p className="mt-2 text-zinc-400">描述风格、氛围和乐器，创作歌曲或纯音乐。关闭页面后仍可回来查看结果。</p></header>
    {error && <p role="alert" className="rounded-xl bg-red-500/10 p-4 text-red-300">{error}</p>}
    {loading ? <p role="status">正在加载模型…</p> : !models.length && <p>暂无可用音乐模型。请管理员添加模型、设置按次售价，并开放音乐功能与模型权限。</p>}
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 space-y-5">
      <fieldset disabled={busy || Boolean(pending)} className="space-y-5">
        <label className="block">模型<select className={field} value={model} onChange={e=>setModel(e.target.value)}><option value="">请选择</option>{models.map(m=><option key={m.id} value={m.id}>{m.name} · ¥{m.cost}/次</option>)}</select></label>
        <label className="block">音乐描述<textarea className={field} rows={3} value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="例如：温暖的民谣，木吉他与钢琴，舒缓的节奏"/><span className="text-xs text-zinc-400">{[...prompt].length}/1000 字</span></label>
        <div className="grid gap-5 sm:grid-cols-2"><label>生成模式<select className={field} value={mode} onChange={e=>setMode(e.target.value)}><option value="song">歌曲</option><option value="instrumental">纯音乐</option></select></label>
          <label>人声<select className={field} value={vocal} onChange={e=>setVocal(e.target.value)}><option value="auto">自动</option><option value="m">男声</option><option value="f">女声</option></select></label></div>
        <label className="block">歌词（可选）<textarea className={field} rows={5} value={lyrics} onChange={e=>setLyrics(e.target.value)}/><span className="text-xs text-zinc-400">{[...lyrics].length}/3000 字；选择纯音乐时，请清空歌词并将人声设为自动。</span></label>
        <label className="block">风格标签（可选）<input className={field} value={tags} onChange={e=>setTags(e.target.value)} placeholder="民谣, 温暖, 吉他"/><span className="text-xs text-zinc-400">最多 6 个，逗号分隔，每个不超过 12 字</span></label>
      </fieldset>
      {pending && <p role="status">上次提交结果尚未确认。继续将使用原请求编号核实，不会重复扣费。</p>}
      <button className="rounded-xl bg-fuchsia-600 px-5 py-3 font-medium disabled:opacity-50" disabled={busy || (!pending && (!selected || !prompt.trim()))} onClick={()=>void submit()}>{busy?'正在提交…':pending?'核实原请求':`生成音乐 · ¥${selected?.cost ?? '—'}`}</button>
    </section>
    <section className="space-y-4"><div className="flex justify-between"><h2 className="text-lg font-semibold">最近的音乐</h2><button onClick={()=>void refresh()}>刷新</button></div>
      {!tasks.length && <p className="text-zinc-400">还没有音乐记录。</p>}
      {tasks.map(task=><article key={task.id} className="rounded-2xl border border-white/10 p-5 space-y-3">
        <div className="flex flex-wrap justify-between gap-2"><strong>{task.model}</strong><span>{statusName[task.status] || task.status}{task.status==='processing'?` · ${task.progress}%`:''} · ¥{task.cost}</span></div>
        <p className="whitespace-pre-wrap break-words">{task.prompt}</p>
        {task.error && <p className="text-sm text-amber-300 break-words">{task.error}</p>}
        {task.result_url && task.status==='completed' && <><audio controls preload="none" src={task.result_url} className="w-full"/><button onClick={()=>void download(task)} className="text-fuchsia-300">下载 MP3</button></>}
      </article>)}
    </section>
  </main>;
}
