import { useRef, useState } from 'react';
import AssetBrowser from './AssetBrowser';
import { connectionError } from './videoInputs';
import type { CanvasDocument, CanvasNode } from './model';

type Props = { document: CanvasDocument; projects: CanvasDocument[]; target?: CanvasNode; mode: 'add' | 'reference' | 'fill'; onClose: () => void; onChoose: (nodes: CanvasNode[]) => void; onFiles: (files: File[]) => void };
export default function AssetPicker({document, projects, target, mode, onClose, onChoose, onFiles}: Props) {
  const [tab,setTab]=useState(mode === 'add' ? 'history' : 'canvas');
  const [search,setSearch]=useState('');
  const input=useRef<HTMLInputElement>(null);
  const usable=(n:CanvasNode)=>n.job?.status !== 'running' && (n.kind === 'text' ? Boolean(n.text.trim()) : Boolean(n.src));
  const eligible=(n:CanvasNode)=>usable(n) && (!target || (mode === 'fill' ? n.kind === target.kind : !connectionError(n,target)));
  const source=tab === 'projects' ? projects.filter(p=>p.id !== document.id) : [document];
  const nodes=source.flatMap(p=>p.nodes.filter(n=>n.id !== target?.id && eligible(n)).map(n=>({...n,origin:{projectId:p.id,nodeId:n.id,title:p.title}}))).filter(n=>(n.title+' '+n.text+' '+n.origin.title).toLowerCase().includes(search.toLowerCase()));
  const action=mode === 'fill' ? '填入节点' : mode === 'reference' ? '引用为参考' : '加入画布';
  return <section className="studio-asset-browser studio-asset-picker" role="dialog" aria-modal="true" aria-label="选择素材"><header><div><h2>{mode === 'fill' ? '选择节点内容' : '引用素材'}</h2><p>{target ? `用于「${target.title}」 · ${mode === 'fill' ? '填入同类型素材，保留节点连线' : '连接素材作为生成参考'}` : '复用画布素材与生成作品'}</p></div><button aria-label="关闭素材选择" onClick={onClose}>✕</button></header>
    <nav className="studio-asset-tabs" aria-label="素材来源">{[['canvas','本项目素材'],['projects','跨项目素材'],['history','生成资产'],['upload','本地上传']].map(([id,label])=><button key={id} aria-pressed={tab===id} onClick={()=>setTab(id)}>{label}</button>)}</nav>
    {tab === 'history' ? <AssetBrowser embedded onClose={onClose} onAdd={items=>onChoose(items.filter(eligible).slice(0,mode === 'fill' ? 1 : undefined))} acceptKind={mode === 'fill' ? target?.kind : undefined} referenceTarget={mode === 'reference' ? target : undefined} actionLabel={action}/> : tab === 'upload' ? <div className="studio-asset-upload"><p>图片、视频和音频都可以直接上传使用。</p><button onClick={()=>input.current?.click()}>选择本地文件</button><small>图片 ≤20 MB · 视频 / 音频 ≤40 MB</small></div> : <><input className="studio-asset-search" aria-label="搜索可引用素材" placeholder="搜索素材名称、内容或项目" value={search} onChange={e=>setSearch(e.target.value)}/><div className="studio-asset-grid">{nodes.map(n=><article key={n.origin.projectId+':'+n.id}>{n.kind === 'image' ? <img src={n.src} alt={n.title} loading="lazy"/> : n.kind === 'audio' ? <audio controls src={n.src} preload="none"/> : n.kind === 'video' ? <video controls src={n.src?.startsWith('data:') ? n.src : '/api/video/play?url='+encodeURIComponent(n.src!)} preload="none"/> : <p>{n.text.slice(0,150)}</p>}<strong>{n.title}</strong><small>{n.origin.title}</small><button onClick={()=>onChoose([n])}>{action}</button></article>)}</div>{!nodes.length && <p>暂无可用素材。可切换其他来源或上传本地文件；空节点和生成中的节点暂不显示。</p>}</>}
    <input hidden ref={input} type="file" aria-label="从素材库上传" multiple={mode !== 'fill'} accept={mode === 'fill' && target?.kind !== 'text' ? target?.kind+'/*' : 'image/*,video/mp4,video/webm,audio/*'} onChange={e=>{onFiles(Array.from(e.target.files || []));e.target.value='';}}/>
  </section>;
}
