import React, { useEffect, useState } from 'react';
import { api } from '../api/client';

export type AdminMusicSource={id:string;label:string;name:string;mime:string;bytes?:number;available:boolean;issue?:string;url:string|null};
export function useAdminMusicSources(id:string|undefined) {
  const [state,setState]=useState<{id?:string;items:AdminMusicSource[];error:string;loading:boolean}>({items:[],error:'',loading:false});
  useEffect(()=>{
    const controller=new AbortController();
    setState({id,items:[],error:'',loading:Boolean(id)});
    if(id)void api.get<AdminMusicSource[]>('/admin/music/'+id+'/sources',{signal:controller.signal})
      .then(items=>{if(!controller.signal.aborted)setState({id,items,error:'',loading:false});})
      .catch(error=>{if(!controller.signal.aborted)setState({id,items:[],error:error.message,loading:false});});
    return ()=>controller.abort();
  },[id]);
  return state.id===id?state:{id,items:[],error:'',loading:Boolean(id)};
}
function SourceAudio({source}:{source:AdminMusicSource;key?:React.Key}) {
  const [url,setUrl]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();let objectUrl='';
    setUrl('');setError('');setLoading(Boolean(source.url));
    if(source.url)void api.get<Blob>(source.url,{responseType:'blob',signal:controller.signal}).then(blob=>{
      if(controller.signal.aborted)return;
      objectUrl=URL.createObjectURL(blob);setUrl(objectUrl);setLoading(false);
    }).catch(error=>{if(!controller.signal.aborted){setError(error.message);setLoading(false);}});
    return ()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[source.url]);
  return <article className="space-y-2 rounded-lg border border-white/10 p-3">
    <p className="text-sm break-all">{source.label} · {source.name}</p>
    {source.bytes!==undefined&&<p className="text-xs text-zinc-500">{(source.bytes/1024/1024).toFixed(2)} MB</p>}
    {!source.available&&<p role="status">{source.issue||'原音频不可用'}</p>}
    {loading&&<p role="status">正在读取原音频…</p>}
    {error&&<p role="alert">{error}</p>}
    {url&&<><audio aria-label={source.name} src={url} controls preload="metadata" className="w-full"/>
      <a href={url} download={source.name} className="text-sm underline">下载原音频</a></>}
  </article>;
}
export default function AdminMusicSources({items,error,loading}:ReturnType<typeof useAdminMusicSources>) {
  return <section className="space-y-3" aria-label="用户上传音频">
    <h4 className="text-sm font-semibold">用户上传音频</h4>
    <p className="text-xs text-zinc-500">本站留存的原始输入，可用于核对上传内容；上游处理状态见音乐订单。</p>
    {loading?<p role="status">正在读取素材记录…</p>:error?<p role="alert">{error}</p>:items.length?
      items.map(source=><SourceAudio key={source.id} source={source}/>):<p>该音乐订单没有上传音频。</p>}
  </section>;
}
