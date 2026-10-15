import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { canConnect, type CanvasDocument, type CanvasNode } from './model';
import { referenceKinds, referenceLabel, type ReferenceBindings } from './referenceMentions';
import { connectionError } from './videoInputs';

type Props = {
  value: string; onChange: (value: string) => void; placeholder: string;
  references: CanvasNode[]; bindings: ReferenceBindings; document?: CanvasDocument;
  projects?: CanvasDocument[]; target?: CanvasNode; kind: 'image' | 'video' | 'audio';
  onPick: (node: CanvasNode, start: number, end: number) => number | {error: string} | undefined;
};
export default function ReferencePrompt(props: Props) {
  const input = useRef<HTMLTextAreaElement>(null);
  const menuPointer = useRef(false);
  const [query, setQuery] = useState<{start: number; end: number; text: string} | null>(null);
  const [scope, setScope] = useState('canvas');
  const [pickError, setPickError] = useState('');
  const [index, setIndex] = useState(0);
  const [position, setPosition] = useState({left: 12, top: 12, width: 340, maxHeight: 320, transform: 'none'});
  useLayoutEffect(() => {
    if (!query || !input.current) return;
    const textarea = input.current;
    const ancestors: HTMLElement[] = [];
    for (let parent = textarea.parentElement; parent; parent = parent.parentElement) ancestors.push(parent);
    const place = () => {
      const viewport = window.visualViewport;
      const minX = (viewport?.offsetLeft ?? 0) + 12, minY = (viewport?.offsetTop ?? 0) + 12;
      const maxX = minX + (viewport?.width ?? window.innerWidth) - 24;
      const maxY = minY + (viewport?.height ?? window.innerHeight) - 24;
      const rect = textarea.getBoundingClientRect();
      let top = rect.top, bottom = rect.bottom;
      // Anchor to the part of a resized prompt that is visible inside its scroll panel.
      for (const parent of ancestors) {
        const style = getComputedStyle(parent);
        if (!/(auto|scroll|hidden|clip)/.test(style.overflowY || style.overflow)) continue;
        const clip = parent.getBoundingClientRect();
        top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);
      }
      top = Math.max(minY, Math.min(top, maxY));
      bottom = Math.max(top, Math.min(bottom, maxY));
      const above = Math.max(0, top - minY - 8), below = Math.max(0, maxY - bottom - 8);
      const availableHeight = Math.max(1, maxY - minY);
      const preferredHeight = Math.min(320, availableHeight);
      const up = above > below;
      const room = up ? above : below;
      // In a short viewport use the viewport itself, rather than placing an unusable list off screen.
      const cramped = room < Math.min(160, preferredHeight);
      const maxHeight = cramped ? preferredHeight : Math.min(preferredHeight, room);
      const desiredTop = up ? top - 8 - maxHeight : bottom + 8;
      const width = Math.max(1, Math.min(380, maxX - minX));
      setPosition({left: Math.max(minX, Math.min(rect.left, maxX - width)), top: up && !cramped ? top - 8 : Math.max(minY, Math.min(desiredTop, maxY - maxHeight)), width, maxHeight, transform: up && !cramped ? 'translateY(-100%)' : 'none'});
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
    observer?.observe(textarea);
    ancestors.forEach(parent => observer?.observe(parent));
    return () => {
      window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place);
      observer?.disconnect();
    };
  }, [Boolean(query)]);
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
    const match = /[@＠]([^@＠\s]{0,60})$/.exec(value.slice(0, caret));
    if (!match || props.kind === 'audio') {setQuery(null); return;}
    setQuery({start: caret - match[0].length, end: caret, text: match[1]}); setIndex(0);
  };
  const local = props.document?.nodes ?? props.references;
  // Existing media is an input to a NEW generation; only a generator/empty node is the actual target.
  const target = props.target && (props.target.generator || !props.target.src) ? props.target : undefined;
  const seen = new Set<string>();
  const canvasCandidates = [...props.references, ...local].filter(node => {
    if (seen.has(node.id)) return false;
    seen.add(node.id); return true;
  });
  const candidates = scope === 'upstream' ? props.references : scope === 'projects'
    ? (props.projects ?? []).filter(p => p.id !== props.document?.id).flatMap(p => p.nodes.map(n => ({...n, origin: {projectId:p.id, nodeId:n.id, title:p.title}})))
    : canvasCandidates.map(n => props.document ? {...n, origin: {projectId:props.document.id, nodeId:n.id, title:props.document.title}} : n);
  const nodes = candidates.filter(n => (scope === 'projects' || n.id !== target?.id) && n.kind !== 'text' && n.src && n.job?.status !== 'running'
    && !connectionError(n, {...target, kind:props.kind} as CanvasNode)
    && (scope === 'projects' || !target || !props.document || props.references.some(reference => reference.id === n.id) || canConnect(props.document.edges, n.id, target.id))
    && ((referenceLabel(props.bindings,n.id) ?? '')+' '+referenceKinds[n.kind]+' '+n.title+' '+(n.origin?.title ?? '')).toLowerCase().includes(query?.text.toLowerCase() ?? ''));
  const activeIndex = Math.min(index, Math.max(0, nodes.length - 1));
  const pick = (node: CanvasNode) => {
    if (!query) return;
    const caret = props.onPick(node, query.start, query.end);
    menuPointer.current = false;
    if (typeof caret !== 'number') {setPickError(caret?.error || '未能引用该素材，请检查素材状态后重试。'); return;}
    setQuery(null);
    requestAnimationFrame(() => {input.current?.focus(); input.current?.setSelectionRange(caret,caret);});
  };
  return <>
    <textarea ref={input} id="canvas-prompt" className="studio-prompt" value={props.value}
      aria-autocomplete="list" aria-controls={query ? 'reference-mention-list' : undefined}
      aria-activedescendant={query && nodes[activeIndex] ? `reference-mention-${activeIndex}` : undefined}
      onChange={e => {props.onChange(e.target.value); inspect(e.target.value,e.target.selectionStart);}}
      onCompositionEnd={e => inspect(e.currentTarget.value, e.currentTarget.selectionStart)}
      onClick={e => inspect(e.currentTarget.value,e.currentTarget.selectionStart)}
      onBlur={e => {if (!menuPointer.current && !(e.relatedTarget as HTMLElement | null)?.closest('.studio-mention-menu')) setQuery(null);}}
      onKeyDown={e => {
        if (!query || e.nativeEvent.isComposing) return;
        if (['ArrowDown','ArrowUp','Enter','Escape'].includes(e.key)) {e.preventDefault();e.stopPropagation();}
        if (e.key === 'Escape') setQuery(null);
        if (e.key === 'ArrowDown') setIndex((activeIndex+1) % Math.max(1,nodes.length));
        if (e.key === 'ArrowUp') setIndex((activeIndex-1+nodes.length) % Math.max(1,nodes.length));
        if (e.key === 'Enter' && nodes[activeIndex]) pick(nodes[activeIndex]);
      }} placeholder={props.placeholder}/>
    {props.kind !== 'audio' && <button className="studio-mention-trigger" onClick={() => {
      const caret=input.current?.selectionStart ?? props.value.length;
      const value=props.value.slice(0,caret)+'@'+props.value.slice(caret);
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
        role="option" id={`reference-mention-${i}`} aria-selected={i===activeIndex}
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
