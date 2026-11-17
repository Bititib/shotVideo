import React, { useEffect, useState } from 'react';
import { api } from '../api/client';

export type MusicContentScope='history'|'org';
export const historyMusicFile=(id:number,resultId?:string,scope:MusicContentScope='history')=>
  '/music/'+scope+'/'+id+'/file'+(resultId?'?result_id='+encodeURIComponent(resultId):'');
export default function HistoryMusicAudio({id,resultId,scope='history',title='音乐'}:{key?:React.Key;id:number;resultId?:string;scope?:MusicContentScope;title?:string}) {
  const [url,setUrl]=useState(''),[error,setError]=useState('');
  useEffect(()=>{
    const controller=new AbortController();let objectUrl='';
    setUrl('');setError('');
    void api.get<Blob>(historyMusicFile(id,resultId,scope),{responseType:'blob',timeoutMs:60000,signal:controller.signal}).then(blob=>{
      if(controller.signal.aborted)return;
      if(!blob.size)throw new Error('音乐文件为空');
      objectUrl=URL.createObjectURL(blob);setUrl(objectUrl);
    }).catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    return ()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[id,resultId,scope]);
  return <div>{error?<p role="alert">{error}</p>:url?<>
    <audio key={url} controls preload="metadata" src={url} onError={()=>setError('音乐文件无法解码，请检查原订单音频')}/>
    <a href={url} download={'music-'+id+'-'+(resultId||'default')+'.mp3'} aria-label={'下载 '+title}>下载 {title}</a>
  </>:<p role="status">正在读取音乐…</p>}</div>;
}
