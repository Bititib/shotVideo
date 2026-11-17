import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import HistoryMusicAudio, { type MusicContentScope } from './HistoryMusicAudio';

type Result={id:string;title?:string;status:string;available:boolean};
export default function MusicContentResults({contentId,scope='history'}:{contentId:number;scope?:MusicContentScope}) {
  const [results,setResults]=useState<Result[]|null>(null),[error,setError]=useState('');
  useEffect(()=>{
    const controller=new AbortController();setResults(null);setError('');
    void api.get<{results:Result[]}>('/music/'+scope+'/'+contentId+'/results',{signal:controller.signal}).then(value=>{
      if(!controller.signal.aborted)setResults(value.results);
    }).catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    return ()=>controller.abort();
  },[contentId,scope]);
  if(error)return <p role="alert">{error}</p>;
  if(!results)return <p role="status">正在读取歌曲列表…</p>;
  if(!results.length)return <p>暂无可播放歌曲，请查看订单状态。</p>;
  return <section aria-label="歌曲结果">{results.map((result,index)=>{
    const title='第 '+(index+1)+' 首'+(result.title?' · '+result.title:'');
    return <div key={result.id}><p>{title}</p>{result.available?
      <HistoryMusicAudio id={contentId} scope={scope} resultId={result.id} title={title}/>:
      <p>音频尚未就绪（{result.status}）</p>}</div>;
  })}</section>;
}
