import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CanvasDocument, CanvasNode } from './model';
import { referenceLabel, type ReferenceBindings } from './referenceMentions';
import { connectionError } from './videoInputs';

type Props = {
  value: string; onChange: (value: string) => void; placeholder: string;
  references: CanvasNode[]; bindings: ReferenceBindings; document?: CanvasDocument;
  projects?: CanvasDocument[]; target?: CanvasNode; kind: 'image' | 'video' | 'audio';
  onPick: (node: CanvasNode, start: number, end: number) => number | undefined;
};
export default function ReferencePrompt(props: Props) {
  const input = useRef<HTMLTextAreaElement>(null);
  const menuPointer = useRef(false);
  const [query, setQuery] = useState<{start: number; end: number; text: string} | null>(null);
  const [scope, setScope] = useState('upstream');
  const [pickError, setPickError] = useState('');
  const [index, setIndex] = useState(0);
  const [position, setPosition] = useState({left: 12, top: 12, width: 340, maxHeight: 320, transform: 'none'});
  useEffect(() => {
    if (!query) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      menuPointer.current = false;
      if (target !== input.current && !target.closest('.studio-mention-menu')) setQuery(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); setQuery(null); input.current?.focus();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape, true);
    return () => {document.removeEventListener('pointerdown',dismiss);document.removeEventListener('keydown',escape,true);};
  }, [Boolean(query)]);
  const inspect = (value: string, caret: number) => {
    setPickError('');
    const match = /@([^@\s]{0,60})$/.exec(value.slice(0, caret));
    if (!match || props.kind === 'audio') {setQuery(null); return;}
    setQuery({start: caret - match[0].length, end: caret, text: match[1]}); setIndex(0);
    const rect = input.current!.getBoundingClientRect();
    const width = Math.min(380, window.innerWidth - 24);
    const height = Math.min(320, window.innerHeight - 24);
    const above = rect.bottom + height + 8 >= window.innerHeight && rect.top > 160;
    const top = above ? rect.top - 8 : rect.bottom + 8;
    setPosition({left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top, width, maxHeight: Math.max(100,Math.min(height,above ? rect.top-20 : window.innerHeight-top-12)), transform: above ? 'translateY(-100%)' : 'none'});
  };
  const local = props.document?.nodes ?? props.references;
  const candidates = scope === 'upstream' ? props.references : scope === 'projects'
    ? (props.projects ?? []).filter(p => p.id !== props.document?.id).flatMap(p => p.nodes.map(n => ({...n, origin: {projectId:p.id, nodeId:n.id, title:p.title}})))
    : local.map(n => props.document ? {...n, origin: {projectId:props.document.id, nodeId:n.id, title:props.document.title}} : n);
  const nodes = candidates.filter(n => n.id !== props.target?.id && n.kind !== 'text' && n.src && n.job?.status !== 'running'
    && !connectionError(n, {kind:props.kind} as CanvasNode)
    && ((referenceLabel(props.bindings,n.id) ?? '')+' '+n.title+' '+(n.origin?.title ?? '')).toLowerCase().includes(query?.text.toLowerCase() ?? ''));
  const pick = (node: CanvasNode) => {
    if (!query) return;
    const caret = props.onPick(node, query.start, query.end);
    menuPointer.current = false;
    if (caret === undefined) {setPickError(props.value.length > 4980 ? '提示词接近 5000 字上限，请缩短后再插入引用。' : '未能引用该素材，请检查素材状态后重试。'); return;}
    setQuery(null);
    requestAnimationFrame(() => {input.current?.focus(); input.current?.setSelectionRange(caret,caret);});
  };
  return <>
    <textarea ref={input} id="canvas-prompt" className="studio-prompt" value={props.value} maxLength={5000}
      aria-autocomplete="list" aria-controls={query ? 'reference-mention-list' : undefined}
      aria-activedescendant={query && nodes[index] ? `reference-mention-${index}` : undefined}
      onChange={e => {props.onChange(e.target.value); inspect(e.target.value,e.target.selectionStart);}}
      onClick={e => inspect(e.currentTarget.value,e.currentTarget.selectionStart)}
      onBlur={e => {if (!menuPointer.current && !(e.relatedTarget as HTMLElement | null)?.closest('.studio-mention-menu')) setQuery(null);}}
      onKeyDown={e => {
        if (!query || e.nativeEvent.isComposing) return;
        if (['ArrowDown','ArrowUp','Enter','Escape'].includes(e.key)) {e.preventDefault();e.stopPropagation();}
        if (e.key === 'Escape') setQuery(null);
        if (e.key === 'ArrowDown') setIndex(i => (i+1) % Math.max(1,nodes.length));
        if (e.key === 'ArrowUp') setIndex(i => (i-1+nodes.length) % Math.max(1,nodes.length));
        if (e.key === 'Enter' && nodes[index]) pick(nodes[index]);
      }} placeholder={props.placeholder}/>
    {props.kind !== 'audio' && <button className="studio-mention-trigger" onClick={() => {
      const caret=input.current?.selectionStart ?? props.value.length;
      const value=props.value.slice(0,caret)+'@'+props.value.slice(caret);
      if(value.length > 5000) return;
      props.onChange(value);input.current?.focus();inspect(value,caret+1);
      requestAnimationFrame(()=>input.current?.setSelectionRange(caret+1,caret+1));
    }}>@ 引用素材</button>}
    {query && createPortal(<div className="studio-mention-menu" data-canvas-ui data-theme={input.current?.closest('[data-theme]')?.getAttribute('data-theme') || 'mood'} style={{position:'fixed',...position}}
      onPointerDown={e => {menuPointer.current=true; e.stopPropagation();}}
      onPointerUp={e => {menuPointer.current=false; e.stopPropagation();}}
      onPointerCancel={() => {menuPointer.current=false;}}
      onClick={e => e.stopPropagation()}>
      <header>引用素材 <small>↑↓ 选择 · Enter 插入 · Esc 关闭</small></header>
      <nav aria-label="引用来源">{[['upstream','上级节点'],['canvas','本项目 / 画布'],['projects','跨项目']].map(([id,label]) =>
        <button key={id} aria-pressed={scope===id} onClick={()=>{setScope(id);setIndex(0);}}>{label}</button>)}</nav>
      <div role="listbox" id="reference-mention-list" aria-label="可引用素材">{nodes.map((node,i) => <button key={(node.origin?.projectId ?? '')+node.id}
        role="option" id={`reference-mention-${i}`} aria-selected={i===index}
        onMouseDown={e => {if(e.button===0) {e.preventDefault(); pick(node);}}} onClick={()=>pick(node)}>
        {node.kind==='image' ? <img src={node.src} alt=""/> : <span className="studio-mention-media">{node.kind==='video'?'▶':'♫'}</span>}
        <span><strong>{referenceLabel(props.bindings,node.id) ? '@'+referenceLabel(props.bindings,node.id)+' · ' : ''}{node.title}</strong><small>{node.origin?.title || '已连接到当前节点'}</small></span>
      </button>)}</div>
      {!nodes.length && <p>{query.text ? '没有匹配素材，试试其他名称。' : '暂无可用素材，请切换来源或先上传素材。'}</p>}
      {pickError && <p role="alert">{pickError}</p>}
      <footer>选中后自动连接为参考；输入 @ 后可继续搜索名称。</footer>
    </div>, document.body)}
  </>;
}
