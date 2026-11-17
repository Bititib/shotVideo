import React, { useEffect, useState } from 'react';
import { api } from '../api/client';

export default function AdminMusicResultAudio({id,resultId,index}:{id:string;resultId:string;index:number;key?:React.Key}) {
  const [url,setUrl]=useState(''),[error,setError]=useState('');
  useEffect(()=>{
    const controller=new AbortController();let objectUrl='';
    setUrl('');setError('');
    void api.get<Blob>('/admin/music/'+id+'/results/'+resultId+'/file',{
      responseType:'blob',timeoutMs:60000,signal:controller.signal,
    }).then(blob=>{
      if(controller.signal.aborted)return;
      if(!blob.size)throw new Error('本站音频文件为空');
      objectUrl=URL.createObjectURL(blob);setUrl(objectUrl);
    }).catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    return ()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[id,resultId]);
  return <div className="space-y-2 rounded border border-white/10 p-3" aria-label={'生成歌曲 '+index}>
    <p>歌曲 {index}</p>
    {error?<p role="alert">{error}</p>:url?<>
      <audio aria-label={'歌曲 '+index+' 试听'} controls preload="metadata" src={url} className="w-full"
        onError={()=>setError('音频已读取，但浏览器无法解码，请下载原文件核查音频格式。')}/>
    </>:<p role="status">正在读取音频和时长…</p>}
    {url&&<a href={url} download={'music-'+id+'-'+index+'.mp3'} className="underline">下载歌曲 {index}</a>}
  </div>;
}
