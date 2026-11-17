import { useEffect, useState } from 'react';
import { api } from '../api/client';

export const historyMusicFile=(id:number)=>'/music/history/'+id+'/file';
export default function HistoryMusicAudio({id}:{id:number}) {
  const [url,setUrl]=useState(''),[error,setError]=useState('');
  useEffect(()=>{
    const controller=new AbortController();let objectUrl='';
    setUrl('');setError('');
    void api.get<Blob>(historyMusicFile(id),{responseType:'blob',timeoutMs:60000,signal:controller.signal}).then(blob=>{
      if(controller.signal.aborted)return;
      objectUrl=URL.createObjectURL(blob);setUrl(objectUrl);
    }).catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    return ()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[id]);
  return error?<p role="alert">{error}</p>:url?<audio controls preload="metadata" src={url}/>:<p role="status">正在读取音乐…</p>;
}
